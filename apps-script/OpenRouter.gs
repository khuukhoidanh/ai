const OPENROUTER_SYSTEM_PROMPT = [
  "Always reply in the exact same language as the user's message. If the user writes in Vietnamese, you must reply in 100% clear, natural Vietnamese (standard English technical terms or code identifiers are fine) and NEVER insert Chinese/Hanzi or other CJK characters unless the user explicitly asks for another language or translation.",
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

const QUOTA_RESERVATION_TTL_MS = 360000;

function normalizeClientRequestId_(clientRequestId) {
  if (typeof clientRequestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(clientRequestId)) {
    return '';
  }
  return clientRequestId;
}

function quotaIdempotencyKey_(username, clientRequestId) {
  const validId = normalizeClientRequestId_(clientRequestId);
  if (!validId) return '';
  return 'ai:idemp:' + sha256Hex_(String(username || '').toLowerCase() + ':' + validId);
}

function getQuotaReservationsSheet_() {
  ensureAdminSchema_();
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName('QuotaReservations');
}

function findReservationRow_(sheet, reservationId) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const rows = sheet.getRange(2, 1, lastRow - 1, 8).getValues();
  for (let i = 0; i < rows.length; i += 1) {
    if (String(rows[i][0] || '') === reservationId) {
      return { rowNumber: i + 2, values: rows[i] };
    }
  }
  return null;
}

function pruneOldQuotaReservations_(sheet, currentDateKey, nowMs) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 51) return;
  const rows = sheet.getRange(2, 1, lastRow - 1, 8).getValues();
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const status = String(rows[i][4] || '');
    const rowDateKey = normalizeSheetDateKey_(rows[i][2]);
    const expiresAtMs = Date.parse(String(rows[i][5] || ''));
    const isOldClosed = status !== 'PENDING' && rowDateKey !== currentDateKey;
    const isLongExpired = status === 'EXPIRED' && !Number.isNaN(expiresAtMs) && (nowMs - expiresAtMs > 3600000);
    if (isOldClosed || isLongExpired) {
      sheet.deleteRow(i + 2);
    }
  }
}

function aiChat_(request) {
  let reserved = false;
  let reservedReleased = false;
  let reservedUsername = '';
  let reservedDateKey = '';
  let reservationId = '';
  let idempKey = '';
  let validClientRequestId = '';

  function rollbackReservation_() {
    if (!reserved || reservedReleased) return;
    reservedReleased = true;
    return withAdminLock_(function () {
      const cache = CacheService.getScriptCache();
      if (reservationId) {
        const resSheet = getQuotaReservationsSheet_();
        const found = findReservationRow_(resSheet, reservationId);
        if (found && String(found.values[4] || '') === 'PENDING') {
          resSheet.getRange(found.rowNumber, 5).setValue('ROLLED_BACK');
        }
      }
      if (idempKey) cache.remove(idempKey);

      const rowInfo = getOrInitDailyQuotaRow_(reservedUsername, reservedDateKey, cache);
      setQuotaCache_(reservedUsername, reservedDateKey, rowInfo.usedCount, rowInfo.row, cache);
      const limit = getDailyRequestLimit_();
      return {
        dailyUsed: rowInfo.usedCount,
        dailyLimit: limit,
        remaining: Math.max(0, limit - rowInfo.usedCount)
      };
    });
  }

  try {
    const session = getSession_(request && request.token, false);
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
    validClientRequestId = normalizeClientRequestId_(request && request.clientRequestId);
    idempKey = quotaIdempotencyKey_(reservedUsername, validClientRequestId);

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
          } catch (e) {}
        }
      }

      reservedDateKey = getQuotaDateKey_();
      const dailyLimit = getDailyRequestLimit_();
      const rowInfo = getOrInitDailyQuotaRow_(reservedUsername, reservedDateKey, cache);
      const resSheet = getQuotaReservationsSheet_();
      const nowMs = Date.now();
      const targetUser = reservedUsername.toLowerCase();
      let activeInFlight = 0;

      const lastResRow = resSheet.getLastRow();
      if (lastResRow > 1) {
        const resRows = resSheet.getRange(2, 1, lastResRow - 1, 8).getValues();
        for (let i = 0; i < resRows.length; i += 1) {
          const row = resRows[i];
          const rowUser = String(row[1] || '').toLowerCase();
          const rowDateKey = normalizeSheetDateKey_(row[2]);
          const rowReqId = normalizeSheetDateKey_(row[3]);
          let rowStatus = String(row[4] || '');
          const expiresAtMs = Date.parse(String(row[5] || ''));

          if (rowStatus === 'PENDING' && !Number.isNaN(expiresAtMs) && expiresAtMs <= nowMs) {
            rowStatus = 'EXPIRED';
            resSheet.getRange(i + 2, 5).setValue('EXPIRED');
          }

          if (rowUser !== targetUser) continue;

          if (validClientRequestId && rowReqId === validClientRequestId) {
            if (rowStatus === 'DONE' && row[7]) {
              try {
                const storedResponse = JSON.parse(String(row[7]));
                if (storedResponse && storedResponse.ok) {
                  if (idempKey) cache.put(idempKey, JSON.stringify({ status: 'DONE', response: storedResponse }), 600);
                  return { type: 'CACHED', response: storedResponse };
                }
              } catch (e) {}
            }
            if (rowStatus === 'PENDING') {
              return { type: 'PENDING' };
            }
          }

          if (rowStatus === 'PENDING' && rowDateKey === reservedDateKey) {
            activeInFlight += 1;
          }
        }
      }

      if (rowInfo.usedCount + activeInFlight >= dailyLimit) {
        return {
          type: 'QUOTA_EXCEEDED',
          dailyUsed: rowInfo.usedCount,
          dailyLimit: dailyLimit,
          remaining: Math.max(0, dailyLimit - rowInfo.usedCount)
        };
      }

      pruneOldQuotaReservations_(resSheet, reservedDateKey, nowMs);
      const newReservationId = Utilities.getUuid();
      resSheet.appendRow([
        newReservationId,
        sheetText_(reservedUsername),
        "'" + reservedDateKey,
        validClientRequestId ? sheetText_(validClientRequestId) : '',
        'PENDING',
        new Date(nowMs + QUOTA_RESERVATION_TTL_MS).toISOString(),
        new Date(nowMs).toISOString(),
        ''
      ]);
      return { type: 'RESERVED', reservationId: newReservationId, dailyLimit: dailyLimit };
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
    reservationId = reserveOutcome.reservationId;

    const candidates = [
      model,
      { id: 'google/gemma-4-26b-a4b-it:free', label: 'Gemma 4 26B A4B', free: true },
      { id: 'google/gemma-4-31b-it:free', label: 'Gemma 4 31B', free: true }
    ];

    const userRequestedCjk = messages.some(function (msg) {
      if (msg.role !== 'user') return false;
      if (/[\u4E00-\u9FFF\u3400-\u4DBF\u3040-\u30FF\uAC00-\uD7AF]/.test(msg.content)) return true;
      return /\b(tiếng\s*(trung|hoa|nhật|hàn)|chữ\s*hán|hán\s*tự|chinese|mandarin|cantonese|japanese|korean|kanji|hanzi)\b/i.test(msg.content);
    });

    let response = null;
    let status = 0;
    let data = null;
    let usedModel = model;
    let fallbackSuccess = null;

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
        const candidateText = String(data.choices[0].message.content || '');
        const hasUnexpectedCjk = !userRequestedCjk && /[\u4E00-\u9FFF\u3400-\u4DBF]/.test(candidateText);
        if (hasUnexpectedCjk && c < candidates.length - 1) {
          fallbackSuccess = { status: status, data: data, usedModel: usedModel };
          continue;
        }
        fallbackSuccess = null;
        break;
      }
      if (status !== 429 && status !== 502 && status !== 503 && status !== 504 && status !== 404) {
        break;
      }
    }

    if (fallbackSuccess && (!(status >= 200 && status < 300) || !data || !data.choices || !data.choices[0] || !data.choices[0].message)) {
      status = fallbackSuccess.status;
      data = fallbackSuccess.data;
      usedModel = fallbackSuccess.usedModel;
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
      const rowInfo = getOrInitDailyQuotaRow_(reservedUsername, reservedDateKey, cache);
      const newUsed = rowInfo.usedCount + 1;
      const limit = getDailyRequestLimit_();
      rowInfo.sheet.getRange(rowInfo.row, 3, 1, 2).setValues([[newUsed, new Date().toISOString()]]);
      recordAiUsageUnlocked_(reservedUsername, actualModelId, inputTokens, outputTokens, rawId);
      setQuotaCache_(reservedUsername, reservedDateKey, newUsed, rowInfo.row, cache);
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
      if (reservationId) {
        const resSheet = getQuotaReservationsSheet_();
        const found = findReservationRow_(resSheet, reservationId);
        if (found) {
          const serialized = JSON.stringify(res);
          resSheet.getRange(found.rowNumber, 5).setValue('DONE');
          if (serialized.length <= 45000) {
            resSheet.getRange(found.rowNumber, 8).setValue(serialized);
          }
        }
      }
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
