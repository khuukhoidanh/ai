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
  assert.match(b.sheets.get('Users').rows[2][1], /^v1\$12000\$/);
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

test('Discord history: private channels, ownership, idempotent saves and pagination', () => {
  const b = backend();
  const properties = new Map([['DISCORD_BRIDGE_URL', 'https://bridge.example.test'], ['DISCORD_BRIDGE_SECRET', 'test-secret']]);
  b.context.PropertiesService = { getScriptProperties: () => ({ getProperty: key => properties.get(key), setProperty: (key, value) => properties.set(key, value) }) };
  let sequence = 200000000000000000n;
  const channels = [], messages = new Map();
  let calls = 0, rateLimited = false;
  b.context.UrlFetchApp = { fetch(url, options) {
    calls++;
    assert.equal(options.headers['X-Bridge-Secret'], 'test-secret');
    assert.equal(url.startsWith('https://bridge.example.test/api/discord/'), true);
    const route = new URL(url).pathname;
    const body = options.payload ? JSON.parse(options.payload) : {};
    if (rateLimited) return { getResponseCode: () => 429, getContentText: () => JSON.stringify({ ok: false, message: 'Discord đang giới hạn tốc độ.' }) };
    if (route === '/api/discord/setup') {
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: true, botId: '100000000000000002', bot: 'bot', server: 'Test server' }) };
    }
    if (route === '/api/discord/channels/ensure') {
      const marker = 'chatbot:' + body.ownerId + ':' + body.chatId;
      let ch = channels.find(item => item.type === 0 && item.topic === marker);
      if (!ch) {
        const permissions = [{ id: '100000000000000001', type: 0, allow: '0', deny: '1024' }, { id: '100000000000000002', type: 1, allow: '85008', deny: '0' }];
        const cat = { id: String(++sequence), type: 4, permission_overwrites: permissions };
        ch = { id: String(++sequence), type: 0, parent_id: cat.id, topic: marker, permission_overwrites: permissions };
        channels.push(cat, ch);
      }
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: true, categoryId: ch.parent_id, channelId: ch.id }) };
    }
    if (route === '/api/discord/messages/save') {
      const savedList = messages.get(body.channelId) || [];
      const saved = body.messages.map(msg => {
        const discordId = String(++sequence);
        savedList.push({ id: discordId, messageId: msg.id, role: msg.role, text: msg.text, createdAt: msg.createdAt });
        return { messageId: msg.id, discordId };
      });
      messages.set(body.channelId, savedList);
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: true, saved }) };
    }
    if (route === '/api/discord/messages/load') {
      const savedList = messages.get(body.channelId) || [];
      const page = savedList.filter(m => !body.before || BigInt(m.id) < BigInt(body.before)).slice().reverse().slice(0, 100);
      const before = page.length === 100 ? page[page.length - 1].id : null;
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({
        ok: true,
        messages: page.slice().reverse().map(m => ({ id: m.messageId, role: m.role, text: m.text, createdAt: m.createdAt })),
        before
      }) };
    }
    return { getResponseCode: () => 404, getContentText: () => '{}' };
  } };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script/Discord.gs'), 'utf8'), b.context);
  b.context.setupDiscordStorage();
  const chat = { id: crypto.randomUUID(), title: 'Saved test', messages: [{ id: crypto.randomUUID(), role: 'user', text: '@everyone hello', createdAt: Date.now() }] };
  const save = () => b.call({ action: 'discordSave', token: b.token, chat });
  assert.equal(save().ok, true);
  assert.equal(save().ok, true);
  assert.equal(channels.length, 2);
  assert.equal(channels[0].permission_overwrites[0].deny, '1024');
  assert.equal(messages.get(channels[1].id).length, 1);
  const loaded = b.call({ action: 'discordLoad', token: b.token, chatId: chat.id });
  assert.equal(loaded.messages[0].text, '@everyone hello');
  assert.equal(loaded.before, null);
  b.manage({ operation: 'create', username: 'other', password: 'password-123', role: 'standard' });
  const other = b.context.login('other', 'password-123');
  assert.equal(b.call({ action: 'discordLoad', token: other.token, chatId: chat.id }).ok, false);
  assert.equal(b.call({ action: 'discordList', token: other.token }).chats.length, 0);
  const previousCalls = calls;
  assert.equal(b.call({ action: 'discordSave', token: 'invalid', chat }).ok, false);
  assert.equal(calls, previousCalls);
  for (let i = 1; i < 105; i++) chat.messages.push({ id: crypto.randomUUID(), role: 'user', text: 'message ' + i, createdAt: Date.now() + i });
  while (save().remaining > 0) {}
  const first = b.call({ action: 'discordLoad', token: b.token, chatId: chat.id });
  assert.equal(first.messages.length, 100);
  const second = b.call({ action: 'discordLoad', token: b.token, chatId: chat.id, before: first.before });
  assert.equal(second.messages.length, 5);
  rateLimited = true;
  const failure = b.call({ action: 'discordLoad', token: b.token, chatId: chat.id });
  assert.equal(failure.ok, false);
  assert.equal(JSON.stringify(failure).includes('test-secret'), false);
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
