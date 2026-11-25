'use strict';

const crypto = require('node:crypto');
const { DiscordApiError } = require('./discord-client');
const { ValidationError } = require('./discord-service');

class PayloadTooLargeError extends Error {
  constructor() {
    super('Request body exceeds allowed limit.');
    this.name = 'PayloadTooLargeError';
    this.statusCode = 413;
  }
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders
  });
  res.end(body);
}

function timingSafeSecretEqual(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !provided || !expected) {
    return false;
  }
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function extractSecret(req) {
  const headerSecret = req.headers['x-bridge-secret'];
  if (typeof headerSecret === 'string' && headerSecret.trim()) {
    return headerSecret.trim();
  }
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  return '';
}

function readJsonBody(req, maxBodyBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    req.on('data', (chunk) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBodyBytes) {
        settled = true;
        reject(new PayloadTooLargeError());
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new ValidationError('Invalid JSON object.'));
          return;
        }
        resolve(parsed);
      } catch (_) {
        reject(new ValidationError('Invalid JSON payload.'));
      }
    });

    req.on('error', () => {
      if (settled) return;
      settled = true;
      reject(new ValidationError('Unable to read request body.'));
    });
  });
}

function createApp({ service, bridgeSecret, maxBodyBytes = 262144 }) {
  return async function handleRequest(req, res) {
    const method = String(req.method || 'GET').toUpperCase();
    const pathname = (req.url || '/').split('?')[0];

    if (method === 'GET' && pathname === '/health') {
      sendJson(res, 200, { ok: true, service: 'discord-bridge' });
      return;
    }

    if (!pathname.startsWith('/api/discord/')) {
      sendJson(res, 404, { ok: false, message: 'Not found.' });
      return;
    }

    if (method !== 'POST') {
      sendJson(res, 405, { ok: false, message: 'Method not allowed.' });
      return;
    }

    const providedSecret = extractSecret(req);
    if (!timingSafeSecretEqual(providedSecret, bridgeSecret)) {
      sendJson(res, 401, { ok: false, message: 'Unauthorized.' });
      return;
    }

    try {
      const body = await readJsonBody(req, maxBodyBytes);
      let result;
      switch (pathname) {
        case '/api/discord/setup':
          result = await service.setup();
          break;
        case '/api/discord/channels/ensure':
          result = await service.ensureChannel(body);
          break;
        case '/api/discord/messages/save':
          result = await service.saveMessages(body);
          break;
        case '/api/discord/messages/load':
          result = await service.loadMessages(body);
          break;
        default:
          sendJson(res, 404, { ok: false, message: 'Not found.' });
          return;
      }
      sendJson(res, 200, result);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        sendJson(res, 413, { ok: false, message: 'Request payload too large.' }, { Connection: 'close' });
        return;
      }
      if (error instanceof ValidationError) {
        sendJson(res, 400, { ok: false, message: error.message });
        return;
      }
      if (error instanceof DiscordApiError) {
        const response = { ok: false, message: error.message };
        if (Array.isArray(error.saved) && error.saved.length > 0) {
          response.saved = error.saved;
        }
        sendJson(res, error.statusCode || 502, response);
        return;
      }
      sendJson(res, 500, { ok: false, message: 'Không thể đồng bộ Discord. Vui lòng thử lại.' });
    }
  };
}

module.exports = { createApp };
