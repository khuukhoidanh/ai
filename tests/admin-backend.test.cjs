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
  const properties = new Map([['DISCORD_BOT_TOKEN', 'test-secret'], ['DISCORD_GUILD_ID', '100000000000000001']]);
  b.context.PropertiesService = { getScriptProperties: () => ({ getProperty: key => properties.get(key), setProperty: (key, value) => properties.set(key, value) }) };
  let sequence = 200000000000000000n;
  const channels = [], messages = new Map();
  let calls = 0, rateLimited = false;
  b.context.UrlFetchApp = { fetch(url, options) {
    calls++;
    assert.equal(options.headers.Authorization, 'Bot test-secret');
    const parsed = new URL(url), route = parsed.pathname.replace('/api/v10', '');
    const body = options.payload ? JSON.parse(options.payload) : null;
    let result;
    if (rateLimited) return { getResponseCode: () => 429, getContentText: () => '{}' };
    if (route === '/users/@me') result = { id: '100000000000000002', username: 'bot' };
    else if (route === '/guilds/100000000000000001') result = { id: '100000000000000001', name: 'Test server' };
    else if (route.endsWith('/channels')) {
      if (options.method === 'get') result = channels;
      else { result = { ...body, id: String(++sequence) }; channels.push(result); }
    } else {
      const channelId = route.split('/')[2];
      const saved = messages.get(channelId) || [];
      if (options.method === 'post') {
        assert.deepEqual(body.allowed_mentions, { parse: [] });
        result = { ...body, id: String(++sequence), author: { id: '100000000000000002' } };
        saved.push(result); messages.set(channelId, saved);
      } else {
        const before = parsed.searchParams.get('before');
        result = saved.filter(message => !before || BigInt(message.id) < BigInt(before)).slice().reverse().slice(0, 100);
      }
    }
    return { getResponseCode: () => 200, getContentText: () => JSON.stringify(result) };
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
