const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const path = require('node:path');

function makeAppsScriptBackend(options = {}) {
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
  const spreadsheet = {
    getSheetByName: name => sheets.get(name),
    insertSheet: name => { const sheet = new Sheet(); sheets.set(name, sheet); return sheet; }
  };
  const cache = new Map();
  const properties = new Map(Object.entries(options.properties || {}));
  const loggedErrors = [];
  let locked = false;

  const context = vm.createContext({
    console: { error: (...args) => loggedErrors.push(args.join(' ')) },
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet },
    LockService: {
      getScriptLock: () => ({
        waitLock() { assert.equal(locked, false, 'no nested locks'); locked = true; },
        releaseLock() { locked = false; }
      })
    },
    CacheService: {
      getScriptCache: () => ({
        put: (key, value) => cache.set(key, value),
        putAll: entries => Object.entries(entries).forEach(([k, v]) => cache.set(k, v)),
        get: key => cache.get(key),
        getAll: keys => Object.fromEntries(keys.filter(k => cache.has(k)).map(k => [k, cache.get(k)])),
        remove: key => cache.delete(key)
      })
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: key => properties.get(key),
        setProperty: (key, value) => properties.set(key, value)
      })
    },
    UrlFetchApp: options.urlFetchApp || {
      fetch() { throw new Error('network error'); }
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: text => ({ text, setMimeType() { return this; } })
    },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      newBlob: text => ({ getBytes: () => [...Buffer.from(text)] }),
      computeHmacSha256Signature: (data, key) => [...crypto.createHmac('sha256', Buffer.from(key)).update(Buffer.from(data)).digest()],
      computeDigest: (_, text) => [...crypto.createHash('sha256').update(text).digest()],
      DigestAlgorithm: { SHA_256: 'sha256' }
    }
  });

  for (const name of ['Code.gs', 'Admin.gs']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script', name), 'utf8'), context);
  }
  context.setupAdminSheets();
  const call = data => JSON.parse(context.doPost({ postData: { contents: JSON.stringify(data) } }).text);
  return { context, sheets, properties, loggedErrors, call };
}

test('Apps Script register verifies Discord membership directly, writes DiscordAccounts, prevents duplicates and hides bot token', () => {
  const botToken = 'bot-secret-token-xyz';
  const guildId = '123456789012345678';
  const fetchCalls = [];
  let discordMode = 'member';

  const b = makeAppsScriptBackend({
    properties: {
      DISCORD_GUILD_ID: guildId,
      DISCORD_BOT_TOKEN: botToken
    },
    urlFetchApp: {
      fetch(url, options) {
        fetchCalls.push({ url, options });
        if (discordMode === 'offline') throw new Error('Network error');
        if (discordMode === 'auth-error') return { getResponseCode: () => 401, getContentText: () => '{}' };
        if (discordMode === 'rate-limit') return { getResponseCode: () => 429, getContentText: () => '{}' };
        if (discordMode === 'not-member') return { getResponseCode: () => 404, getContentText: () => '{"code":10007}' };
        return { getResponseCode: () => 200, getContentText: () => '{"user":{"id":"987654321098765432"}}' };
      }
    }
  });

  // 1. Input validation rejects bad Discord ID, short password, mismatched passwords before calling Discord
  assert.equal(b.call({ action: 'register', discordId: 'abc', username: 'alice', password: 'password-123', confirmPassword: 'password-123' }).ok, false);
  assert.equal(b.call({ action: 'register', discordId: '123456789012345678', username: 'alice', password: 'short', confirmPassword: 'short' }).ok, false);
  assert.equal(b.call({ action: 'register', discordId: '123456789012345678', username: 'alice', password: 'password-123', confirmPassword: 'password-999' }).code, 'PASSWORD_MISMATCH');
  assert.equal(fetchCalls.length, 0);

  // 2. Missing/invalid ScriptProperties fails safely
  b.properties.set('DISCORD_GUILD_ID', 'invalid');
  const misconfigured = b.call({ action: 'register', discordId: '123456789012345678', username: 'alice', password: 'password-123', confirmPassword: 'password-123' });
  assert.equal(misconfigured.ok, false);
  assert.equal(misconfigured.code, 'REGISTRATION_UNAVAILABLE');
  assert.equal(fetchCalls.length, 0);
  b.properties.set('DISCORD_GUILD_ID', guildId);

  // 3. Discord network/auth errors fail safely without creating account
  for (const mode of ['offline', 'auth-error']) {
    discordMode = mode;
    const res = b.call({ action: 'register', discordId: '123456789012345678', username: 'alice', password: 'password-123', confirmPassword: 'password-123' });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'REGISTRATION_UNAVAILABLE');
    assert.equal(b.sheets.get('Users').rows.length, 1);
    assert.equal(b.sheets.get('DiscordAccounts').rows.length, 1);
  }

  // 4. Rate limit returns safe message without creating account
  discordMode = 'rate-limit';
  const rateRes = b.call({ action: 'register', discordId: '123456789012345678', username: 'alice', password: 'password-123', confirmPassword: 'password-123' });
  assert.equal(rateRes.ok, false);
  assert.equal(rateRes.code, 'DISCORD_RATE_LIMITED');
  assert.equal(b.sheets.get('Users').rows.length, 1);

  // 5. Not a Discord server member (404) fails with clear NOT_DISCORD_MEMBER message
  discordMode = 'not-member';
  const notMember = b.call({ action: 'register', discordId: '123456789012345678', username: 'alice', password: 'password-123', confirmPassword: 'password-123' });
  assert.equal(notMember.ok, false);
  assert.equal(notMember.code, 'NOT_DISCORD_MEMBER');
  assert.equal(b.sheets.get('Users').rows.length, 1);
  assert.equal(b.sheets.get('DiscordAccounts').rows.length, 1);

  // 6. Verified Discord member creates account in Users and records DiscordAccounts separately
  discordMode = 'member';
  const callsBeforeSuccess = fetchCalls.length;
  const created = b.call({ action: 'register', discordId: '987654321098765432', username: 'alice', password: 'password-123', confirmPassword: 'password-123' });
  assert.equal(created.ok, true);
  assert.equal(created.username, 'alice');
  assert.equal(
    fetchCalls[callsBeforeSuccess].url,
    'https://discord.com/api/v10/guilds/123456789012345678/members/987654321098765432'
  );
  assert.equal(fetchCalls[callsBeforeSuccess].options.headers.Authorization, 'Bot ' + botToken);

  const usersRows = b.sheets.get('Users').rows;
  assert.equal(usersRows.length, 2);
  assert.equal(usersRows[1][0], 'alice');
  assert.match(usersRows[1][1], /^v1\$12000\$/);
  assert.equal(usersRows[1][2], 'standard');

  const discordRows = b.sheets.get('DiscordAccounts').rows;
  assert.deepEqual(discordRows[0], ['discordId', 'username', 'createdAt']);
  assert.equal(discordRows.length, 2);
  assert.equal(discordRows[1][0], "'987654321098765432");
  assert.equal(discordRows[1][1], 'alice');

  // Newly registered user can immediately log in
  const loginRes = b.call({ action: 'login', username: 'alice', password: 'password-123' });
  assert.equal(loginRes.ok, true);
  assert.equal(loginRes.role, 'standard');

  // 7. Duplicate username (case-insensitive) and duplicate Discord ID are rejected without calling Discord
  const callsBeforeDup = fetchCalls.length;
  const dupUser = b.call({ action: 'register', discordId: '111111111111111111', username: 'Alice', password: 'password-123', confirmPassword: 'password-123' });
  assert.equal(dupUser.ok, false);
  assert.equal(dupUser.code, 'DUPLICATE_USERNAME');

  const dupDiscord = b.call({ action: 'register', discordId: '987654321098765432', username: 'bob', password: 'password-123', confirmPassword: 'password-123' });
  assert.equal(dupDiscord.ok, false);
  assert.equal(dupDiscord.code, 'DUPLICATE_DISCORD_ID');
  assert.equal(fetchCalls.length, callsBeforeDup);

  // 8. Secrets and passwords never appear in sheets or logs
  const allData = JSON.stringify({
    users: usersRows,
    discord: discordRows,
    audit: b.sheets.get('Audit').rows,
    logs: b.loggedErrors
  });
  assert.equal(allData.includes('password-123'), false);
  assert.equal(allData.includes(botToken), false);
});

test('Apps Script register also supports HTTPS proxy mode (e.g. Cloudflare Worker) when configured', () => {
  const sharedSecret = 'worker-shared-secret-12345';
  const fetchCalls = [];
  const b = makeAppsScriptBackend({
    properties: {
      DISCORD_VERIFY_URL: 'https://discord-verify.example.workers.dev',
      DISCORD_VERIFY_SECRET: sharedSecret
    },
    urlFetchApp: {
      fetch(url, options) {
        fetchCalls.push({ url, options });
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ ok: true, isMember: true }) };
      }
    }
  });

  const res = b.call({ action: 'register', discordId: '555666777888999000', username: 'worker_user', password: 'password-123', confirmPassword: 'password-123' });
  assert.equal(res.ok, true);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'https://discord-verify.example.workers.dev/verify-member');
  assert.equal(fetchCalls[0].options.headers['X-Verify-Secret'], sharedSecret);
  assert.equal(b.loggedErrors.join(' ').includes(sharedSecret), false);
});
