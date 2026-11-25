'use strict';

class DiscordApiError extends Error {
  constructor(message, statusCode = 502, retryable = false) {
    super(message);
    this.name = 'DiscordApiError';
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryDelayMs(response, bodyText, attempt, baseDelayMs) {
  const retryAfterHeader = response.headers && typeof response.headers.get === 'function'
    ? response.headers.get('retry-after')
    : null;
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(Math.ceil(seconds * 1000), 10000);
    }
  }
  if (bodyText) {
    try {
      const parsed = JSON.parse(bodyText);
      if (parsed && Number.isFinite(Number(parsed.retry_after))) {
        return Math.min(Math.ceil(Number(parsed.retry_after) * 1000), 10000);
      }
    } catch (_) {
      // Ignore non-JSON body.
    }
  }
  const exponential = baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.floor(Math.random() * Math.max(50, Math.floor(baseDelayMs / 2)));
  return Math.min(exponential + jitter, 10000);
}

function createDiscordClient(options) {
  const {
    botToken,
    apiBase = 'https://discord.com/api/v10',
    requestTimeoutMs = 15000,
    maxRetries = 3,
    baseRetryDelayMs = 300,
    fetchImpl = globalThis.fetch,
    sleep = defaultSleep
  } = options;

  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required.');
  }

  async function request(method, path, body) {
    const url = apiBase + path;
    const upperMethod = String(method || 'GET').toUpperCase();

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), requestTimeoutMs);

      try {
        const headers = {
          Authorization: 'Bot ' + botToken,
          'User-Agent': 'ChatbotDiscordBridge/1.0'
        };
        const fetchOptions = {
          method: upperMethod,
          headers,
          signal: controller.signal
        };
        if (body !== undefined) {
          headers['Content-Type'] = 'application/json';
          fetchOptions.body = JSON.stringify(body);
        }

        const response = await fetchImpl(url, fetchOptions);
        const status = response.status;
        const text = status === 204 ? '' : await response.text();

        if (status === 429) {
          if (attempt < maxRetries) {
            const delayMs = parseRetryDelayMs(response, text, attempt, baseRetryDelayMs);
            await sleep(delayMs);
            continue;
          }
          throw new DiscordApiError('Discord đang giới hạn tốc độ. Vui lòng đợi rồi thử đồng bộ lại.', 429, true);
        }

        if (status >= 500 && status <= 599) {
          if (attempt < maxRetries) {
            const delayMs = parseRetryDelayMs(response, text, attempt, baseRetryDelayMs);
            await sleep(delayMs);
            continue;
          }
          throw new DiscordApiError(`Discord tạm thời không phản hồi (HTTP ${status}). Vui lòng thử lại.`, 502, true);
        }

        if (status === 401 || status === 403) {
          throw new DiscordApiError('Bot Discord thiếu quyền hoặc token không hợp lệ.', 403, false);
        }
        if (status === 404) {
          throw new DiscordApiError('Không tìm thấy server hoặc kênh Discord đã lưu.', 404, false);
        }
        if (status < 200 || status >= 300) {
          throw new DiscordApiError(`Discord không xử lý được yêu cầu (HTTP ${status}). Kiểm tra giới hạn kênh và cấu hình bot.`, 502, false);
        }

        if (status === 204 || !text) return null;
        try {
          return JSON.parse(text);
        } catch (_) {
          throw new DiscordApiError('Phản hồi từ Discord không hợp lệ.', 502, false);
        }
      } catch (error) {
        if (error instanceof DiscordApiError) {
          throw error;
        }
        const isTimeout = error && error.name === 'AbortError';
        if (attempt < maxRetries) {
          const delayMs = Math.min(baseRetryDelayMs * Math.pow(2, attempt), 10000);
          await sleep(delayMs);
          continue;
        }
        throw new DiscordApiError(
          isTimeout
            ? 'Kết nối tới Discord bị quá thời gian. Vui lòng thử lại.'
            : 'Không thể kết nối tới Discord API. Vui lòng thử lại.',
          isTimeout ? 504 : 502,
          true
        );
      } finally {
        clearTimeout(timer);
      }
    }
  }

  return Object.freeze({ request });
}

module.exports = { createDiscordClient, DiscordApiError };
