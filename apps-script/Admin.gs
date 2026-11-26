/** Run once after uploading Code.gs and Admin.gs. Existing passwords are preserved. */
function setupAdminSheets() {
  return withAdminLock_(function () {
    setupUsersSheet();
    ensureAdminSchema_();
    const sheet = getUsersSheet_();
    const headers = sheet.getDataRange().getValues()[0];
    userRecords_().forEach(function (user) {
      sheet.getRange(user.row, headers.indexOf('role') + 1).setValue(normalizeRole_(user.role || 'standard'));
    });
    invalidateUsersIndexCache_();
    return { ok: true };
  });
}

function withAdminLock_(operation) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return operation(); } finally { lock.releaseLock(); }
}

function ensureAdminSchema_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getUsersSheet_();
  const headers = sheet.getDataRange().getValues()[0];
  let schemaUpdated = false;
  ['status', 'sessionVersion', 'createdAt', 'lastLogin'].forEach(function (header) {
    if (!headers.includes(header)) {
      headers.push(header);
      sheet.getRange(1, headers.length).setValue(header);
      schemaUpdated = true;
    }
  });
  if (schemaUpdated) invalidateUsersIndexCache_();
  [
    ['Usage', ['requestId', 'timestamp', 'username', 'model', 'inputTokens', 'outputTokens']],
    ['Audit', ['timestamp', 'actor', 'action', 'target']],
    ['DailyQuota', ['username', 'dateKey', 'usedCount', 'updatedAt']],
    ['DiscordAccounts', ['discordId', 'username', 'createdAt']]
  ].forEach(function (definition) {
    let target = spreadsheet.getSheetByName(definition[0]);
    if (!target) target = spreadsheet.insertSheet(definition[0]);
    if (!target.getLastRow()) { target.appendRow(definition[1]); target.setFrozenRows(1); }
  });
}

function userRecords_() {
  const values = getUsersSheet_().getDataRange().getValues();
  const headers = values[0];
  return values.slice(1).map(function (row, index) {
    const user = { row: index + 2 };
    headers.forEach(function (header, column) { user[header] = row[column]; });
    user.username = String(user.username || '');
    return user;
  }).filter(user => user.username);
}

function requireAdmin_(token) {
  const session = getSession_(token, false);
  if (!session.ok || session.user.role !== 'admin') throw new Error('FORBIDDEN');
  return session.user;
}

function adminFailure_(error) {
  if (error.message === 'FORBIDDEN') return { ok: false, code: 'FORBIDDEN', message: 'Phiên hết hạn hoặc bạn không có quyền Admin.' };
  console.error('Admin operation failed:', error.message);
  return { ok: false, message: 'Không thể xử lý yêu cầu. Kiểm tra dữ liệu hoặc thử lại.' };
}

function isNewerTimestamp_(candidate, current) {
  if (!candidate) return false;
  const candidateMs = Date.parse(String(candidate));
  if (Number.isNaN(candidateMs)) return false;
  if (!current) return true;
  const currentMs = Date.parse(String(current));
  return Number.isNaN(currentMs) || candidateMs > currentMs;
}

function flushLastLogins_(entries) {
  if (!entries || entries.length === 0) return 0;
  return withAdminLock_(function () {
    const sheet = getUsersSheet_();
    const values = sheet.getDataRange().getValues();
    if (values.length < 2) return 0;
    const headers = values[0].map(String);
    const userCol = headers.indexOf('username');
    const loginCol = headers.indexOf('lastLogin');
    if (userCol < 0 || loginCol < 0) return 0;

    const rowByUser = Object.create(null);
    for (let i = 1; i < values.length; i += 1) {
      const key = String(values[i][userCol] || '').toLowerCase();
      if (key && rowByUser[key] === undefined) rowByUser[key] = i + 1;
    }

    let updated = 0;
    entries.forEach(function (entry) {
      const rowNumber = rowByUser[String(entry.username || '').toLowerCase()];
      if (!rowNumber) return;
      const existing = values[rowNumber - 1][loginCol];
      if (isNewerTimestamp_(entry.lastLogin, existing)) {
        sheet.getRange(rowNumber, loginCol + 1).setValue(entry.lastLogin);
        updated += 1;
      }
    });
    return updated;
  });
}

function collectPendingLastLogins_(rawUsers, cache) {
  const activeCache = cache || CacheService.getScriptCache();
  const keys = rawUsers.map(user => lastLoginCacheKey_(user.username));
  const cachedMap = cacheGetMany_(activeCache, keys);
  const dirty = [];
  const effectiveByUser = Object.create(null);

  rawUsers.forEach(function (user, idx) {
    const sheetLastLogin = String(user.lastLogin || '');
    const cachedLastLogin = cachedMap[keys[idx]];
    if (cachedLastLogin && isNewerTimestamp_(cachedLastLogin, sheetLastLogin)) {
      effectiveByUser[user.username.toLowerCase()] = String(cachedLastLogin);
      dirty.push({ username: user.username, lastLogin: String(cachedLastLogin) });
    } else {
      effectiveByUser[user.username.toLowerCase()] = sheetLastLogin;
    }
  });

  return { effectiveByUser: effectiveByUser, dirty: dirty };
}

/** Optional periodic trigger target to persist cached lastLogin timestamps to Users. */
function syncLastLogins() {
  const rawUsers = userRecords_();
  const collected = collectPendingLastLogins_(rawUsers);
  return { ok: true, updated: flushLastLogins_(collected.dirty) };
}

function adminDashboard_(token) {
  try {
    const actor = requireAdmin_(token);
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    if (!spreadsheet.getSheetByName('Usage') || !spreadsheet.getSheetByName('Audit')) {
      return { ok: false, message: 'Hãy chạy setupAdminSheets trong Apps Script trước.' };
    }
    const usage = spreadsheet.getSheetByName('Usage').getDataRange().getValues().slice(1);
    const totals = { inputTokens: 0, outputTokens: 0, requests: 0 };
    const byUser = Object.create(null);
    usage.forEach(function (row) {
      const input = Number(row[4]), output = Number(row[5]);
      if (!row[0] || !Number.isSafeInteger(input) || input < 0 || !Number.isSafeInteger(output) || output < 0) return;
      const key = String(row[2]).toLowerCase();
      if (!byUser[key]) byUser[key] = { inputTokens: 0, outputTokens: 0, requests: 0 };
      [totals, byUser[key]].forEach(function (entry) { entry.inputTokens += input; entry.outputTokens += output; entry.requests++; });
    });
    const rawUsers = userRecords_();
    const pendingLogins = collectPendingLastLogins_(rawUsers);
    const users = rawUsers.map(function (user) {
      const lower = user.username.toLowerCase();
      return { username: user.username, role: normalizeRole_(user.role || 'standard'),
        status: user.status === 'disabled' ? 'disabled' : 'active',
        createdAt: String(user.createdAt || ''), lastLogin: pendingLogins.effectiveByUser[lower] || '',
        usage: byUser[lower] || { inputTokens: 0, outputTokens: 0, requests: 0 } };
    });
    if (pendingLogins.dirty.length > 0) {
      flushLastLogins_(pendingLogins.dirty);
    }
    const audit = spreadsheet.getSheetByName('Audit').getDataRange().getValues().slice(1).slice(-50).reverse()
      .map(row => ({ timestamp: String(row[0]), actor: String(row[1]), action: String(row[2]), target: String(row[3]) }));
    return { ok: true, user: actor, users: users, usage: totals, audit: audit, dailyLimit: getDailyRequestLimit_() };
  } catch (error) { return adminFailure_(error); }
}

function getDailyRequestLimit_() {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty('DAILY_REQUEST_LIMIT');
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 10000) return parsed;
  } catch (error) {}
  return 200;
}

function getQuotaTimezone_() {
  try {
    const tz = String(PropertiesService.getScriptProperties().getProperty('QUOTA_TIMEZONE') || '').trim();
    if (tz) return tz;
  } catch (error) {}
  return 'Asia/Ho_Chi_Minh';
}

function getQuotaDateKey_(dateObj) {
  const target = dateObj && typeof dateObj.getTime === 'function' && !Number.isNaN(dateObj.getTime())
    ? dateObj
    : new Date();
  const tz = getQuotaTimezone_();
  try {
    if (typeof Utilities !== 'undefined' && typeof Utilities.formatDate === 'function') {
      return Utilities.formatDate(target, tz, 'yyyy-MM-dd');
    }
  } catch (error) {}
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(target);
}

function quotaStatusCacheKey_(username, dateKey) {
  return 'quota:status:' + dateKey + ':' + sha256Hex_(String(username || '').toLowerCase());
}

function quotaRowCacheKey_(username, dateKey) {
  return 'quota:row:' + dateKey + ':' + sha256Hex_(String(username || '').toLowerCase());
}

function setQuotaCache_(username, dateKey, usedCount, rowNumber, cache) {
  try {
    const activeCache = cache || CacheService.getScriptCache();
    activeCache.put(quotaStatusCacheKey_(username, dateKey), String(Math.max(0, Math.floor(Number(usedCount) || 0))), AUTH_CONFIG.quotaCacheTtlSeconds);
    if (Number.isInteger(rowNumber) && rowNumber >= 2) {
      activeCache.put(quotaRowCacheKey_(username, dateKey), String(rowNumber), AUTH_CONFIG.quotaRowCacheTtlSeconds);
    }
  } catch (error) {}
}

function invalidateQuotaStatusCache_(username, dateKey, cache) {
  try {
    (cache || CacheService.getScriptCache()).remove(quotaStatusCacheKey_(username, dateKey));
  } catch (error) {}
}

function countTodayUsageInSheet_(username, dateKey) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet && spreadsheet.getSheetByName('Usage');
  if (!sheet) return 0;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  // Read only timestamp (col 2) and username (col 3) instead of the full Usage sheet.
  const rows = sheet.getRange(2, 2, lastRow - 1, 2).getValues();
  const target = String(username || '').toLowerCase();
  let count = 0;
  rows.forEach(function (row) {
    if (String(row[1] || '').toLowerCase() !== target) return;
    const ts = new Date(row[0]);
    if (!Number.isNaN(ts.getTime()) && getQuotaDateKey_(ts) === dateKey) count += 1;
  });
  return count;
}

function normalizeSheetDateKey_(cellValue) {
  if (cellValue && typeof cellValue.getTime === 'function' && !Number.isNaN(cellValue.getTime())) {
    return getQuotaDateKey_(cellValue);
  }
  return String(cellValue || '').replace(/^'/, '').trim();
}

function findDailyQuotaRowByHint_(sheet, lastRow, targetLower, dateKey, cachedRowValue) {
  const cachedRow = Number(cachedRowValue);
  if (!Number.isInteger(cachedRow) || cachedRow < 2 || cachedRow > lastRow) return null;
  const rowValues = sheet.getRange(cachedRow, 1, 1, 4).getValues()[0];
  if (String(rowValues[0] || '').toLowerCase() !== targetLower || normalizeSheetDateKey_(rowValues[1]) !== dateKey) {
    return null;
  }
  return {
    row: cachedRow,
    usedCount: Math.max(0, Math.floor(Number(rowValues[2]) || 0))
  };
}

function getOrInitDailyQuotaRow_(username, dateKey, cache) {
  ensureAdminSchema_();
  const activeCache = cache || CacheService.getScriptCache();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('DailyQuota');
  const lastRow = sheet.getLastRow();
  const target = String(username || '').toLowerCase();
  const hinted = findDailyQuotaRowByHint_(sheet, lastRow, target, dateKey, activeCache.get(quotaRowCacheKey_(username, dateKey)));
  if (hinted) {
    return { sheet: sheet, row: hinted.row, usedCount: hinted.usedCount };
  }

  if (lastRow > 1) {
    const rows = sheet.getRange(2, 1, lastRow - 1, 4).getValues();
    for (let i = 0; i < rows.length; i += 1) {
      if (String(rows[i][0] || '').toLowerCase() === target && normalizeSheetDateKey_(rows[i][1]) === dateKey) {
        const rowNumber = i + 2;
        const usedCount = Math.max(0, Math.floor(Number(rows[i][2]) || 0));
        setQuotaCache_(username, dateKey, usedCount, rowNumber, activeCache);
        return {
          sheet: sheet,
          row: rowNumber,
          usedCount: usedCount
        };
      }
    }
  }

  const seededUsed = countTodayUsageInSheet_(username, dateKey);
  sheet.appendRow([sheetText_(username), "'" + dateKey, seededUsed, new Date().toISOString()]);
  const newRow = sheet.getLastRow();
  setQuotaCache_(username, dateKey, seededUsed, newRow, activeCache);
  return {
    sheet: sheet,
    row: newRow,
    usedCount: seededUsed
  };
}

function getUserQuotaStatus_(username, cache) {
  const dailyLimit = getDailyRequestLimit_();
  const dateKey = getQuotaDateKey_();
  const activeCache = cache || CacheService.getScriptCache();
  const statusKey = quotaStatusCacheKey_(username, dateKey);
  const rowKey = quotaRowCacheKey_(username, dateKey);
  const cachedEntries = cacheGetMany_(activeCache, [statusKey, rowKey]);

  const cachedRaw = cachedEntries[statusKey];
  if (cachedRaw !== undefined && cachedRaw !== null && cachedRaw !== '') {
    const cachedUsed = Number(cachedRaw);
    if (Number.isInteger(cachedUsed) && cachedUsed >= 0) {
      return {
        dailyUsed: cachedUsed,
        dailyLimit: dailyLimit,
        remaining: Math.max(0, dailyLimit - cachedUsed),
        dateKey: dateKey
      };
    }
  }

  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet && spreadsheet.getSheetByName('DailyQuota');
  let dailyUsed = 0;
  let matchedRow = 0;
  const lastRow = sheet ? sheet.getLastRow() : 0;
  if (sheet && lastRow > 1) {
    const target = String(username || '').toLowerCase();
    const hinted = findDailyQuotaRowByHint_(sheet, lastRow, target, dateKey, cachedEntries[rowKey]);
    if (hinted) {
      dailyUsed = hinted.usedCount;
      matchedRow = hinted.row;
    } else {
      const rows = sheet.getRange(2, 1, lastRow - 1, 4).getValues();
      let found = false;
      rows.forEach(function (row, idx) {
        if (String(row[0] || '').toLowerCase() === target && normalizeSheetDateKey_(row[1]) === dateKey) {
          found = true;
          matchedRow = idx + 2;
          dailyUsed = Math.max(dailyUsed, Math.floor(Number(row[2]) || 0));
        }
      });
      if (!found) {
        dailyUsed = countTodayUsageInSheet_(username, dateKey);
      }
    }
  } else {
    dailyUsed = countTodayUsageInSheet_(username, dateKey);
  }
  setQuotaCache_(username, dateKey, dailyUsed, matchedRow, activeCache);
  return {
    dailyUsed: dailyUsed,
    dailyLimit: dailyLimit,
    remaining: Math.max(0, dailyLimit - dailyUsed),
    dateKey: dateKey
  };
}

function adminSetDailyLimit_(request) {
  try {
    return withAdminLock_(function () {
      const actor = requireAdmin_(request && request.token);
      ensureAdminSchema_();
      const limit = Number(request && request.dailyLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 10000) {
        return { ok: false, message: 'Giới hạn phải là số nguyên từ 1 đến 10.000.' };
      }
      PropertiesService.getScriptProperties().setProperty('DAILY_REQUEST_LIMIT', String(limit));
      SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Audit').appendRow([
        new Date().toISOString(), sheetText_(actor.username), 'setDailyLimit', String(limit)
      ]);
      return { ok: true, dailyLimit: limit };
    });
  } catch (error) { return adminFailure_(error); }
}

function adminManageUser_(request) {
  try {
    return withAdminLock_(function () {
      const actor = requireAdmin_(request.token);
      ensureAdminSchema_();
      const username = normalizeUsername_(request.username);
      const operation = request.operation;
      const users = userRecords_();
      const target = users.find(user => user.username.toLowerCase() === username.toLowerCase());
      if (operation === 'create') {
        if (target) return { ok: false, message: 'Tên đăng nhập đã tồn tại.' };
        if (typeof request.password !== 'string' || request.password.length < 8) return { ok: false, message: 'Mật khẩu cần ít nhất 8 ký tự.' };
        createUserRecord_(username, request.password, request.role);
      } else if (operation === 'delete') {
        if (!target) return { ok: false, message: 'Không tìm thấy tài khoản.' };
        if (target.username.toLowerCase() === actor.username.toLowerCase()) {
          return { ok: false, message: 'Bạn không thể xoá tài khoản đang đăng nhập.' };
        }
        if (request.confirmUsername !== target.username) {
          return { ok: false, message: 'Nhập chính xác tên tài khoản để xác nhận xoá.' };
        }
        if (normalizeRole_(target.role || 'standard') === 'admin' &&
            !users.some(user => user.row !== target.row && normalizeRole_(user.role || 'standard') === 'admin' && user.status !== 'disabled')) {
          return { ok: false, message: 'Phải giữ ít nhất một Admin đang hoạt động.' };
        }
        getUsersSheet_().deleteRow(target.row);
        invalidateUsersIndexCache_();
      } else {
        if (!target) return { ok: false, message: 'Không tìm thấy tài khoản.' };
        const updates = {};
        if (operation === 'update') {
          updates.role = normalizeRole_(request.role);
          if (!['active', 'disabled'].includes(request.status)) return { ok: false, message: 'Trạng thái không hợp lệ.' };
          updates.status = request.status;
          if (target.username.toLowerCase() === actor.username.toLowerCase() && (updates.role !== 'admin' || updates.status !== 'active')) {
            return { ok: false, message: 'Bạn không thể tự khoá hoặc hạ quyền Admin của mình.' };
          }
          if (normalizeRole_(target.role || 'standard') === 'admin' && (updates.role !== 'admin' || updates.status !== 'active') &&
              !users.some(user => user.row !== target.row && normalizeRole_(user.role || 'standard') === 'admin' && user.status !== 'disabled')) {
            return { ok: false, message: 'Phải giữ ít nhất một Admin đang hoạt động.' };
          }
        } else if (operation === 'resetPassword') {
          validatePassword_(request.password);
          if (request.password.length < 8) return { ok: false, message: 'Mật khẩu cần ít nhất 8 ký tự.' };
          const salt = randomHex_(16);
          updates.password = 'v1$' + AUTH_CONFIG.passwordIterations + '$' + salt + '$' + hashPassword_(request.password, salt);
        } else if (operation !== 'revokeSessions') {
          return { ok: false, message: 'Thao tác không hợp lệ.' };
        }
        // Rotating this value invalidates every existing session, including role/password changes.
        updates.sessionVersion = Utilities.getUuid();
        const sheet = getUsersSheet_();
        const headers = sheet.getDataRange().getValues()[0];
        const row = sheet.getRange(target.row, 1, 1, headers.length).getValues()[0];
        Object.keys(updates).forEach(key => { row[headers.indexOf(key)] = updates[key]; });
        sheet.getRange(target.row, 1, 1, headers.length).setValues([row]);
      }
      SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Audit').appendRow([
        new Date().toISOString(), sheetText_(actor.username), operation, sheetText_(username)
      ]);
      return { ok: true, sessionRevoked: operation !== 'create' && actor.username.toLowerCase() === username.toLowerCase() };
    });
  } catch (error) { return adminFailure_(error); }
}

function sheetText_(value) {
  const text = String(value);
  return /^[=+@-]/.test(text) ? "'" + text : text;
}

function recordAiUsageUnlocked_(username, model, inputTokens, outputTokens, requestId) {
  if (![inputTokens, outputTokens].every(value => Number.isSafeInteger(value) && value >= 0) ||
      typeof requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/.test(requestId) ||
      typeof model !== 'string' || !model || model.length > 128) throw new Error('Invalid usage.');
  ensureAdminSchema_();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Usage');
  const id = sheetText_(requestId);
  if (sheet.getDataRange().getValues().slice(1).some(row => String(row[0]) === id)) return;
  const normalizedName = normalizeUsername_(username);
  sheet.appendRow([id, new Date().toISOString(), sheetText_(normalizedName), sheetText_(model), inputTokens, outputTokens]);
  invalidateQuotaStatusCache_(normalizedName, getQuotaDateKey_());
}

/** Internal only: call after a real AI provider response. Never accept token counts from the browser.
 * requestId must be the provider's unique request ID; repeated IDs are ignored.
 */
function recordAiUsage_(username, model, inputTokens, outputTokens, requestId) {
  return withAdminLock_(function () {
    return recordAiUsageUnlocked_(username, model, inputTokens, outputTokens, requestId);
  });
}
