const OPENROUTER_SYSTEM_PROMPT = [
  "Always reply in the exact same language as the user's message. If the user writes in Vietnamese, you must reply in clear, natural Vietnamese unless they explicitly ask for another language.",
  "Format every response using clean, well-structured Markdown so it is easy to scan:",
  "- Use ## and ### headings to separate sections.",
  "- Use **bold** for key terms, labels, and important points, and *italics* for brief notes.",
  "- Use bullet lists (- ) or numbered lists (1. ) instead of plain walls of text.",
  "- Use Markdown tables (| Col | Col |) when comparing options or summarizing structured data.",
  "- Use blockquotes (> ) for key takeaways, warnings, or tips, and fenced code blocks (```) for code or commands."
].join('\n');

const OPENROUTER_MODELS = {
  'auto': { id: 'openrouter/free', label: 'Auto (Free)', free: true },
  'gpt-oss-120b': { id: 'openai/gpt-oss-120b', label: 'gpt-oss-120b', free: false },
  'gemini-flash-lite': { id: 'google/gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', free: false },
  'deepseek-flash': { id: 'deepseek/deepseek-v4-flash-0731', label: 'DeepSeek V4 Flash 0731', free: false }
};

function quotaIdempotencyKey_(username, clientRequestId) {
  if (typeof clientRequestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(clientRequestId)) {
    return '';
  }
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(username || '').toLowerCase() + ':' + clientRequestId
  );
  return 'ai:idemp:' + bytesToHex_(digest);
}

function quotaInFlightKey_(username, dateKey) {
  return 'ai:inflight:' + dateKey + ':' + String(username || '').toLowerCase();
}

function readInFlightCount_(cache, key) {
  const n = Number(cache.get(key));
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function aiChat_(request) {
  let reserved = false;
  let reservedReleased = false;
  let reservedUsername = '';
  let reservedDateKey = '';
  let idempKey = '';

  function rollbackReservation_() {
    if (!reserved || reservedReleased) return;
    reservedReleased = true;
    return withAdminLock_(function () {
      const cache = CacheService.getScriptCache();
      const inFlightKey = quotaInFlightKey_(reservedUsername, reservedDateKey);
      const nextInFlight = Math.max(0, readInFlightCount_(cache, inFlightKey) - 1);
      if (nextInFlight > 0) cache.put(inFlightKey, String(nextInFlight), 75);
      else cache.remove(inFlightKey);
      if (idempKey) cache.remove(idempKey);

      const rowInfo = getOrInitDailyQuotaRow_(reservedUsername, reservedDateKey);
      const limit = getDailyRequestLimit_();
      return {
        dailyUsed: rowInfo.usedCount,
        dailyLimit: limit,
        remaining: Math.max(0, limit - rowInfo.usedCount)
      };
    });
  }

  try {
    const session = getSession(request && request.token);
    if (!session.ok || !session.user) {
      return { ok: false, code: 'UNAUTHORIZED', message: 'Phiên đăng nhập hết hạn. Vui lòng đăng nhập lại.' };
    }

    const modelKey = String((request && request.modelKey) || '');
    const model = OPENROUTER_MODELS[modelKey];
    if (!model) {
      return { ok: false, code: 'INVALID_MODEL', message: 'Model AI không hợp lệ.' };
    }
    if (!model.free) {
      return { ok: false, code: 'MODEL_LOCKED', message: 'Model trả phí đang bị khoá. Chỉ có thể sử dụng chế độ Auto miễn phí.' };
    }

    const rawMessages = request && request.messages;
    if (!Array.isArray(rawMessages) || rawMessages.length === 0 || rawMessages.length > 20) {
      return { ok: false, code: 'INVALID_MESSAGES', message: 'Danh sách tin nhắn không hợp lệ.' };
    }
    const messages = rawMessages.map(function (msg) {
      if (!msg || typeof msg !== 'object' || !['user', 'assistant'].includes(msg.role) ||
          typeof msg.content !== 'string' || !msg.content.trim() || msg.content.length > 4000) {
        throw new Error('Tin nhắn không hợp lệ.');
      }
      return { role: msg.role, content: msg.content };
    });

    const apiKey = String(PropertiesService.getScriptProperties().getProperty('OPENROUTER_API_KEY') || '').trim();
    if (!apiKey) {
      return { ok: false, code: 'MISSING_API_KEY', message: 'Chưa cấu hình OPENROUTER_API_KEY trong Script Properties.' };
    }

    reservedUsername = session.user.username;
    idempKey = quotaIdempotencyKey_(reservedUsername, request && request.clientRequestId);

    const reserveOutcome = withAdminLock_(function () {
      const cache = CacheService.getScriptCache();
      if (idempKey) {
        const cachedRaw = cache.get(idempKey);
        if (cachedRaw) {
          try {
            const cached = JSON.parse(cachedRaw);
            if (cached && cached.status === 'DONE' && cached.response) {
              return { type: 'CACHED', response: cached.response };
            }
            if (cached && cached.status === 'PENDING') {
              return { type: 'PENDING' };
            }
          } catch (e) {}
        }
      }

      reservedDateKey = getQuotaDateKey_();
      const dailyLimit = getDailyRequestLimit_();
      const rowInfo = getOrInitDailyQuotaRow_(reservedUsername, reservedDateKey);
      const inFlightKey = quotaInFlightKey_(reservedUsername, reservedDateKey);
      const inFlight = readInFlightCount_(cache, inFlightKey);

      if (rowInfo.usedCount + inFlight >= dailyLimit) {
        return {
          type: 'QUOTA_EXCEEDED',
          dailyUsed: rowInfo.usedCount,
          dailyLimit: dailyLimit,
          remaining: Math.max(0, dailyLimit - rowInfo.usedCount)
        };
      }

      cache.put(inFlightKey, String(inFlight + 1), 75);
      if (idempKey) {
        cache.put(idempKey, JSON.stringify({ status: 'PENDING' }), 75);
      }
      return { type: 'RESERVED', dailyLimit: dailyLimit };
    });

    if (reserveOutcome.type === 'CACHED') {
      return reserveOutcome.response;
    }
    if (reserveOutcome.type === 'PENDING') {
      return { ok: false, code: 'DUPLICATE_REQUEST', message: 'Yêu cầu đang được xử lý. Vui lòng đợi.' };
    }
    if (reserveOutcome.type === 'QUOTA_EXCEEDED') {
      return {
        ok: false,
        code: 'QUOTA_EXCEEDED',
        message: 'Bạn đã dùng hết ' + reserveOutcome.dailyLimit + ' lượt hỏi trong ngày hôm nay. Vui lòng quay lại vào ngày mai.',
        dailyUsed: reserveOutcome.dailyUsed,
        dailyLimit: reserveOutcome.dailyLimit,
        remaining: reserveOutcome.remaining
      };
    }

    reserved = true;

    const candidates = [
      model,
      { id: 'google/gemma-4-26b-a4b-it:free', label: 'Gemma 4 26B A4B', free: true },
      { id: 'google/gemma-4-31b-it:free', label: 'Gemma 4 31B', free: true }
    ];

    let response = null;
    let status = 0;
    let data = null;
    let usedModel = model;

    for (let c = 0; c < candidates.length; c += 1) {
      usedModel = candidates[c];
      const retryDelays = c === 0 ? [1200] : [];

      for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
        response = UrlFetchApp.fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'post',
          contentType: 'application/json',
          headers: {
            Authorization: 'Bearer ' + apiKey,
            'X-Title': 'AI Chatbot'
          },
          payload: JSON.stringify({
            model: usedModel.id,
            messages: [{ role: 'system', content: OPENROUTER_SYSTEM_PROMPT }].concat(messages)
          }),
          muteHttpExceptions: true
        });

        status = response.getResponseCode();
        try {
          data = JSON.parse(response.getContentText() || '{}');
        } catch (e) {
          data = null;
        }

        if ((status === 429 || status === 502 || status === 503 || status === 504) && attempt < retryDelays.length) {
          if (typeof Utilities !== 'undefined' && typeof Utilities.sleep === 'function') {
            Utilities.sleep(retryDelays[attempt]);
          }
          continue;
        }
        break;
      }

      if (status >= 200 && status < 300 && data && data.choices && data.choices[0] && data.choices[0].message) {
        break;
      }
      if (status !== 429 && status !== 502 && status !== 503 && status !== 504 && status !== 404) {
        break;
      }
    }

    const metaRaw = data && data.error && data.error.metadata && typeof data.error.metadata.raw === 'string'
      ? data.error.metadata.raw
      : '';
    const rawDetail = metaRaw || (data && data.error && typeof data.error.message === 'string' ? data.error.message : '');
    const safeDetail = rawDetail && !rawDetail.includes(apiKey) && !/sk-or-/i.test(rawDetail)
      ? rawDetail.slice(0, 180)
      : '';

    if (status === 401 || status === 403) {
      const q = rollbackReservation_();
      return Object.assign({ ok: false, code: 'AI_AUTH_ERROR', message: 'OPENROUTER_API_KEY không hợp lệ hoặc bị từ chối.' }, q);
    }
    if (status === 402) {
      const q = rollbackReservation_();
      return Object.assign({ ok: false, code: 'AI_PAYMENT_REQUIRED', message: 'Tài khoản OpenRouter không đủ số dư.' }, q);
    }
    if (status === 429) {
      const q = rollbackReservation_();
      return Object.assign({
        ok: false,
        code: 'AI_RATE_LIMITED',
        message: 'OpenRouter đang giới hạn tốc độ (429) trên tất cả model miễn phí. Vui lòng đợi vài giây rồi thử lại.' + (safeDetail ? ' (' + safeDetail + ')' : '')
      }, q);
    }
    if (status < 200 || status >= 300 || !data || !data.choices || !data.choices[0] || !data.choices[0].message) {
      const q = rollbackReservation_();
      return Object.assign({
        ok: false,
        code: 'AI_UPSTREAM_ERROR',
        message: 'OpenRouter không xử lý được yêu cầu (HTTP ' + status + ').' + (safeDetail ? ' ' + safeDetail : '')
      }, q);
    }

    const reply = String(data.choices[0].message.content || '').trim() || '(Bot không trả về nội dung.)';
    const inputTokens = Math.max(0, Math.floor(Number(data.usage && data.usage.prompt_tokens) || 0));
    const outputTokens = Math.max(0, Math.floor(Number(data.usage && data.usage.completion_tokens) || 0));
    const rawId = typeof data.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/.test(data.id)
      ? data.id
      : ('or-' + Utilities.getUuid());
    const actualModelId = typeof data.model === 'string' && data.model.trim() ? data.model.trim() : usedModel.id;

    reservedReleased = true;
    const finalized = withAdminLock_(function () {
      const cache = CacheService.getScriptCache();
      const inFlightKey = quotaInFlightKey_(reservedUsername, reservedDateKey);
      const nextInFlight = Math.max(0, readInFlightCount_(cache, inFlightKey) - 1);
      if (nextInFlight > 0) cache.put(inFlightKey, String(nextInFlight), 75);
      else cache.remove(inFlightKey);

      const rowInfo = getOrInitDailyQuotaRow_(reservedUsername, reservedDateKey);
      const newUsed = rowInfo.usedCount + 1;
      const limit = getDailyRequestLimit_();
      rowInfo.sheet.getRange(rowInfo.row, 3, 1, 2).setValues([[newUsed, new Date().toISOString()]]);
      recordAiUsageUnlocked_(reservedUsername, actualModelId, inputTokens, outputTokens, rawId);
      const res = {
        ok: true,
        reply: reply,
        model: actualModelId,
        modelId: actualModelId,
        usage: { inputTokens: inputTokens, outputTokens: outputTokens },
        dailyUsed: newUsed,
        dailyLimit: limit,
        remaining: Math.max(0, limit - newUsed)
      };
      if (idempKey) {
        cache.put(idempKey, JSON.stringify({ status: 'DONE', response: res }), 600);
      }
      return res;
    });

    return finalized;
  } catch (error) {
    const q = rollbackReservation_();
    const message = error && error.message ? error.message : '';
    return Object.assign({
      ok: false,
      code: 'AI_ERROR',
      message: /^(Tin nhắn|Model|Phiên|Chưa cấu hình|OpenRouter|Bạn đã dùng hết)/.test(message)
        ? message
        : 'Không thể kết nối OpenRouter từ máy chủ. Vui lòng thử lại.'
    }, q || {});
  }
}
