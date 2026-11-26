'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');

const { createDiscordClient } = require('../server/src/discord-client');
const { createDiscordService } = require('../server/src/discord-service');
const { createApp } = require('../server/src/app');

const BOT_TOKEN = 'super-secret-bot-token-do-not-leak';
const BRIDGE_SECRET = 'super-secret-bridge-key-123456';
const GUILD_ID = '100000000000000001';
const BOT_ID = '100000000000000002';

function createMockDiscordFetch() {
  const channels = [];
  const messages = new Map();
  let seq = 100000000000000000n;
  const state = {
    calls: 0,
    rateLimitFailures: 0,
    serverFailures: 0,
    timeoutFailures: 0,
    failOnMessageIndex: -1
  };

  async function fetchImpl(url, options) {
    state.calls += 1;
    assert.equal(options.headers.Authorization, 'Bot ' + BOT_TOKEN);

    if (state.timeoutFailures > 0) {
      state.timeoutFailures -= 1;
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    }

    if (state.rateLimitFailures > 0) {
      state.rateLimitFailures -= 1;
      return {
        status: 429,
        headers: { get: (k) => (k.toLowerCase() === 'retry-after' ? '0.01' : null) },
        text: async () => JSON.stringify({ message: 'You are being rate limited.', retry_after: 0.01 })
      };
    }

    if (state.serverFailures > 0) {
      state.serverFailures -= 1;
      return {
        status: 503,
        headers: { get: () => null },
        text: async () => JSON.stringify({ message: 'Service Unavailable' })
      };
    }

    const parsed = new URL(url);
    const route = parsed.pathname.replace('/api/v10', '');
    const method = (options.method || 'GET').toUpperCase();
    const body = options.body ? JSON.parse(options.body) : null;

    if (route === '/users/@me') {
      return jsonRes(200, { id: BOT_ID, username: 'MockChatbot' });
    }
    if (route === '/guilds/' + GUILD_ID) {
      return jsonRes(200, { id: GUILD_ID, name: 'Mock Private Server' });
    }
    if (route === '/guilds/' + GUILD_ID + '/channels') {
      if (method === 'GET') {
        return jsonRes(200, channels);
      }
      if (method === 'POST') {
        seq += 1n;
        const created = { ...body, id: String(seq) };
        channels.push(created);
        return jsonRes(200, created);
      }
    }

    const msgMatch = route.match(/^\/channels\/(\d{17,20})\/messages$/);
    if (msgMatch) {
      const channelId = msgMatch[1];
      const list = messages.get(channelId) || [];
      if (method === 'POST') {
        if (state.failOnMessageIndex >= 0 && list.length === state.failOnMessageIndex) {
          return jsonRes(403, { message: 'Missing Permissions' });
        }
        assert.deepEqual(body.allowed_mentions, { parse: [] });
        assert.equal(body.enforce_nonce, true);
        seq += 1n;
        const created = { ...body, id: String(seq), author: { id: BOT_ID } };
        list.push(created);
        messages.set(channelId, list);
        return jsonRes(200, created);
      }
      if (method === 'GET') {
        const before = parsed.searchParams.get('before');
        const filtered = list
          .filter((m) => !before || BigInt(m.id) < BigInt(before))
          .slice()
          .reverse()
          .slice(0, 100);
        return jsonRes(200, filtered);
      }
    }

    return jsonRes(404, { message: 'Unknown route' });
  }

  function jsonRes(status, data) {
    return {
      status,
      headers: { get: () => null },
      text: async () => JSON.stringify(data)
    };
  }

  return { fetchImpl, channels, messages, state };
}

async function withServer(options = {}, fn) {
  const mock = createMockDiscordFetch();
  const client = createDiscordClient({
    botToken: BOT_TOKEN,
    fetchImpl: mock.fetchImpl,
    maxRetries: options.maxRetries ?? 2,
    baseRetryDelayMs: 5,
    sleep: async () => {}
  });
  const service = createDiscordService({ client, guildId: GUILD_ID });
  const app = createApp({
    service,
    bridgeSecret: BRIDGE_SECRET,
    maxBodyBytes: options.maxBodyBytes ?? 262144
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  async function post(path, body, headers = {}) {
    const res = await fetch(baseUrl + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bridge-Secret': BRIDGE_SECRET,
        ...headers
      },
      body: typeof body === 'string' ? body : JSON.stringify(body)
    });
    return { status: res.status, data: await res.json() };
  }

  try {
    await fn({ baseUrl, post, mock });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('bridge enforces secret auth, health check, body limit and input validation', async () => {
  await withServer({ maxBodyBytes: 512 }, async ({ baseUrl, post }) => {
    const health = await fetch(baseUrl + '/health');
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, service: 'discord-bridge' });

    const noSecret = await post('/api/discord/setup', {}, { 'X-Bridge-Secret': '' });
    assert.equal(noSecret.status, 401);

    const badSecret = await post('/api/discord/setup', {}, { 'X-Bridge-Secret': 'wrong-secret' });
    assert.equal(badSecret.status, 401);

    const bearerAuth = await post('/api/discord/setup', {}, {
      'X-Bridge-Secret': '',
      Authorization: 'Bearer ' + BRIDGE_SECRET
    });
    assert.equal(bearerAuth.status, 200);
    assert.equal(bearerAuth.data.ok, true);

    const tooLarge = await post('/api/discord/setup', { pad: 'x'.repeat(1024) });
    assert.equal(tooLarge.status, 413);

    const badJson = await post('/api/discord/channels/ensure', '{bad-json');
    assert.equal(badJson.status, 400);

    const badUuid = await post('/api/discord/channels/ensure', {
      ownerId: 'not-a-uuid',
      chatId: crypto.randomUUID(),
      username: 'alice'
    });
    assert.equal(badUuid.status, 400);
  });
});

test('bridge ensures private categories/channels, recovers marker, saves and paginates messages', async () => {
  await withServer({}, async ({ post, mock }) => {
    const ownerId = crypto.randomUUID();
    const chatId = crypto.randomUUID();

    const setupRes = await post('/api/discord/setup', {});
    assert.equal(setupRes.status, 200);
    assert.equal(setupRes.data.botId, BOT_ID);
    assert.equal(setupRes.data.server, 'Mock Private Server');

    const ensured = await post('/api/discord/channels/ensure', {
      ownerId,
      username: 'alice',
      chatId
    });
    assert.equal(ensured.status, 200);
    assert.equal(mock.channels.length, 2);
    assert.equal(mock.channels[0].type, 4);
    assert.equal(mock.channels[0].permission_overwrites[0].deny, '1024');
    assert.equal(mock.channels[0].permission_overwrites[1].allow, '85008');
    assert.equal(mock.channels[1].topic, `chatbot:${ownerId}:${chatId}`);

    // Calling ensure again recovers the same channel without creating duplicates.
    const recovered = await post('/api/discord/channels/ensure', {
      ownerId,
      username: 'alice',
      chatId
    });
    assert.equal(recovered.status, 200);
    assert.equal(recovered.data.channelId, ensured.data.channelId);
    assert.equal(mock.channels.length, 2);

    // Save 105 messages in batches of 12 and load with pagination.
    const allMessages = [];
    for (let i = 0; i < 105; i += 1) {
      allMessages.push({
        id: crypto.randomUUID(),
        role: i % 2 === 0 ? 'user' : 'assistant',
        text: 'Message #' + i,
        createdAt: 1700000000000 + i
      });
    }

    for (let i = 0; i < allMessages.length; i += 12) {
      const saved = await post('/api/discord/messages/save', {
        ownerId,
        username: 'alice',
        chatId,
        channelId: ensured.data.channelId,
        messages: allMessages.slice(i, i + 12)
      });
      assert.equal(saved.status, 200);
      assert.equal(saved.data.ok, true);
      assert.equal(saved.data.saved.length, Math.min(12, allMessages.length - i));
    }

    // Inject a non-app message into Discord channel to verify it is ignored on load.
    mock.messages.get(ensured.data.channelId).push({
      id: '999999999999999999',
      author: { id: '200000000000000000' },
      embeds: [{ description: 'human message', footer: { text: '{}' } }]
    });

    const page1 = await post('/api/discord/messages/load', {
      channelId: ensured.data.channelId
    });
    assert.equal(page1.status, 200);
    assert.equal(page1.data.messages.length, 99);
    assert.ok(page1.data.before);

    const page2 = await post('/api/discord/messages/load', {
      channelId: ensured.data.channelId,
      before: page1.data.before
    });
    assert.equal(page2.status, 200);
    assert.equal(page2.data.messages.length, 6);
    assert.equal(page2.data.before, null);
    assert.equal(page2.data.messages[0].text, 'Message #0');
  });
});

test('bridge retries 429/5xx/timeouts and sanitizes errors without leaking secrets', async () => {
  await withServer({ maxRetries: 2 }, async ({ post, mock }) => {
    const ownerId = crypto.randomUUID();
    const chatId = crypto.randomUUID();

    // Transient 429 + 503 should succeed after retries.
    mock.state.rateLimitFailures = 1;
    mock.state.serverFailures = 1;
    const okAfterRetry = await post('/api/discord/setup', {});
    assert.equal(okAfterRetry.status, 200);
    assert.equal(okAfterRetry.data.ok, true);

    // Exhausting retries on 429 returns 429 without leaking token or bridge secret.
    mock.state.rateLimitFailures = 3;
    const rateLimited = await post('/api/discord/setup', {});
    assert.equal(rateLimited.status, 429);
    assert.equal(rateLimited.data.ok, false);
    const serialized = JSON.stringify(rateLimited);
    assert.equal(serialized.includes(BOT_TOKEN), false);
    assert.equal(serialized.includes(BRIDGE_SECRET), false);

    // Exhausting retries on timeouts returns 504 without leaking secrets.
    mock.state.timeoutFailures = 3;
    const timedOut = await post('/api/discord/setup', {});
    assert.equal(timedOut.status, 504);
    assert.equal(timedOut.data.ok, false);

    // Partial save: if 2nd message fails with 403, response returns saved[] for the 1st message.
    const ensured = await post('/api/discord/channels/ensure', { ownerId, username: 'alice', chatId });
    assert.equal(ensured.status, 200);
    mock.state.failOnMessageIndex = 1;
    const partial = await post('/api/discord/messages/save', {
      ownerId,
      username: 'alice',
      chatId,
      channelId: ensured.data.channelId,
      messages: [
        { id: crypto.randomUUID(), role: 'user', text: 'first', createdAt: Date.now() },
        { id: crypto.randomUUID(), role: 'assistant', text: 'second', createdAt: Date.now() + 1 }
      ]
    });
    assert.equal(partial.status, 403);
    assert.equal(partial.data.ok, false);
    assert.equal(partial.data.saved.length, 1);
  });
});
