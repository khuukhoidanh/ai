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
  ['status', 'sessionVersion', 'createdAt', 'lastLogin'].forEach(function (header) {
    if (!headers.includes(header)) {
      headers.push(header);
      sheet.getRange(1, headers.length).setValue(header);
    }
  });
  [
    ['Usage', ['requestId', 'timestamp', 'username', 'model', 'inputTokens', 'outputTokens']],
    ['Audit', ['timestamp', 'actor', 'action', 'target']],
    ['DailyQuota', ['username', 'dateKey', 'usedCount', 'updatedAt']]
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
  const session = getSession(token);
  if (!session.ok || session.user.role !== 'admin') throw new Error('FORBIDDEN');
  return session.user;
}

function adminFailure_(error) {
  if (error.message === 'FORBIDDEN') return { ok: false, code: 'FORBIDDEN', message: 'Phiên hết hạn hoặc bạn không có quyền Admin.' };
  console.error('Admin operation failed:', error.message);
  return { ok: false, message: 'Không thể xử lý yêu cầu. Kiểm tra dữ liệu hoặc thử lại.' };
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
    const users = userRecords_().map(function (user) {
      return { username: user.username, role: normalizeRole_(user.role || 'standard'),
        status: user.status === 'disabled' ? 'disabled' : 'active',
        createdAt: String(user.createdAt || ''), lastLogin: String(user.lastLogin || ''),
        usage: byUser[user.username.toLowerCase()] || { inputTokens: 0, outputTokens: 0, requests: 0 } };
    });
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

function countTodayUsageInSheet_(username, dateKey) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet && spreadsheet.getSheetByName('Usage');
  if (!sheet || sheet.getLastRow() < 2) return 0;
  const rows = sheet.getDataRange().getValues().slice(1);
  const target = String(username || '').toLowerCase();
  let count = 0;
  rows.forEach(function (row) {
    if (String(row[2] || '').toLowerCase() !== target) return;
    const ts = new Date(row[1]);
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

function getOrInitDailyQuotaRow_(username, dateKey) {
  ensureAdminSchema_();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('DailyQuota');
  const rows = sheet.getDataRange().getValues().slice(1);
  const target = String(username || '').toLowerCase();
  for (let i = 0; i < rows.length; i += 1) {
    if (String(rows[i][0] || '').toLowerCase() === target && normalizeSheetDateKey_(rows[i][1]) === dateKey) {
      return {
        sheet: sheet,
        row: i + 2,
        usedCount: Math.max(0, Math.floor(Number(rows[i][2]) || 0))
      };
    }
  }
  const seededUsed = countTodayUsageInSheet_(username, dateKey);
  sheet.appendRow([sheetText_(username), "'" + dateKey, seededUsed, new Date().toISOString()]);
  return {
    sheet: sheet,
    row: sheet.getLastRow(),
    usedCount: seededUsed
  };
}

function getUserQuotaStatus_(username) {
  const dailyLimit = getDailyRequestLimit_();
  const dateKey = getQuotaDateKey_();
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet && spreadsheet.getSheetByName('DailyQuota');
  let dailyUsed = 0;
  if (sheet && sheet.getLastRow() > 1) {
    const rows = sheet.getDataRange().getValues().slice(1);
    const target = String(username || '').toLowerCase();
    const matches = rows.filter(row => String(row[0] || '').toLowerCase() === target && normalizeSheetDateKey_(row[1]) === dateKey);
    if (matches.length > 0) {
      dailyUsed = matches.reduce((max, row) => Math.max(max, Math.floor(Number(row[2]) || 0)), 0);
    } else {
      dailyUsed = countTodayUsageInSheet_(username, dateKey);
    }
  } else {
    dailyUsed = countTodayUsageInSheet_(username, dateKey);
  }
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
  sheet.appendRow([id, new Date().toISOString(), sheetText_(normalizeUsername_(username)), sheetText_(model), inputTokens, outputTokens]);
}

/** Internal only: call after a real AI provider response. Never accept token counts from the browser.
 * requestId must be the provider's unique request ID; repeated IDs are ignored.
 */
function recordAiUsage_(username, model, inputTokens, outputTokens, requestId) {
  return withAdminLock_(function () {
    return recordAiUsageUnlocked_(username, model, inputTokens, outputTokens, requestId);
  });
}
