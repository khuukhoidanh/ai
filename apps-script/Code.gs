/**
 * Chatbot authentication backend for a spreadsheet-bound Apps Script project.
 * Core sheet columns: username | password | role. Admin.gs adds account metadata.
 * Passwords are hashed server-side; plaintext is never written to the sheet.
 */
const AUTH_CONFIG = {
  usersSheetName: 'Users',
  passwordIterations: 12000,
  sessionTtlSeconds: 21600,
  maxUsernameLength: 64,
  maxPasswordLength: 256
};

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
      case 'getSession':
        return jsonResponse_(getSession(request.token));
      case 'logout':
        return jsonResponse_(logout(request.token));
      case 'adminDashboard':
        return jsonResponse_(adminDashboard_(request.token));
      case 'adminManageUser':
        return jsonResponse_(adminManageUser_(request));
      case 'discordList':
      case 'discordSave':
      case 'discordLoad':
        return jsonResponse_(discordHistory_(request));
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

  const salt = randomHex_(16);
  const storedPassword = 'v1$' + AUTH_CONFIG.passwordIterations + '$' + salt + '$' + hashPassword_(password, salt);
  const record = { username: normalizedUsername, password: storedPassword, role: normalizedRole,
    status: 'active', sessionVersion: Utilities.getUuid(), createdAt: new Date().toISOString(), lastLogin: '' };
  sheet.appendRow(values[0].map(header => record[header] === undefined ? '' : record[header]));
  return { ok: true, username: normalizedUsername };
}

function login(username, password) {
  try {
    const normalizedUsername = normalizeUsername_(username);
    validatePassword_(password);
    const sheet = getUsersSheet_();
    const rows = sheet.getDataRange().getValues();
    const headers = rows[0].map(value => String(value));
    const columns = {
      username: headers.indexOf('username'),
      password: headers.indexOf('password'),
      role: headers.indexOf('role')
    };
    if (Object.values(columns).some(index => index < 0)) throw new Error('Users sheet headers are invalid.');

    const row = rows.slice(1).find(candidate =>
      String(candidate[columns.username]).toLowerCase() === normalizedUsername.toLowerCase()
    );
    // Use a generic failure message to avoid disclosing whether a username exists.
    if (!row || (headers.includes('status') && row[headers.indexOf('status')] === 'disabled') || !verifyPassword_(password, String(row[columns.password]))) {
      return { ok: false, message: 'Username or password is incorrect.' };
    }

    const token = randomHex_(32);
    CacheService.getScriptCache().put(
      sessionCacheKey_(token),
      JSON.stringify({ username: String(row[columns.username]), role: normalizeRole_(String(row[columns.role] || 'standard')),
        sessionVersion: headers.includes('sessionVersion') ? String(row[headers.indexOf('sessionVersion')] || '') : '' }),
      AUTH_CONFIG.sessionTtlSeconds
    );
    if (headers.includes('lastLogin')) sheet.getRange(rows.indexOf(row) + 1, headers.indexOf('lastLogin') + 1).setValue(new Date().toISOString());
    return {
      ok: true,
      token: token,
      username: normalizedUsername,
      role: normalizeRole_(String(row[columns.role] || 'standard')),
      expiresIn: AUTH_CONFIG.sessionTtlSeconds
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

/** Server-side session check for protected operations added later. */
function getSession(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return { ok: false };
  const value = CacheService.getScriptCache().get(sessionCacheKey_(token));
  if (!value) return { ok: false };
  const session = JSON.parse(value);
  const record = userRecords_().find(user => user.username.toLowerCase() === session.username.toLowerCase());
  if (!record || record.status === 'disabled' || String(record.sessionVersion || '') !== String(session.sessionVersion || '')) return { ok: false };
  return { ok: true, user: { username: record.username, role: normalizeRole_(record.role || 'standard') } };
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

function getUsersSheet_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet && spreadsheet.getSheetByName(AUTH_CONFIG.usersSheetName);
  if (!sheet || sheet.getLastRow() < 1) throw new Error('Users sheet is not initialized.');
  return sheet;
}

// PBKDF2-HMAC-SHA-256 (RFC 8018), returned as lowercase hexadecimal.
function hashPassword_(password, saltHex) {
  const salt = hexToBytes_(saltHex);
  const block = salt.concat([0, 0, 0, 1]);
  // For byte[] input, Apps Script also requires the HMAC key to be byte[].
  const key = Utilities.newBlob(password).getBytes();
  let u = Utilities.computeHmacSha256Signature(block, key);
  const result = u.slice();
  for (let iteration = 1; iteration < AUTH_CONFIG.passwordIterations; iteration += 1) {
    u = Utilities.computeHmacSha256Signature(u, key);
    for (let index = 0; index < result.length; index += 1) result[index] ^= u[index];
  }
  return bytesToHex_(result);
}

function verifyPassword_(password, storedPassword) {
  const parts = storedPassword.split('$');
  if (parts.length !== 4 || parts[0] !== 'v1' || Number(parts[1]) !== AUTH_CONFIG.passwordIterations || !/^[a-f0-9]{32}$/.test(parts[2])) {
    return false;
  }
  return constantTimeEquals_(hashPassword_(password, parts[2]), parts[3]);
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
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token);
  return 'auth:' + bytesToHex_(digest);
}
