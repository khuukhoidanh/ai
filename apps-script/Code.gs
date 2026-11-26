/**
 * Chatbot authentication backend for a spreadsheet-bound Apps Script project.
 * Core sheet columns: username | password | role. Admin.gs adds account metadata.
 * Passwords are hashed server-side; plaintext is never written to the sheet.
 */
const AUTH_CONFIG = {
  usersSheetName: 'Users',
  passwordIterations: 120000,
  minPasswordIterations: 12000,
  maxPasswordIterations: 1000000,
  sessionTtlSeconds: 21600,
  usersIndexTtlSeconds: 300,
  lastLoginCacheTtlSeconds: 21600,
  quotaCacheTtlSeconds: 120,
  quotaRowCacheTtlSeconds: 21600,
  maxUsernameLength: 64,
  maxPasswordLength: 256,
  maxLoginAttempts: 5,
  loginLockSeconds: 300,
  maxLoginBackoffSeconds: 3600,
  globalMaxLoginFailures: 25,
  globalLoginWindowSeconds: 300
};

const USERS_INDEX_CACHE_KEY = 'auth:usersIndex:v1';
const GLOBAL_LOGIN_FAIL_CACHE_KEY = 'auth:fail:global:v1';

function doGet() {
  return jsonResponse_({ ok: true, service: 'Chatbot authentication API' });
}

function doPost(event) {
  try {
    const request = JSON.parse(event.postData.contents);
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      return jsonResponse_({ ok: false, message: 'Invalid request.' });
    }
    switch (request.action) {
      case 'login':
        return jsonResponse_(login(request.username, request.password));
      case 'register':
        return jsonResponse_(register(request));
      case 'getSession':
        return jsonResponse_(getSession(request.token));
      case 'logout':
        return jsonResponse_(logout(request.token));
      case 'adminDashboard':
        return jsonResponse_(adminDashboard_(request.token));
      case 'adminManageUser':
        return jsonResponse_(adminManageUser_(request));
      case 'adminSetDailyLimit':
        return jsonResponse_(adminSetDailyLimit_(request));
      case 'getQuota':
        return jsonResponse_(getQuotaEndpoint_(request.token));
      case 'aiChat':
        return jsonResponse_(aiChat_(request));
      default:
        return jsonResponse_({ ok: false, message: 'Unknown action.' });
    }
  } catch (error) {
    return jsonResponse_({ ok: false, message: 'Unable to process request.' });
  }
}

function jsonResponse_(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Run once from the Apps Script editor to create the account sheet. */
function setupUsersSheet() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error('Bind this script to the users spreadsheet first.');

  let sheet = spreadsheet.getSheetByName(AUTH_CONFIG.usersSheetName);
  if (!sheet) sheet = spreadsheet.insertSheet(AUTH_CONFIG.usersSheetName);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['username', 'password', 'role']);
    sheet.setFrozenRows(1);
    invalidateUsersIndexCache_();
  }
  return { ok: true, message: 'Users sheet is ready.' };
}

/**
 * Add a user from the Apps Script editor only. Never call this from the browser.
 * Example: createUser('alice', 'use-a-long-unique-password', 'standard');
 */
function createUser(username, password, role) {
  return withAdminLock_(function () { return createUserRecord_(username, password, role); });
}

function createUserRecord_(username, password, role) {
  const normalizedUsername = normalizeUsername_(username);
  validatePassword_(password);
  const normalizedRole = normalizeRole_(role || 'standard');
  ensureAdminSchema_();
  const sheet = getUsersSheet_();
  const values = sheet.getDataRange().getValues();
  const usernameColumn = values[0].indexOf('username');
  if (usernameColumn < 0) throw new Error('Users sheet is missing its username header.');

  if (values.slice(1).some(row => String(row[usernameColumn]).toLowerCase() === normalizedUsername.toLowerCase())) {
    throw new Error('A user with that username already exists.');
  }

  const storedPassword = formatStoredPassword_(password);
  const record = { username: normalizedUsername, password: storedPassword, role: normalizedRole,
    status: 'active', sessionVersion: Utilities.getUuid(), createdAt: new Date().toISOString(), lastLogin: '' };
  sheet.appendRow(values[0].map(header => record[header] === undefined ? '' : record[header]));
  invalidateUsersIndexCache_();
  return { ok: true, username: normalizedUsername };
}

function normalizeDiscordId_(discordId) {
  if (typeof discordId !== 'string') throw new Error('Discord ID không hợp lệ.');
  const value = discordId.trim();
  if (!/^\d{17,20}$/.test(value)) {
    throw new Error('Discord ID phải gồm 17 đến 20 chữ số.');
  }
  return value;
}

function normalizeSheetDiscordId_(cellValue) {
  return String(cellValue || '').replace(/^'/, '').trim();
}

function hasUsernameInUsersSheet_(normalizedUsername) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet && spreadsheet.getSheetByName(AUTH_CONFIG.usersSheetName);
  if (!sheet || sheet.getLastRow() < 2) return false;
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(String);
  const userCol = headers.indexOf('username');
  if (userCol < 0) return false;
  const targetLower = normalizedUsername.toLowerCase();
  return values.slice(1).some(row => String(row[userCol] || '').toLowerCase() === targetLower);
}

function findDiscordAccountConflict_(discordId, normalizedUsername) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet && spreadsheet.getSheetByName('DiscordAccounts');
  if (!sheet || sheet.getLastRow() < 2) return null;
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(String);
  const idCol = headers.indexOf('discordId') >= 0 ? headers.indexOf('discordId') : 0;
  const userCol = headers.indexOf('username') >= 0 ? headers.indexOf('username') : 1;
  const targetLower = normalizedUsername.toLowerCase();

  for (let i = 1; i < values.length; i += 1) {
    const existingId = normalizeSheetDiscordId_(values[i][idCol]);
    const existingUser = String(values[i][userCol] || '').trim().toLowerCase();
    if (existingId && existingId === discordId) {
      return { ok: false, code: 'DUPLICATE_DISCORD_ID', message: 'Discord ID này đã được sử dụng để đăng ký tài khoản.' };
    }
    if (existingUser && existingUser === targetLower) {
      return { ok: false, code: 'DUPLICATE_USERNAME', message: 'Tên đăng nhập đã tồn tại.' };
    }
  }
  return null;
}

function resolveDiscordVerifyUrl_(rawUrl) {
  const value = String(rawUrl || '').trim();
  const match = value.match(/^(https:\/\/[A-Za-z0-9.-]+(?::\d+)?)(\/[^\s]*)?$/);
  if (!match) return '';
  const origin = match[1];
  const pathPart = match[2] || '';
  if (!pathPart || pathPart === '/') return origin + '/verify-member';
  return origin + pathPart;
}

function verifyDiscordViaProxy_(discordId, verifyUrl, sharedSecret, unavailable) {
  let response;
  let status = 0;
  let data = null;
  try {
    response = UrlFetchApp.fetch(verifyUrl, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'X-Verify-Secret': sharedSecret },
      payload: JSON.stringify({ discordId: discordId }),
      muteHttpExceptions: true
    });
    status = response.getResponseCode();
    try { data = JSON.parse(response.getContentText() || '{}'); } catch (e) { data = null; }
  } catch (error) {
    console.error('Discord proxy verification request failed:', error && error.message ? error.message : 'unknown');
    return unavailable;
  }
  if (status === 429 || (data && data.code === 'DISCORD_RATE_LIMITED')) {
    return { ok: false, code: 'DISCORD_RATE_LIMITED', message: 'Hệ thống xác minh Discord đang bận. Vui lòng thử lại sau ít phút.' };
  }
  if (status !== 200 || !data || data.ok !== true || typeof data.isMember !== 'boolean') {
    console.error('Discord proxy verification error: status=' + status);
    return unavailable;
  }
  if (!data.isMember) {
    return {
      ok: false,
      code: 'NOT_DISCORD_MEMBER',
      message: 'Discord ID này chưa tham gia máy chủ Discord. Vui lòng tham gia máy chủ Discord trước rồi thử đăng ký lại.'
    };
  }
  return { ok: true, isMember: true };
}

function verifyDiscordMembership_(discordId) {
  const unavailable = {
    ok: false,
    code: 'REGISTRATION_UNAVAILABLE',
    message: 'Hệ thống xác minh đăng ký hiện tạm thời không khả dụng. Vui lòng thử lại sau.'
  };

  let verifyUrl = '';
  let sharedSecret = '';
  let guildId = '';
  let botToken = '';
  try {
    const props = PropertiesService.getScriptProperties();
    verifyUrl = resolveDiscordVerifyUrl_(props.getProperty('DISCORD_VERIFY_URL'));
    sharedSecret = String(props.getProperty('DISCORD_VERIFY_SECRET') || '').trim();
    guildId = String(props.getProperty('DISCORD_GUILD_ID') || '').trim();
    botToken = String(props.getProperty('DISCORD_BOT_TOKEN') || '').trim().replace(/^Bot\s+/i, '');
  } catch (error) {
    console.error('Failed to read ScriptProperties for Discord verification');
    return unavailable;
  }
  if (typeof UrlFetchApp === 'undefined' || typeof UrlFetchApp.fetch !== 'function') {
    return unavailable;
  }
  if (verifyUrl && sharedSecret) {
    return verifyDiscordViaProxy_(discordId, verifyUrl, sharedSecret, unavailable);
  }
  if (!/^\d{17,20}$/.test(guildId) || !botToken) {
    console.error('Discord verification config missing or invalid DISCORD_GUILD_ID/DISCORD_BOT_TOKEN');
    return unavailable;
  }

  const url = 'https://discord.com/api/v10/guilds/' + encodeURIComponent(guildId) + '/members/' + encodeURIComponent(discordId);
  let response;
  let status = 0;
  try {
    response = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: {
        Authorization: 'Bot ' + botToken
      },
      muteHttpExceptions: true
    });
    status = response.getResponseCode();
  } catch (error) {
    console.error('Discord verification request failed:', error && error.message ? error.message : 'unknown');
    return unavailable;
  }

  if (status === 200) {
    return { ok: true, isMember: true };
  }
  if (status === 404) {
    return {
      ok: false,
      code: 'NOT_DISCORD_MEMBER',
      message: 'Discord ID này chưa tham gia máy chủ Discord. Vui lòng tham gia máy chủ Discord trước rồi thử đăng ký lại.'
    };
  }
  if (status === 429) {
    return {
      ok: false,
      code: 'DISCORD_RATE_LIMITED',
      message: 'Hệ thống xác minh Discord đang bận. Vui lòng thử lại sau ít phút.'
    };
  }
  console.error('Discord API returned status ' + status);
  return unavailable;
}

/** Run manually from the Apps Script Editor to diagnose Discord verification config (never logs secrets). */
function testDiscordVerifyConfig() {
  const props = PropertiesService.getScriptProperties();
  const verifyUrl = resolveDiscordVerifyUrl_(props.getProperty('DISCORD_VERIFY_URL'));
  const hasSecret = Boolean(String(props.getProperty('DISCORD_VERIFY_SECRET') || '').trim());
  const guildId = String(props.getProperty('DISCORD_GUILD_ID') || '').trim();
  const botToken = String(props.getProperty('DISCORD_BOT_TOKEN') || '').trim().replace(/^Bot\s+/i, '');

  if (verifyUrl && hasSecret) {
    const res = UrlFetchApp.fetch(verifyUrl, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'X-Verify-Secret': String(props.getProperty('DISCORD_VERIFY_SECRET') || '').trim() },
      payload: JSON.stringify({ discordId: '00000000000000000' }),
      muteHttpExceptions: true
    });
    const out = { mode: 'proxy', status: res.getResponseCode(), body: String(res.getContentText() || '').slice(0, 200) };
    console.log(JSON.stringify(out));
    return out;
  }

  if (!/^\d{17,20}$/.test(guildId) || !botToken) {
    const err = { ok: false, reason: 'Missing or invalid DISCORD_GUILD_ID / DISCORD_BOT_TOKEN in Script Properties.' };
    console.log(JSON.stringify(err));
    return err;
  }

  const res = UrlFetchApp.fetch('https://discord.com/api/v10/guilds/' + encodeURIComponent(guildId), {
    method: 'get',
    headers: { Authorization: 'Bot ' + botToken },
    muteHttpExceptions: true
  });
  const out = {
    mode: 'direct',
    status: res.getResponseCode(),
    body: String(res.getContentText() || '').slice(0, 200)
  };
  console.log(JSON.stringify(out));
  return out;
}

function register(request) {
  try {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      return { ok: false, code: 'INVALID_REQUEST', message: 'Yêu cầu đăng ký không hợp lệ.' };
    }

    let discordId;
    let normalizedUsername;
    try {
      discordId = normalizeDiscordId_(request.discordId);
      normalizedUsername = normalizeUsername_(request.username);
    } catch (error) {
      return { ok: false, code: 'INVALID_INPUT', message: error.message || 'Thông tin đăng ký không hợp lệ.' };
    }

    const password = request.password;
    const confirmPassword = request.confirmPassword;
    try {
      validatePassword_(password);
    } catch (error) {
      return { ok: false, code: 'INVALID_PASSWORD', message: 'Mật khẩu không hợp lệ.' };
    }
    if (password.length < 8) {
      return { ok: false, code: 'INVALID_PASSWORD', message: 'Mật khẩu cần ít nhất 8 ký tự.' };
    }
    if (typeof confirmPassword !== 'string' || password !== confirmPassword) {
      return { ok: false, code: 'PASSWORD_MISMATCH', message: 'Mật khẩu xác nhận không khớp.' };
    }

    // Check obvious duplicates before making the external verification call.
    if (hasUsernameInUsersSheet_(normalizedUsername)) {
      return { ok: false, code: 'DUPLICATE_USERNAME', message: 'Tên đăng nhập đã tồn tại.' };
    }
    const preConflict = findDiscordAccountConflict_(discordId, normalizedUsername);
    if (preConflict) return preConflict;

    const verification = verifyDiscordMembership_(discordId);
    if (!verification.ok) return verification;

    return withAdminLock_(function () {
      const usersSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AUTH_CONFIG.usersSheetName);
      if (!usersSheet || usersSheet.getLastRow() < 1) {
        setupUsersSheet();
      }
      ensureAdminSchema_();

      if (hasUsernameInUsersSheet_(normalizedUsername)) {
        return { ok: false, code: 'DUPLICATE_USERNAME', message: 'Tên đăng nhập đã tồn tại.' };
      }
      const lockedConflict = findDiscordAccountConflict_(discordId, normalizedUsername);
      if (lockedConflict) return lockedConflict;

      createUserRecord_(normalizedUsername, password, 'standard');
      const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
      const discordSheet = spreadsheet.getSheetByName('DiscordAccounts');
      discordSheet.appendRow(["'" + discordId, sheetText_(normalizedUsername), new Date().toISOString()]);

      const auditSheet = spreadsheet.getSheetByName('Audit');
      if (auditSheet) {
        auditSheet.appendRow([new Date().toISOString(), sheetText_(normalizedUsername), 'register', "'" + discordId]);
      }

      return {
        ok: true,
        username: normalizedUsername,
        message: 'Đăng ký tài khoản thành công. Bạn có thể đăng nhập ngay bây giờ.'
      };
    });
  } catch (error) {
    console.error('Registration failed:', error && error.message ? error.message : 'unknown');
    return { ok: false, code: 'REGISTRATION_ERROR', message: 'Không thể hoàn tất đăng ký lúc này. Vui lòng thử lại sau.' };
  }
}

function sha256Hex_(value) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value || ''));
  return bytesToHex_(digest);
}

function cacheGetMany_(cache, keys) {
  if (!cache || !keys || keys.length === 0) return {};
  if (typeof cache.getAll === 'function') {
    const result = Object.create(null);
    for (let i = 0; i < keys.length; i += 100) {
      const chunk = keys.slice(i, i + 100);
      Object.assign(result, cache.getAll(chunk) || {});
    }
    return result;
  }
  const result = Object.create(null);
  keys.forEach(function (key) {
    const value = cache.get(key);
    if (value !== null && value !== undefined) result[key] = value;
  });
  return result;
}

function cachePutMany_(cache, entries, ttlSeconds) {
  if (!cache || !entries) return;
  const keys = Object.keys(entries);
  if (keys.length === 0) return;
  if (typeof cache.putAll === 'function') {
    cache.putAll(entries, ttlSeconds);
    return;
  }
  keys.forEach(function (key) {
    cache.put(key, entries[key], ttlSeconds);
  });
}

function invalidateUsersIndexCache_(cache) {
  try {
    (cache || CacheService.getScriptCache()).remove(USERS_INDEX_CACHE_KEY);
  } catch (error) {}
}

function lastLoginCacheKey_(username) {
  return 'auth:lastLogin:' + sha256Hex_(String(username || '').toLowerCase());
}

function rowToUserRecord_(headers, rowValues, rowNumber) {
  const user = { row: rowNumber };
  headers.forEach(function (header, column) { user[header] = rowValues[column]; });
  user.username = String(user.username || '');
  return user;
}

/**
 * Look up a single user record using a cached username -> row index when possible,
 * reading only 1 row from Users while verifying live cell contents on the sheet.
 */
function findUserRecordByUsername_(username, cache, preloadedIndexRaw) {
  const targetLower = String(username || '').toLowerCase();
  if (!targetLower) return null;
  const activeCache = cache || CacheService.getScriptCache();
  const sheet = getUsersSheet_(true);

  const indexRaw = preloadedIndexRaw !== undefined ? preloadedIndexRaw : activeCache.get(USERS_INDEX_CACHE_KEY);
  if (indexRaw) {
    try {
      const parsed = JSON.parse(indexRaw);
      const headers = parsed && Array.isArray(parsed.headers) ? parsed.headers.map(String) : null;
      const rowsMap = parsed && parsed.rows && typeof parsed.rows === 'object' ? parsed.rows : null;
      const usernameCol = headers ? headers.indexOf('username') : -1;
      const passwordCol = headers ? headers.indexOf('password') : -1;
      const roleCol = headers ? headers.indexOf('role') : -1;
      const rowNumber = rowsMap ? Number(rowsMap[targetLower]) : 0;
      if (usernameCol >= 0 && passwordCol >= 0 && roleCol >= 0 &&
          Number.isInteger(rowNumber) && rowNumber >= 2) {
        const rowValues = sheet.getRange(rowNumber, 1, 1, headers.length).getValues()[0];
        if (String(rowValues[usernameCol] || '').toLowerCase() === targetLower) {
          return {
            record: rowToUserRecord_(headers, rowValues, rowNumber),
            headers: headers,
            rowNumber: rowNumber
          };
        }
      }
    } catch (error) {}
  }

  if (sheet.getLastRow() < 1) throw new Error('Users sheet is not initialized.');
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(value => String(value));
  const usernameCol = headers.indexOf('username');
  const passwordCol = headers.indexOf('password');
  const roleCol = headers.indexOf('role');
  if (usernameCol < 0 || passwordCol < 0 || roleCol < 0) {
    throw new Error('Users sheet headers are invalid.');
  }

  const rowsMap = Object.create(null);
  for (let i = 1; i < values.length; i += 1) {
    const key = String(values[i][usernameCol] || '').toLowerCase();
    if (key && rowsMap[key] === undefined) {
      rowsMap[key] = i + 1;
    }
  }
  try {
    const serialized = JSON.stringify({ headers: headers, rows: rowsMap });
    if (serialized.length <= 95000) {
      activeCache.put(USERS_INDEX_CACHE_KEY, serialized, AUTH_CONFIG.usersIndexTtlSeconds);
    }
  } catch (error) {}

  const matchedRow = rowsMap[targetLower];
  if (!matchedRow) return null;
  return {
    record: rowToUserRecord_(headers, values[matchedRow - 1], matchedRow),
    headers: headers,
    rowNumber: matchedRow
  };
}

function loginFailCacheKey_(normalizedUsername) {
  return 'auth:fail:' + sha256Hex_(String(normalizedUsername || '').toLowerCase());
}

function parseFailState_(rawValue) {
  if (!rawValue) return { count: 0, lockedUntil: 0 };
  const asNum = Number(rawValue);
  if (Number.isFinite(asNum)) {
    return { count: Math.max(0, Math.floor(asNum)), lockedUntil: 0 };
  }
  try {
    const parsed = JSON.parse(rawValue);
    return {
      count: Math.max(0, Math.floor(Number(parsed && parsed.count) || 0)),
      lockedUntil: Math.max(0, Number(parsed && parsed.lockedUntil) || 0)
    };
  } catch (error) {
    return { count: 0, lockedUntil: 0 };
  }
}

function computeLoginLockSeconds_(failCount) {
  if (failCount < AUTH_CONFIG.maxLoginAttempts) return 0;
  const exponent = Math.min(6, failCount - AUTH_CONFIG.maxLoginAttempts);
  return Math.min(AUTH_CONFIG.maxLoginBackoffSeconds, AUTH_CONFIG.loginLockSeconds * Math.pow(2, exponent));
}

function upgradePasswordHashIfNeeded_(username, password, currentHash) {
  const parts = String(currentHash || '').split('$');
  const currentIter = Number(parts[1]) || 0;
  if (currentIter >= AUTH_CONFIG.passwordIterations) return false;
  try {
    return withAdminLock_(function () {
      const sheet = getUsersSheet_();
      const values = sheet.getDataRange().getValues();
      if (values.length < 2) return false;
      const headers = values[0].map(String);
      const userCol = headers.indexOf('username');
      const passCol = headers.indexOf('password');
      if (userCol < 0 || passCol < 0) return false;
      const targetLower = String(username || '').toLowerCase();
      for (let i = 1; i < values.length; i += 1) {
        if (String(values[i][userCol] || '').toLowerCase() === targetLower) {
          const latestIter = Number(String(values[i][passCol] || '').split('$')[1]) || 0;
          if (latestIter >= AUTH_CONFIG.passwordIterations) return false;
          sheet.getRange(i + 1, passCol + 1).setValue(formatStoredPassword_(password));
          return true;
        }
      }
      return false;
    });
  } catch (error) {
    return false;
  }
}

function login(username, password) {
  try {
    const t0 = Date.now();
    const normalizedUsername = normalizeUsername_(username);
    validatePassword_(password);
    const cache = CacheService.getScriptCache();
    const failKey = loginFailCacheKey_(normalizedUsername);
    const cached = cacheGetMany_(cache, [failKey, GLOBAL_LOGIN_FAIL_CACHE_KEY, USERS_INDEX_CACHE_KEY]);
    const failState = parseFailState_(cached[failKey]);
    const globalFailCount = Math.max(0, Math.floor(Number(cached[GLOBAL_LOGIN_FAIL_CACHE_KEY]) || 0));
    const nowMs = Date.now();

    if (globalFailCount >= AUTH_CONFIG.globalMaxLoginFailures) {
      return { ok: false, code: 'TOO_MANY_ATTEMPTS', message: 'Hệ thống đang tạm giới hạn đăng nhập do quá nhiều yêu cầu sai. Vui lòng thử lại sau 5 phút.' };
    }
    if ((failState.lockedUntil > nowMs) || (failState.lockedUntil === 0 && failState.count >= AUTH_CONFIG.maxLoginAttempts)) {
      return { ok: false, code: 'TOO_MANY_ATTEMPTS', message: 'Bạn đã nhập sai quá nhiều lần. Vui lòng thử lại sau 5 phút.' };
    }

    const found = findUserRecordByUsername_(normalizedUsername, cache, cached[USERS_INDEX_CACHE_KEY]);
    const tLookup = Date.now();
    const record = found && found.record;
    // Use a generic failure message to avoid disclosing whether a username exists.
    if (!record || record.status === 'disabled' || !verifyPassword_(password, String(record.password || ''))) {
      const nextFails = failState.count + 1;
      const lockSeconds = computeLoginLockSeconds_(nextFails);
      const nextLockedUntil = lockSeconds > 0 ? nowMs + lockSeconds * 1000 : 0;
      const failTtl = Math.max(AUTH_CONFIG.loginLockSeconds, lockSeconds || AUTH_CONFIG.loginLockSeconds);
      const failWrites = {};
      failWrites[failKey] = JSON.stringify({ count: nextFails, lockedUntil: nextLockedUntil });
      cachePutMany_(cache, failWrites, failTtl);
      cache.put(GLOBAL_LOGIN_FAIL_CACHE_KEY, String(globalFailCount + 1), AUTH_CONFIG.globalLoginWindowSeconds);
      if (lockSeconds > 0) {
        return { ok: false, code: 'TOO_MANY_ATTEMPTS', message: 'Bạn đã nhập sai quá nhiều lần. Vui lòng thử lại sau 5 phút.' };
      }
      return { ok: false, message: 'Username or password is incorrect.' };
    }
    const tVerify = Date.now();

    if (failState.count > 0) cache.remove(failKey);
    upgradePasswordHashIfNeeded_(record.username, password, record.password);
    const matchedUsername = record.username;
    const role = normalizeRole_(String(record.role || 'standard'));
    const token = randomHex_(32);
    const cacheWrites = {};
    cacheWrites[sessionCacheKey_(token)] = JSON.stringify({
      username: matchedUsername,
      role: role,
      sessionVersion: String(record.sessionVersion || '')
    });
    if (found.headers.includes('lastLogin')) {
      cacheWrites[lastLoginCacheKey_(matchedUsername)] = new Date().toISOString();
    }
    cachePutMany_(cache, cacheWrites, AUTH_CONFIG.sessionTtlSeconds);

    const quota = typeof getUserQuotaStatus_ === 'function'
      ? getUserQuotaStatus_(matchedUsername, cache)
      : { dailyUsed: 0, dailyLimit: 200, remaining: 200 };
    const tDone = Date.now();
    return {
      ok: true,
      token: token,
      username: normalizedUsername,
      role: role,
      dailyUsed: quota.dailyUsed,
      dailyLimit: quota.dailyLimit,
      remaining: quota.remaining,
      expiresIn: AUTH_CONFIG.sessionTtlSeconds,
      timing: {
        lookupMs: tLookup - t0,
        verifyMs: tVerify - tLookup,
        quotaMs: tDone - tVerify,
        totalMs: tDone - t0
      }
    };
  } catch (error) {
    console.error('Login failed:', error);
    return { ok: false, message: 'Unable to sign in right now. Please try again later.' };
  }
}

function logout(token) {
  if (typeof token === 'string' && /^[a-f0-9]{64}$/.test(token)) {
    CacheService.getScriptCache().remove(sessionCacheKey_(token));
  }
  return { ok: true };
}

function getSession_(token, includeQuota) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return { ok: false };
  const cache = CacheService.getScriptCache();
  const value = cache.get(sessionCacheKey_(token));
  if (!value) return { ok: false };
  const session = JSON.parse(value);
  const found = findUserRecordByUsername_(session.username, cache);
  const record = found && found.record;
  if (!record || record.status === 'disabled' || String(record.sessionVersion || '') !== String(session.sessionVersion || '')) return { ok: false };
  const user = {
    username: record.username,
    role: normalizeRole_(String(record.role || 'standard'))
  };
  if (includeQuota !== false) {
    const quota = typeof getUserQuotaStatus_ === 'function'
      ? getUserQuotaStatus_(record.username, cache)
      : { dailyUsed: 0, dailyLimit: 200, remaining: 200 };
    user.dailyUsed = quota.dailyUsed;
    user.dailyLimit = quota.dailyLimit;
    user.remaining = quota.remaining;
  }
  return {
    ok: true,
    user: user
  };
}

/** Server-side session check for protected operations added later. */
function getSession(token) {
  return getSession_(token, true);
}

function getQuotaEndpoint_(token) {
  const session = getSession(token);
  if (!session.ok || !session.user) {
    return { ok: false, code: 'UNAUTHORIZED', message: 'Phiên đăng nhập hết hạn. Vui lòng đăng nhập lại.' };
  }
  return {
    ok: true,
    dailyUsed: session.user.dailyUsed,
    dailyLimit: session.user.dailyLimit,
    remaining: session.user.remaining
  };
}

function normalizeUsername_(username) {
  if (typeof username !== 'string') throw new Error('Invalid username.');
  const value = username.trim();
  if (!value || value.length > AUTH_CONFIG.maxUsernameLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Invalid username.');
  }
  if (/^[=+@-]/.test(value)) throw new Error('Username cannot start with =, +, @ or -.');
  return value;
}

function normalizeRole_(role) {
  const value = typeof role === 'string' ? role.trim().toLowerCase() : '';
  if (value === 'user') return 'standard';
  if (!['standard', 'vip', 'admin'].includes(value)) throw new Error('Role must be Standard, Vip or Admin.');
  return value;
}

function validatePassword_(password) {
  if (typeof password !== 'string' || !password || password.length > AUTH_CONFIG.maxPasswordLength) {
    throw new Error('Invalid password.');
  }
}

function getUsersSheet_(skipRowCheck) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet && spreadsheet.getSheetByName(AUTH_CONFIG.usersSheetName);
  if (!sheet || (!skipRowCheck && sheet.getLastRow() < 1)) throw new Error('Users sheet is not initialized.');
  return sheet;
}

const SHA256_K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

const SHA256_INIT = new Int32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
]);

function utf8Bytes_(text) {
  const bytes = [];
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i);
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i += 1;
        bytes.push(
          0xf0 | (code >> 18),
          0x80 | ((code >> 12) & 0x3f),
          0x80 | ((code >> 6) & 0x3f),
          0x80 | (code & 0x3f)
        );
      } else {
        bytes.push(0xef, 0xbf, 0xbd);
      }
    } else if (code >= 0xd800 && code <= 0xdfff) {
      bytes.push(0xef, 0xbf, 0xbd);
    } else {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return bytes;
}

function sha256Compress_(state, w) {
  for (let i = 16; i < 64; i += 1) {
    const s0w = w[i - 15];
    const s1w = w[i - 2];
    const s0 = ((s0w >>> 7) | (s0w << 25)) ^ ((s0w >>> 18) | (s0w << 14)) ^ (s0w >>> 3);
    const s1 = ((s1w >>> 17) | (s1w << 15)) ^ ((s1w >>> 19) | (s1w << 13)) ^ (s1w >>> 10);
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
  }
  let a = state[0], b = state[1], c = state[2], d = state[3];
  let e = state[4], f = state[5], g = state[6], h = state[7];
  for (let i = 0; i < 64; i += 1) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const ch = (e & f) ^ ((~e) & g);
    const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) | 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const temp2 = (S0 + maj) | 0;
    h = g; g = f; f = e; e = (d + temp1) | 0;
    d = c; c = b; b = a; a = (temp1 + temp2) | 0;
  }
  state[0] = (state[0] + a) | 0;
  state[1] = (state[1] + b) | 0;
  state[2] = (state[2] + c) | 0;
  state[3] = (state[3] + d) | 0;
  state[4] = (state[4] + e) | 0;
  state[5] = (state[5] + f) | 0;
  state[6] = (state[6] + g) | 0;
  state[7] = (state[7] + h) | 0;
}

function sha256Words_(bytes) {
  const state = new Int32Array(SHA256_INIT);
  const w = new Int32Array(64);
  const len = bytes.length;
  const fullBlocks = Math.floor(len / 64);
  for (let b = 0; b < fullBlocks; b += 1) {
    const base = b * 64;
    for (let i = 0; i < 16; i += 1) {
      const idx = base + i * 4;
      w[i] = (bytes[idx] << 24) | (bytes[idx + 1] << 16) | (bytes[idx + 2] << 8) | bytes[idx + 3];
    }
    sha256Compress_(state, w);
  }
  const rem = len - fullBlocks * 64;
  w.fill(0, 0, 16);
  const tailBase = fullBlocks * 64;
  for (let i = 0; i < rem; i += 1) {
    w[i >> 2] |= (bytes[tailBase + i] & 0xff) << (24 - (i & 3) * 8);
  }
  w[rem >> 2] |= 0x80 << (24 - (rem & 3) * 8);
  if (rem >= 56) {
    sha256Compress_(state, w);
    w.fill(0, 0, 16);
  }
  const bitLen = len * 8;
  w[14] = Math.floor(bitLen / 0x100000000);
  w[15] = bitLen | 0;
  sha256Compress_(state, w);
  return state;
}

// PBKDF2-HMAC-SHA-256 (RFC 8018), computed in pure JS to avoid Apps Script service-bridge calls.
function hashPassword_(password, saltHex, iterations) {
  const iterCount = Number.isInteger(iterations) && iterations >= 1 ? iterations : AUTH_CONFIG.passwordIterations;
  const keyRaw = utf8Bytes_(password);
  const keyBlock = new Uint8Array(64);
  if (keyRaw.length > 64) {
    const keyWords = sha256Words_(keyRaw);
    for (let i = 0; i < 8; i += 1) {
      const word = keyWords[i];
      keyBlock[i * 4] = (word >>> 24) & 0xff;
      keyBlock[i * 4 + 1] = (word >>> 16) & 0xff;
      keyBlock[i * 4 + 2] = (word >>> 8) & 0xff;
      keyBlock[i * 4 + 3] = word & 0xff;
    }
  } else {
    for (let i = 0; i < keyRaw.length; i += 1) keyBlock[i] = keyRaw[i];
  }

  const w = new Int32Array(64);
  const ipadState = new Int32Array(SHA256_INIT);
  for (let i = 0; i < 16; i += 1) {
    const idx = i * 4;
    w[i] = ((keyBlock[idx] ^ 0x36) << 24) | ((keyBlock[idx + 1] ^ 0x36) << 16) |
      ((keyBlock[idx + 2] ^ 0x36) << 8) | (keyBlock[idx + 3] ^ 0x36);
  }
  sha256Compress_(ipadState, w);

  const opadState = new Int32Array(SHA256_INIT);
  for (let i = 0; i < 16; i += 1) {
    const idx = i * 4;
    w[i] = ((keyBlock[idx] ^ 0x5c) << 24) | ((keyBlock[idx + 1] ^ 0x5c) << 16) |
      ((keyBlock[idx + 2] ^ 0x5c) << 8) | (keyBlock[idx + 3] ^ 0x5c);
  }
  sha256Compress_(opadState, w);

  const salt = hexToBytes_(saltHex);
  const block = salt.concat([0, 0, 0, 1]);
  const state = new Int32Array(ipadState);
  w.fill(0, 0, 16);
  for (let i = 0; i < block.length; i += 1) {
    w[i >> 2] |= (block[i] & 0xff) << (24 - (i & 3) * 8);
  }
  w[block.length >> 2] |= 0x80 << (24 - (block.length & 3) * 8);
  w[15] = (64 + block.length) * 8;
  sha256Compress_(state, w);

  const u = new Int32Array(opadState);
  w.fill(0, 0, 16);
  for (let i = 0; i < 8; i += 1) w[i] = state[i];
  w[8] = 0x80000000 | 0;
  w[15] = 768;
  sha256Compress_(u, w);

  const result = new Int32Array(u);
  for (let iteration = 1; iteration < iterCount; iteration += 1) {
    state.set(ipadState);
    w.fill(0, 0, 16);
    for (let i = 0; i < 8; i += 1) w[i] = u[i];
    w[8] = 0x80000000 | 0;
    w[15] = 768;
    sha256Compress_(state, w);

    u.set(opadState);
    w.fill(0, 0, 16);
    for (let i = 0; i < 8; i += 1) w[i] = state[i];
    w[8] = 0x80000000 | 0;
    w[15] = 768;
    sha256Compress_(u, w);

    for (let i = 0; i < 8; i += 1) result[i] ^= u[i];
  }

  let hex = '';
  for (let i = 0; i < 8; i += 1) {
    hex += (result[i] >>> 0).toString(16).padStart(8, '0');
  }
  return hex;
}

function formatStoredPassword_(password, iterations) {
  const iterCount = Number.isInteger(iterations) && iterations >= AUTH_CONFIG.minPasswordIterations
    ? iterations
    : AUTH_CONFIG.passwordIterations;
  const salt = randomHex_(16);
  return 'v1$' + iterCount + '$' + salt + '$' + hashPassword_(password, salt, iterCount);
}

function verifyPassword_(password, storedPassword) {
  const parts = String(storedPassword || '').split('$');
  const iterations = Number(parts[1]);
  if (parts.length !== 4 ||
      parts[0] !== 'v1' ||
      !Number.isInteger(iterations) ||
      iterations < AUTH_CONFIG.minPasswordIterations ||
      iterations > AUTH_CONFIG.maxPasswordIterations ||
      !/^[a-f0-9]{32}$/.test(parts[2]) ||
      !/^[a-f0-9]{64}$/.test(parts[3])) {
    return false;
  }
  return constantTimeEquals_(hashPassword_(password, parts[2], iterations), parts[3]);
}

function constantTimeEquals_(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function randomHex_(byteCount) {
  let value = '';
  while (value.length < byteCount * 2) value += Utilities.getUuid().replace(/-/g, '');
  return value.slice(0, byteCount * 2).toLowerCase();
}

function bytesToHex_(bytes) {
  return bytes.map(value => (value & 255).toString(16).padStart(2, '0')).join('');
}

function hexToBytes_(hex) {
  const bytes = [];
  for (let index = 0; index < hex.length; index += 2) bytes.push(parseInt(hex.slice(index, index + 2), 16));
  return bytes;
}

function sessionCacheKey_(token) {
  return 'auth:' + sha256Hex_(token);
}
