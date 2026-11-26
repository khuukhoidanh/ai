const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const path = require('node:path');

function backend() {
  class Sheet {
    constructor() { this.rows = []; }
    getLastRow() { return this.rows.length; }
    appendRow(row) { this.rows.push([...row]); }
    deleteRow(row) { this.rows.splice(row - 1, 1); }
    setFrozenRows() {}
    getDataRange() {
      const width = Math.max(1, ...this.rows.map(row => row.length));
      return this.getRange(1, 1, Math.max(1, this.rows.length), width);
    }
    getRange(row, col, height = 1, width = 1) {
      return {
        getValues: () => Array.from({ length: height }, (_, i) => Array.from({ length: width }, (_, j) => this.rows[row - 1 + i]?.[col - 1 + j] ?? '')),
        setValue: value => { this.rows[row - 1] ||= []; this.rows[row - 1][col - 1] = value; },
        setValues: values => values.forEach((line, i) => line.forEach((value, j) => { this.rows[row - 1 + i] ||= []; this.rows[row - 1 + i][col - 1 + j] = value; }))
      };
    }
  }
  const sheets = new Map();
  const spreadsheet = { getSheetByName: name => sheets.get(name), insertSheet: name => { const sheet = new Sheet(); sheets.set(name, sheet); return sheet; } };
  const cache = new Map();
  let locked = false;
  const context = vm.createContext({
    console: { error() {} },
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet },
    LockService: { getScriptLock: () => ({ waitLock() { assert.equal(locked, false, 'no nested locks'); locked = true; }, releaseLock() { locked = false; } }) },
    CacheService: { getScriptCache: () => ({ put: (key, value) => cache.set(key, value), get: key => cache.get(key), remove: key => cache.delete(key) }) },
    ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: text => ({ text, setMimeType() { return this; } }) },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      newBlob: text => ({ getBytes: () => [...Buffer.from(text)] }),
      computeHmacSha256Signature: (data, key) => [...crypto.createHmac('sha256', Buffer.from(key)).update(Buffer.from(data)).digest()],
      computeDigest: (_, text) => [...crypto.createHash('sha256').update(text).digest()],
      DigestAlgorithm: { SHA_256: 'sha256' }
    }
  });
  for (const name of ['Code.gs', 'Admin.gs']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script', name), 'utf8'), context);
  context.setupAdminSheets();
  context.createUser('owner', 'test-password', 'Admin');
  const token = context.login('owner', 'test-password').token;
  const call = data => JSON.parse(context.doPost({ postData: { contents: JSON.stringify(data) } }).text);
  const manage = data => call({ action: 'adminManageUser', token, ...data });
  return { context, sheets, token, call, manage };
}

test('three roles, legacy migration, protected endpoints and no password disclosure', () => {
  const b = backend();
  assert.equal(b.manage({ operation: 'create', username: 'alice', password: 'password-123', role: 'Standard' }).ok, true);
  assert.equal(b.manage({ operation: 'create', username: 'alice', password: 'password-123', role: 'Vip' }).ok, false);
  assert.equal(b.manage({ operation: 'create', username: '=HYPERLINK("x")', password: 'password-123', role: 'Vip' }).ok, false);
  const login = b.context.login('alice', 'password-123');
  assert.equal(login.role, 'standard');
  for (const action of ['adminDashboard', 'adminManageUser']) {
    assert.equal(b.call({ action, token: login.token, operation: 'update', username: 'alice', role: 'admin', status: 'active' }).code, 'FORBIDDEN');
    assert.equal(b.call({ action, token: 'invalid' }).code, 'FORBIDDEN');
  }
  const result = b.call({ action: 'adminDashboard', token: b.token });
  assert.equal(result.users.length, 2);
  assert.equal(JSON.stringify(result).includes('password-123'), false);
  assert.equal(JSON.stringify(result).includes('v1$'), false);
  assert.equal(result.users.some(user => Object.hasOwn(user, 'password') || Object.hasOwn(user, 'sessionVersion')), false);
  assert.match(b.sheets.get('Users').rows[2][1], /^v1\$120000\$/);
  b.sheets.get('Users').rows[2][2] = 'user';
  b.context.setupAdminSheets();
  assert.equal(b.sheets.get('Users').rows[2][2], 'standard');
  assert.equal(b.context.login('alice', 'password-123').ok, true);
  assert.equal(b.call({ action: 'recordAiUsage', token: b.token }).ok, false);
});

test('role changes, resets, locking and revocation invalidate existing sessions', () => {
  const b = backend();
  b.manage({ operation: 'create', username: 'alice', password: 'password-123', role: 'Standard' });
  let login = b.context.login('alice', 'password-123');
  assert.equal(b.manage({ operation: 'update', username: 'alice', role: 'Vip', status: 'active' }).ok, true);
  assert.equal(b.context.getSession(login.token).ok, false);
  login = b.context.login('alice', 'password-123');
  assert.equal(login.role, 'vip');
  b.manage({ operation: 'resetPassword', username: 'alice', password: 'new-password-456' });
  assert.equal(b.context.getSession(login.token).ok, false);
  assert.equal(b.context.login('alice', 'password-123').ok, false);
  login = b.context.login('alice', 'new-password-456');
  assert.equal(login.ok, true);
  b.manage({ operation: 'revokeSessions', username: 'alice' });
  assert.equal(b.context.getSession(login.token).ok, false);
  b.manage({ operation: 'update', username: 'alice', role: 'vip', status: 'disabled' });
  assert.equal(b.context.login('alice', 'new-password-456').ok, false);
  assert.equal(b.manage({ operation: 'update', username: 'owner', role: 'standard', status: 'active' }).ok, false);
  assert.equal(b.manage({ operation: 'update', username: 'owner', role: 'admin', status: 'disabled' }).ok, false);
});

test('server checks live role and status even for existing sessions', () => {
  const b = backend();
  b.manage({ operation: 'create', username: 'second', password: 'password-123', role: 'Admin' });
  const second = b.context.login('second', 'password-123');
  b.sheets.get('Users').rows[2][2] = 'vip';
  assert.equal(b.call({ action: 'adminDashboard', token: second.token }).code, 'FORBIDDEN');
  b.sheets.get('Users').rows[2][3] = 'disabled';
  assert.equal(b.context.getSession(second.token).ok, false);
});

test('deletion requires admin and exact confirmation, revokes access and preserves history', () => {
  const b = backend();
  b.manage({ operation: 'create', username: 'alice', password: 'password-123', role: 'standard' });
  const login = b.context.login('alice', 'password-123');
  b.context.recordAiUsage_('alice', 'model', 12, 3, 'req-delete');
  assert.equal(b.call({ action: 'adminManageUser', token: login.token, operation: 'delete', username: 'owner', confirmUsername: 'owner' }).code, 'FORBIDDEN');
  assert.equal(b.manage({ operation: 'delete', username: 'alice' }).ok, false);
  assert.equal(b.manage({ operation: 'delete', username: 'alice', confirmUsername: 'wrong' }).ok, false);
  assert.equal(b.manage({ operation: 'delete', username: 'owner', confirmUsername: 'owner' }).ok, false);
  assert.equal(b.manage({ operation: 'delete', username: 'alice', confirmUsername: 'alice' }).ok, true);
  assert.equal(b.context.getSession(login.token).ok, false);
  assert.equal(b.context.login('alice', 'password-123').ok, false);
  const dashboard = b.call({ action: 'adminDashboard', token: b.token });
  assert.equal(dashboard.users.length, 1);
  assert.equal(dashboard.usage.inputTokens, 12);
  assert.equal(dashboard.audit[0].action, 'delete');
  assert.equal(dashboard.audit[0].target, 'alice');
  assert.equal(b.manage({ operation: 'delete', username: 'alice', confirmUsername: 'alice' }).ok, false);
  b.manage({ operation: 'create', username: 'alice', password: 'new-password', role: 'vip' });
  assert.equal(b.context.getSession(login.token).ok, false);
});

test('token aggregation is exact, deduplicated and audit excludes credentials', () => {
  const b = backend();
  b.context.recordAiUsage_('owner', 'demo-model', 120, 35, 'req-1');
  b.context.recordAiUsage_('owner', 'demo-model', 120, 35, 'req-1');
  b.context.recordAiUsage_('owner', 'demo-model', 10, 7, 'req-2');
  assert.throws(() => b.context.recordAiUsage_('owner', 'model', -1, 0, 'req-bad'));
  b.manage({ operation: 'create', username: 'alice', password: 'secret-password', role: 'vip' });
  const result = b.call({ action: 'adminDashboard', token: b.token });
  assert.deepEqual(result.usage, { inputTokens: 130, outputTokens: 42, requests: 2 });
  assert.deepEqual(result.users[0].usage, result.usage);
  assert.equal(result.audit[0].action, 'create');
  assert.equal(JSON.stringify(result.audit).includes('secret-password'), false);
  const reset = b.manage({ operation: 'resetPassword', username: 'owner', password: 'owner-new-password' });
  assert.equal(reset.sessionRevoked, true);
  assert.equal(b.context.getSession(b.token).ok, false);
});

test('OpenRouter backend enforces auth, locks paid models, records usage and hides API key', () => {
  const b = backend();
  const properties = new Map([['OPENROUTER_API_KEY', 'sk-or-secret-test-key']]);
  b.context.PropertiesService = { getScriptProperties: () => ({ getProperty: key => properties.get(key) }) };
  let fetchCalls = 0;
  let force401 = false;
  b.context.UrlFetchApp = { fetch(url, options) {
    fetchCalls += 1;
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer sk-or-secret-test-key');
    if (force401) return { getResponseCode: () => 401, getContentText: () => '{}' };
    const body = JSON.parse(options.payload);
    assert.equal(body.model, 'openrouter/free');
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        id: 'gen-test-123',
        model: 'google/gemma-4-26b-a4b-it:free',
        choices: [{ message: { content: 'Xin chào từ Auto Free!' } }],
        usage: { prompt_tokens: 15, completion_tokens: 25 }
      })
    };
  } };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script/OpenRouter.gs'), 'utf8'), b.context);

  const unauth = b.call({ action: 'aiChat', token: 'invalid', modelKey: 'auto', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(unauth.ok, false);
  assert.equal(fetchCalls, 0);

  const locked = b.call({ action: 'aiChat', token: b.token, modelKey: 'gpt-oss-120b', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(locked.ok, false);
  assert.equal(fetchCalls, 0);

  const okRes = b.call({ action: 'aiChat', token: b.token, modelKey: 'auto', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(okRes.ok, true);
  assert.equal(okRes.reply, 'Xin chào từ Auto Free!');
  assert.equal(okRes.model, 'google/gemma-4-26b-a4b-it:free');
  assert.equal(okRes.dailyUsed, 1);
  assert.equal(fetchCalls, 1);

  const dashboard = b.call({ action: 'adminDashboard', token: b.token });
  assert.deepEqual(dashboard.usage, { inputTokens: 15, outputTokens: 25, requests: 1 });

  force401 = true;
  const errRes = b.call({ action: 'aiChat', token: b.token, modelKey: 'auto', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(errRes.ok, false);
  assert.equal(JSON.stringify(errRes).includes('sk-or-secret-test-key'), false);

  // Admin can update daily limit dynamically and non-admins cannot.
  b.context.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: key => properties.get(key),
      setProperty: (key, val) => properties.set(key, val)
    })
  };
  b.manage({ operation: 'create', username: 'member', password: 'member-password', role: 'standard' });
  const memberLogin = b.context.login('member', 'member-password');
  assert.equal(b.call({ action: 'adminSetDailyLimit', token: memberLogin.token, dailyLimit: 10 }).code, 'FORBIDDEN');
  const setLimit = b.call({ action: 'adminSetDailyLimit', token: b.token, dailyLimit: 1 });
  assert.equal(setLimit.ok, true);
  assert.equal(setLimit.dailyLimit, 1);
  assert.equal(b.call({ action: 'adminDashboard', token: b.token }).dailyLimit, 1);
  assert.equal(b.context.getSession(b.token).user.dailyLimit, 1);
  // Owner already used 1 request today, so next aiChat must be blocked at limit 1 with QUOTA_EXCEEDED.
  const blocked = b.call({ action: 'aiChat', token: b.token, modelKey: 'auto', messages: [{ role: 'user', content: 'hi again' }] });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'QUOTA_EXCEEDED');
  assert.equal(blocked.dailyUsed, 1);
  assert.equal(blocked.remaining, 0);
});

test('server-side daily quota handles reserve/rollback, concurrency, idempotency and timezone rollover', () => {
  const b = backend();
  const properties = new Map([
    ['OPENROUTER_API_KEY', 'sk-or-secret-test-key'],
    ['DAILY_REQUEST_LIMIT', '2'],
    ['QUOTA_TIMEZONE', 'Asia/Ho_Chi_Minh']
  ]);
  b.context.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: key => properties.get(key),
      setProperty: (key, val) => properties.set(key, val)
    })
  };

  let fetchCalls = 0;
  let failNext = false;
  let concurrentHook = null;
  b.context.UrlFetchApp = {
    fetch() {
      fetchCalls += 1;
      if (concurrentHook) {
        const hook = concurrentHook;
        concurrentHook = null;
        hook();
      }
      if (failNext) {
        failNext = false;
        return { getResponseCode: () => 500, getContentText: () => '{}' };
      }
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({
          id: 'gen-' + fetchCalls,
          model: 'google/gemma-4-26b-a4b-it:free',
          choices: [{ message: { content: 'Reply #' + fetchCalls } }],
          usage: { prompt_tokens: 10, completion_tokens: 20 }
        })
      };
    }
  };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script/OpenRouter.gs'), 'utf8'), b.context);

  // 1. Under limit (0 -> 1 / 2)
  const reqId1 = 'req-' + crypto.randomUUID();
  const r1 = b.call({ action: 'aiChat', token: b.token, modelKey: 'auto', clientRequestId: reqId1, messages: [{ role: 'user', content: '1' }] });
  assert.equal(r1.ok, true);
  assert.equal(r1.dailyUsed, 1);
  assert.equal(r1.remaining, 1);

  // 2. Duplicate/retry with same clientRequestId returns cached reply without calling AI or charging quota again.
  const callsBeforeDup = fetchCalls;
  const r1Dup = b.call({ action: 'aiChat', token: b.token, modelKey: 'auto', clientRequestId: reqId1, messages: [{ role: 'user', content: '1' }] });
  assert.equal(r1Dup.ok, true);
  assert.equal(r1Dup.reply, r1.reply);
  assert.equal(fetchCalls, callsBeforeDup);
  assert.equal(b.call({ action: 'getQuota', token: b.token }).dailyUsed, 1);

  // 3. Failed AI request rolls back reserved slot so dailyUsed stays 1.
  failNext = true;
  const rFail = b.call({ action: 'aiChat', token: b.token, modelKey: 'auto', clientRequestId: 'req-' + crypto.randomUUID(), messages: [{ role: 'user', content: 'fail' }] });
  assert.equal(rFail.ok, false);
  assert.equal(rFail.dailyUsed, 1);
  assert.equal(rFail.remaining, 1);

  // 4. Two concurrent requests at limit - 1 (1 used of 2): in-flight reservation blocks the 2nd request!
  let concurrentResult = null;
  concurrentHook = () => {
    concurrentResult = b.call({
      action: 'aiChat',
      token: b.token,
      modelKey: 'auto',
      clientRequestId: 'req-' + crypto.randomUUID(),
      messages: [{ role: 'user', content: 'concurrent' }]
    });
  };
  const r2 = b.call({ action: 'aiChat', token: b.token, modelKey: 'auto', clientRequestId: 'req-' + crypto.randomUUID(), messages: [{ role: 'user', content: '2' }] });
  assert.equal(r2.ok, true);
  assert.equal(r2.dailyUsed, 2);
  assert.equal(r2.remaining, 0);
  assert.equal(concurrentResult.ok, false);
  assert.equal(concurrentResult.code, 'QUOTA_EXCEEDED');

  // 5. Exceeded limit rejects immediately.
  const r3 = b.call({ action: 'aiChat', token: b.token, modelKey: 'auto', clientRequestId: 'req-' + crypto.randomUUID(), messages: [{ role: 'user', content: '3' }] });
  assert.equal(r3.ok, false);
  assert.equal(r3.code, 'QUOTA_EXCEEDED');

  // 6. Configured timezone rollover: 16:59Z vs 17:01Z in Asia/Ho_Chi_Minh (UTC+7) crosses midnight.
  assert.equal(b.context.getQuotaDateKey_(new Date('2026-11-25T16:59:00Z')), '2026-11-25');
  assert.equal(b.context.getQuotaDateKey_(new Date('2026-11-25T17:01:00Z')), '2026-11-26');

  // 7. DailyQuota updates the existing row in-place (header + 1 user row) and handles Date-typed dateKey cells.
  const quotaSheet = b.sheets.get('DailyQuota');
  assert.equal(quotaSheet.rows.length, 2);
  assert.deepEqual(quotaSheet.rows[0], ['username', 'dateKey', 'usedCount', 'updatedAt']);
  // Simulate Google Sheets converting dateKey cell to a Date object.
  quotaSheet.rows[1][1] = new Date(String(quotaSheet.rows[1][1]).replace(/^'/, '') + 'T00:00:00+07:00');
  properties.set('DAILY_REQUEST_LIMIT', '3');
  const r4 = b.call({ action: 'aiChat', token: b.token, modelKey: 'auto', clientRequestId: 'req-' + crypto.randomUUID(), messages: [{ role: 'user', content: '4' }] });
  assert.equal(r4.ok, true);
  assert.equal(r4.dailyUsed, 3);
  assert.equal(quotaSheet.rows.length, 2);
  assert.equal(quotaSheet.rows[1][2], 3);
});

test('login rate limiting blocks brute force after 5 failed attempts and resets on success', () => {
  const b = backend();
  b.manage({ operation: 'create', username: 'alice', password: 'correct-password', role: 'standard' });
  b.manage({ operation: 'create', username: 'bob', password: 'bob-password', role: 'standard' });

  // 4 failed attempts for alice, then 1 success should reset counter.
  for (let i = 0; i < 4; i += 1) {
    const res = b.context.login('alice', 'wrong-' + i);
    assert.equal(res.ok, false);
    assert.notEqual(res.code, 'TOO_MANY_ATTEMPTS');
  }
  const okLogin = b.context.login('alice', 'correct-password');
  assert.equal(okLogin.ok, true);

  // 5 consecutive failed attempts lock alice out even for the right password.
  for (let i = 0; i < 4; i += 1) {
    const res = b.context.login('alice', 'bad-' + i);
    assert.equal(res.ok, false);
    assert.notEqual(res.code, 'TOO_MANY_ATTEMPTS');
  }
  const fifth = b.context.login('alice', 'bad-4');
  assert.equal(fifth.ok, false);
  assert.equal(fifth.code, 'TOO_MANY_ATTEMPTS');

  const lockedOut = b.context.login('alice', 'correct-password');
  assert.equal(lockedOut.ok, false);
  assert.equal(lockedOut.code, 'TOO_MANY_ATTEMPTS');

  // Bob is unaffected by alice's lockout.
  assert.equal(b.context.login('bob', 'bob-password').ok, true);
});

test('login avoids locks, full sheet scans and sync writes while preserving lastLogin and self-healing row index', () => {
  const stats = { locks: 0, dataRangeReads: new Map(), rangeReads: new Map(), writes: new Map() };
  class InstrumentedSheet {
    constructor(name) { this.name = name; this.rows = []; }
    getLastRow() { return this.rows.length; }
    appendRow(row) { this.rows.push([...row]); }
    deleteRow(row) { this.rows.splice(row - 1, 1); }
    setFrozenRows() {}
    getDataRange() {
      stats.dataRangeReads.set(this.name, (stats.dataRangeReads.get(this.name) || 0) + 1);
      const width = Math.max(1, ...this.rows.map(row => row.length));
      return this.getRange(1, 1, Math.max(1, this.rows.length), width, true);
    }
    getRange(row, col, height = 1, width = 1, fromDataRange = false) {
      return {
        getValues: () => {
          if (!fromDataRange) stats.rangeReads.set(this.name, (stats.rangeReads.get(this.name) || 0) + 1);
          return Array.from({ length: height }, (_, i) => Array.from({ length: width }, (_, j) => this.rows[row - 1 + i]?.[col - 1 + j] ?? ''));
        },
        setValue: value => {
          stats.writes.set(this.name, (stats.writes.get(this.name) || 0) + 1);
          this.rows[row - 1] ||= [];
          this.rows[row - 1][col - 1] = value;
        },
        setValues: values => {
          stats.writes.set(this.name, (stats.writes.get(this.name) || 0) + 1);
          values.forEach((line, i) => line.forEach((value, j) => { this.rows[row - 1 + i] ||= []; this.rows[row - 1 + i][col - 1 + j] = value; }));
        }
      };
    }
  }

  const sheets = new Map();
  const spreadsheet = {
    getSheetByName: name => sheets.get(name),
    insertSheet: name => { const sheet = new InstrumentedSheet(name); sheets.set(name, sheet); return sheet; }
  };
  const cache = new Map();
  let locked = false;
  const context = vm.createContext({
    console: { error() {} },
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet },
    LockService: { getScriptLock: () => ({ waitLock() { assert.equal(locked, false); locked = true; stats.locks += 1; }, releaseLock() { locked = false; } }) },
    CacheService: {
      getScriptCache: () => ({
        put: (key, value) => cache.set(key, value),
        putAll: entries => Object.entries(entries).forEach(([k, v]) => cache.set(k, v)),
        get: key => cache.get(key),
        getAll: keys => Object.fromEntries(keys.filter(k => cache.has(k)).map(k => [k, cache.get(k)])),
        remove: key => cache.delete(key)
      })
    },
    ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: text => ({ text, setMimeType() { return this; } }) },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      newBlob: text => ({ getBytes: () => [...Buffer.from(text)] }),
      computeHmacSha256Signature: (data, key) => [...crypto.createHmac('sha256', Buffer.from(key)).update(Buffer.from(data)).digest()],
      computeDigest: (_, text) => [...crypto.createHash('sha256').update(text).digest()],
      DigestAlgorithm: { SHA_256: 'sha256' }
    }
  });
  for (const name of ['Code.gs', 'Admin.gs']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script', name), 'utf8'), context);
  context.setupAdminSheets();
  context.createUser('owner', 'owner-password', 'Admin');
  context.createUser('alice', 'alice-password', 'standard');
  context.createUser('bob', 'bob-password', 'vip');
  const ownerToken = context.login('owner', 'owner-password').token;

  const resetStats = () => {
    stats.locks = 0;
    stats.dataRangeReads.clear();
    stats.rangeReads.clear();
    stats.writes.clear();
  };

  // Cold login warms the Users row index and quota cache for all users.
  resetStats();
  const aliceCold = context.login('alice', 'alice-password');
  assert.equal(aliceCold.ok, true);
  assert.equal(stats.locks, 0);
  assert.equal(stats.writes.get('Users') || 0, 0);
  assert.equal(stats.dataRangeReads.get('Usage') || 0, 0);

  // Warm login for another user (bob) uses cached Users index (1-row read) and skips DailyQuota/Usage scans after first warm.
  const bobWarm1 = context.login('bob', 'bob-password');
  assert.equal(bobWarm1.ok, true);
  resetStats();
  const bobWarm2 = context.login('bob', 'bob-password');
  assert.equal(bobWarm2.ok, true);
  assert.equal(stats.locks, 0);
  assert.equal(stats.writes.get('Users') || 0, 0);
  assert.equal(stats.dataRangeReads.get('Users') || 0, 0);
  assert.equal(stats.rangeReads.get('Users'), 1);
  assert.equal(stats.dataRangeReads.get('DailyQuota') || 0, 0);
  assert.equal(stats.rangeReads.get('DailyQuota') || 0, 0);
  assert.equal(stats.dataRangeReads.get('Usage') || 0, 0);
  assert.equal(stats.rangeReads.get('Usage') || 0, 0);

  // Warm getSession also reads only 1 row from Users and 0 from DailyQuota/Usage.
  resetStats();
  const bobSession = context.getSession(bobWarm2.token);
  assert.equal(bobSession.ok, true);
  assert.equal(bobSession.user.role, 'vip');
  assert.equal(stats.dataRangeReads.get('Users') || 0, 0);
  assert.equal(stats.rangeReads.get('Users'), 1);
  assert.equal(stats.rangeReads.get('DailyQuota') || 0, 0);
  assert.equal(stats.rangeReads.get('Usage') || 0, 0);

  // adminDashboard returns cached lastLogin immediately and persists it once to Users.
  const dash1 = JSON.parse(context.doPost({ postData: { contents: JSON.stringify({ action: 'adminDashboard', token: ownerToken }) } }).text);
  assert.equal(dash1.ok, true);
  const bobRowInfo = dash1.users.find(u => u.username === 'bob');
  assert.ok(bobRowInfo.lastLogin);
  assert.equal(sheets.get('Users').rows[3][6], bobRowInfo.lastLogin);

  resetStats();
  const dash2 = JSON.parse(context.doPost({ postData: { contents: JSON.stringify({ action: 'adminDashboard', token: ownerToken }) } }).text);
  assert.equal(dash2.ok, true);
  assert.equal(stats.locks, 0);
  assert.equal(stats.writes.get('Users') || 0, 0);

  // Manual row deletion directly on Users shifts bob from row 4 to row 3; cached row hint self-heals on mismatch.
  sheets.get('Users').deleteRow(3); // Delete alice directly without adminManageUser_
  assert.equal(context.login('alice', 'alice-password').ok, false);
  const bobAfterShift = context.login('bob', 'bob-password');
  assert.equal(bobAfterShift.ok, true);
  assert.equal(bobAfterShift.role, 'vip');
  assert.equal(typeof bobAfterShift.timing.totalMs, 'number');
  assert.equal(bobAfterShift.timing.totalMs >= 0, true);
});

test('pure-JS PBKDF2-HMAC-SHA-256 matches Node crypto.pbkdf2Sync across ASCII, long and UTF-8 passwords', () => {
  const b = backend();
  const saltHex = '0123456789abcdef0123456789abcdef';
  const samples = [
    'test-password',
    'Mật khẩu tiếng Việt có dấu 🔐🚀 và ký tự đặc biệt !@#$%',
    'a-very-long-password-exceeding-the-64-byte-hmac-sha256-block-size-to-force-key-hashing-1234567890'
  ];
  for (const pwd of samples) {
    const expected12k = crypto.pbkdf2Sync(pwd, Buffer.from(saltHex, 'hex'), 12000, 32, 'sha256').toString('hex');
    assert.equal(b.context.hashPassword_(pwd, saltHex, 12000), expected12k);
    const expected120k = crypto.pbkdf2Sync(pwd, Buffer.from(saltHex, 'hex'), 120000, 32, 'sha256').toString('hex');
    assert.equal(b.context.hashPassword_(pwd, saltHex), expected120k);
  }
});

test('F-01: global login failure ceiling blocks multi-username password spraying and applies backoff', () => {
  const b = backend();
  for (let i = 0; i < 6; i += 1) {
    b.manage({ operation: 'create', username: 'user' + i, password: 'correct-password', role: 'standard' });
  }

  // Spread 25 failed attempts across 6 different usernames (never hitting 5 on any single username!).
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const uname = 'user' + (attempt % 6);
    const res = b.context.login(uname, 'wrong-password-' + attempt);
    assert.equal(res.ok, false);
    if (attempt < 24) {
      assert.notEqual(res.code, 'TOO_MANY_ATTEMPTS');
    }
  }

  // 26th attempt on a completely fresh username is blocked by the global login failure limit.
  const blocked = b.context.login('user5', 'correct-password');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'TOO_MANY_ATTEMPTS');

  // Exponential backoff calculation grows with repeated failures past maxLoginAttempts.
  assert.equal(b.context.computeLoginLockSeconds_(5), 300);
  assert.equal(b.context.computeLoginLockSeconds_(6), 600);
  assert.equal(b.context.computeLoginLockSeconds_(7), 1200);
});

test('F-02: legacy v1$12000 password hashes verify and automatically upgrade to v1$120000 on login', () => {
  const b = backend();
  b.manage({ operation: 'create', username: 'legacyuser', password: 'legacy-password-123', role: 'standard' });
  const usersSheet = b.sheets.get('Users');
  const saltHex = 'abcdef0123456789abcdef0123456789';
  const legacyHash = crypto.pbkdf2Sync('legacy-password-123', Buffer.from(saltHex, 'hex'), 12000, 32, 'sha256').toString('hex');
  usersSheet.rows[2][1] = 'v1$12000$' + saltHex + '$' + legacyHash;

  const firstLogin = b.context.login('legacyuser', 'legacy-password-123');
  assert.equal(firstLogin.ok, true);
  assert.match(usersSheet.rows[2][1], /^v1\$120000\$/);

  const secondLogin = b.context.login('legacyuser', 'legacy-password-123');
  assert.equal(secondLogin.ok, true);
  assert.equal(b.context.login('legacyuser', 'wrong-password').ok, false);
});

test('F-03: durable QuotaReservations enforce concurrency and idempotency even if CacheService is wiped, and reconcile expired slots', () => {
  const sheets = new Map();
  class Sheet {
    constructor() { this.rows = []; }
    getLastRow() { return this.rows.length; }
    appendRow(row) { this.rows.push([...row]); }
    deleteRow(row) { this.rows.splice(row - 1, 1); }
    setFrozenRows() {}
    getDataRange() {
      const width = Math.max(1, ...this.rows.map(row => row.length));
      return this.getRange(1, 1, Math.max(1, this.rows.length), width);
    }
    getRange(row, col, height = 1, width = 1) {
      return {
        getValues: () => Array.from({ length: height }, (_, i) => Array.from({ length: width }, (_, j) => this.rows[row - 1 + i]?.[col - 1 + j] ?? '')),
        setValue: value => { this.rows[row - 1] ||= []; this.rows[row - 1][col - 1] = value; },
        setValues: values => values.forEach((line, i) => line.forEach((value, j) => { this.rows[row - 1 + i] ||= []; this.rows[row - 1 + i][col - 1 + j] = value; }))
      };
    }
  }
  const spreadsheet = { getSheetByName: name => sheets.get(name), insertSheet: name => { const sheet = new Sheet(); sheets.set(name, sheet); return sheet; } };
  const cache = new Map();
  let locked = false;
  const properties = new Map([
    ['OPENROUTER_API_KEY', 'sk-or-secret-test-key'],
    ['DAILY_REQUEST_LIMIT', '1']
  ]);

  let concurrentHook = null;
  const context = vm.createContext({
    console: { error() {} },
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet },
    LockService: { getScriptLock: () => ({ waitLock() { assert.equal(locked, false); locked = true; }, releaseLock() { locked = false; } }) },
    CacheService: { getScriptCache: () => ({ put: (k, v) => cache.set(k, v), putAll: entries => Object.entries(entries).forEach(([k, v]) => cache.set(k, v)), get: k => cache.get(k), getAll: keys => Object.fromEntries(keys.filter(k => cache.has(k)).map(k => [k, cache.get(k)])), remove: k => cache.delete(k) }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => properties.get(k) }) },
    ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: text => ({ text, setMimeType() { return this; } }) },
    UrlFetchApp: {
      fetch() {
        if (concurrentHook) {
          const hook = concurrentHook;
          concurrentHook = null;
          hook();
        }
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            id: 'gen-durable-1',
            model: 'google/gemma-4-26b-a4b-it:free',
            choices: [{ message: { content: 'Durable reply' } }],
            usage: { prompt_tokens: 10, completion_tokens: 20 }
          })
        };
      }
    },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      newBlob: text => ({ getBytes: () => [...Buffer.from(text)] }),
      computeHmacSha256Signature: (data, key) => [...crypto.createHmac('sha256', Buffer.from(key)).update(Buffer.from(data)).digest()],
      computeDigest: (_, text) => [...crypto.createHash('sha256').update(text).digest()],
      DigestAlgorithm: { SHA_256: 'sha256' }
    }
  });
  for (const name of ['Code.gs', 'Admin.gs', 'OpenRouter.gs']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script', name), 'utf8'), context);
  context.setupAdminSheets();
  context.createUser('owner', 'test-password', 'Admin');
  const token = context.login('owner', 'test-password').token;
  const call = data => JSON.parse(context.doPost({ postData: { contents: JSON.stringify(data) } }).text);

  // Seed an already-expired PENDING reservation in QuotaReservations to confirm stale slots are reclaimed.
  const resSheet = sheets.get('QuotaReservations');
  const todayKey = context.getQuotaDateKey_();
  resSheet.appendRow(['stale-1', 'owner', "'" + todayKey, 'stale-req-1', 'PENDING', new Date(Date.now() - 10000).toISOString(), new Date(Date.now() - 400000).toISOString(), '']);

  const reqId = 'req-' + crypto.randomUUID();
  let concurrentBlocked = null;
  let duplicatePending = null;
  const sessionKeyHash = [...crypto.createHash('sha256').update(token).digest()].map(v => (v & 255).toString(16).padStart(2, '0')).join('');
  const savedSessionValue = cache.get('auth:' + sessionKeyHash);

  concurrentHook = () => {
    // Wipe CacheService mid-flight (preserving only the login session token) to simulate eviction!
    cache.clear();
    cache.set('auth:' + sessionKeyHash, savedSessionValue);
    concurrentBlocked = call({ action: 'aiChat', token, modelKey: 'auto', clientRequestId: 'req-' + crypto.randomUUID(), messages: [{ role: 'user', content: '2' }] });
    duplicatePending = call({ action: 'aiChat', token, modelKey: 'auto', clientRequestId: reqId, messages: [{ role: 'user', content: '1' }] });
  };

  const first = call({ action: 'aiChat', token, modelKey: 'auto', clientRequestId: reqId, messages: [{ role: 'user', content: '1' }] });
  assert.equal(first.ok, true);
  assert.equal(first.dailyUsed, 1);
  assert.equal(concurrentBlocked.ok, false);
  assert.equal(concurrentBlocked.code, 'QUOTA_EXCEEDED');
  assert.equal(duplicatePending.ok, false);
  assert.equal(duplicatePending.code, 'DUPLICATE_REQUEST');
  assert.equal(resSheet.rows[1][4], 'EXPIRED');
  assert.equal(resSheet.rows[2][4], 'DONE');

  // Even after another full cache wipe, duplicate retry with same clientRequestId returns stored DONE response!
  cache.clear();
  cache.set('auth:' + sessionKeyHash, savedSessionValue);
  const retryAfterEviction = call({ action: 'aiChat', token, modelKey: 'auto', clientRequestId: reqId, messages: [{ role: 'user', content: '1' }] });
  assert.equal(retryAfterEviction.ok, true);
  assert.equal(retryAfterEviction.reply, 'Durable reply');
  assert.equal(retryAfterEviction.dailyUsed, 1);
});

test('OpenRouter retries fallback model when auto router leaks unexpected CJK characters in Vietnamese reply', () => {
  const b = backend();
  const properties = new Map([
    ['OPENROUTER_API_KEY', 'sk-or-secret-test-key'],
    ['DAILY_REQUEST_LIMIT', '10']
  ]);
  b.context.PropertiesService = { getScriptProperties: () => ({ getProperty: k => properties.get(k) }) };
  const requestedModels = [];
  b.context.UrlFetchApp = {
    fetch(_url, options) {
      const payload = JSON.parse(options.payload);
      requestedModels.push(payload.model);
      if (payload.model === 'openrouter/free') {
        const isTranslation = payload.messages.some(m => m.role === 'user' && m.content.includes('tiếng Trung'));
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            id: 'gen-cjk-' + requestedModels.length,
            model: 'nvidia/nemotron-3-super-120b-a12b:free',
            choices: [{ message: { content: isTranslation ? 'Xin chào là 你好.' : 'Có thể dùng subdomain免费 nhé.' } }],
            usage: { prompt_tokens: 10, completion_tokens: 12 }
          })
        };
      }
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({
          id: 'gen-clean-' + requestedModels.length,
          model: 'google/gemma-4-26b-a4b-it:free',
          choices: [{ message: { content: 'Bạn có thể dùng subdomain miễn phí nhé.' } }],
          usage: { prompt_tokens: 10, completion_tokens: 12 }
        })
      };
    }
  };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script/OpenRouter.gs'), 'utf8'), b.context);

  // Normal Vietnamese prompt with leaked CJK falls back to Gemma and returns clean Vietnamese.
  const cleanRes = b.call({ action: 'aiChat', token: b.token, modelKey: 'auto', messages: [{ role: 'user', content: 'Tư vấn giúp mình tạo web' }] });
  assert.equal(cleanRes.ok, true);
  assert.equal(cleanRes.reply, 'Bạn có thể dùng subdomain miễn phí nhé.');
  assert.deepEqual(requestedModels, ['openrouter/free', 'google/gemma-4-26b-a4b-it:free']);

  // Explicit Chinese translation request preserves CJK without unnecessary fallback.
  requestedModels.length = 0;
  const translationRes = b.call({ action: 'aiChat', token: b.token, modelKey: 'auto', messages: [{ role: 'user', content: 'Dịch xin chào sang tiếng Trung giúp mình' }] });
  assert.equal(translationRes.ok, true);
  assert.equal(translationRes.reply, 'Xin chào là 你好.');
  assert.deepEqual(requestedModels, ['openrouter/free']);
});
