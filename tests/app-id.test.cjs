const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const path = require('node:path');

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function runAppInVm(cryptoMock) {
  const storage = new Map();
  const handlers = new Map();
  const sentAiCalls = [];
  const elements = new Map();

  function makeElement(key) {
    if (elements.has(key)) return elements.get(key);
    let currentVal = '';
    const el = {
      0: { scrollHeight: 100, style: {} },
      length: 1,
      val(next) {
        if (arguments.length === 0) return currentVal;
        currentVal = String(next ?? '');
        return el;
      },
      text() { return el; },
      html() { return el; },
      css() { return el; },
      prop() { return el; },
      attr() { return el; },
      removeAttr() { return el; },
      addClass() { return el; },
      removeClass() { return el; },
      toggleClass() { return el; },
      hasClass() { return true; },
      empty() { return el; },
      append() { return el; },
      appendTo() { return el; },
      prependTo() { return el; },
      find() { return makeElement('child'); },
      closest() { return makeElement('closest'); },
      scrollTop() { return el; },
      trigger() { return el; },
      on(eventName, fn) {
        const list = handlers.get(`${key}:${eventName}`) || [];
        list.push(fn);
        handlers.set(`${key}:${eventName}`, list);
        return el;
      }
    };
    elements.set(key, el);
    return el;
  }

  function $(arg) {
    if (typeof arg === 'function') {
      arg();
      return;
    }
    return makeElement(String(arg));
  }

  const localStorageMock = {
    get length() { return storage.size; },
    key: i => Array.from(storage.keys())[i] ?? null,
    getItem: k => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: k => storage.delete(k)
  };

  const windowMock = {
    localStorage: localStorageMock,
    location: { href: 'http://192.168.1.10:8080/' },
    addEventListener() {},
    setTimeout,
    clearTimeout,
    requestAnimationFrame: cb => cb(),
    notifyUser() {},
    adminPanel: { init() {}, render() {}, clear() {} },
    authApi: {
      login: async () => ({
        ok: true,
        token: 'a'.repeat(64),
        username: 'alice',
        role: 'standard',
        dailyUsed: 0,
        dailyLimit: 200
      }),
      aiChat: async (token, modelKey, messages, clientRequestId) => {
        sentAiCalls.push({ token, modelKey, messages, clientRequestId });
        return { ok: true, reply: 'hi', model: 'openrouter/free', dailyUsed: 1, dailyLimit: 200 };
      }
    }
  };

  const classes = new Set();
  const context = vm.createContext({
    $: $,
    window: windowMock,
    document: { documentElement: { classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) }, style: { setProperty() {}, removeProperty() {} } } },
    localStorage: localStorageMock,
    crypto: cryptoMock,
    TextEncoder,
    console
  });

  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8'), context);
  return { $, handlers, storage, sentAiCalls };
}

test('js/app.js never calls crypto.randomUUID directly outside shared helper and works with getRandomValues fallback', async () => {
  const appSource = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
  const directMatches = appSource.match(/crypto\.randomUUID\s*\(/g) || [];
  assert.equal(directMatches.length, 0);
  const helperMatches = appSource.match(/webCrypto\.randomUUID\s*\(/g) || [];
  assert.equal(helperMatches.length, 1);

  // Load OpenRouter.gs normalizeClientRequestId_ to verify exact backend compatibility.
  const openRouterCtx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script/OpenRouter.gs'), 'utf8'), openRouterCtx);

  // 1. Safari non-HTTPS context: crypto.randomUUID is undefined, only crypto.getRandomValues exists.
  const fallbackCrypto = {
    getRandomValues: arr => crypto.randomFillSync(arr)
  };
  const appFallback = runAppInVm(fallbackCrypto);
  appFallback.$('#username').val('alice');
  appFallback.$('#password').val('password-123');

  const loginHandlers = appFallback.handlers.get('#login-form:submit');
  assert.ok(loginHandlers && loginHandlers.length > 0);
  loginHandlers[0]({ preventDefault() {} });
  await new Promise(resolve => setTimeout(resolve, 20));

  appFallback.$('#message-input').val('Xin chào');
  const msgHandlers = appFallback.handlers.get('#message-form:submit');
  assert.ok(msgHandlers && msgHandlers.length > 0);
  await msgHandlers[0]({ preventDefault() {} });
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.equal(appFallback.sentAiCalls.length, 1);
  const reqId = appFallback.sentAiCalls[0].clientRequestId;
  assert.match(reqId, UUID_V4_RE);
  assert.equal(openRouterCtx.normalizeClientRequestId_(reqId), reqId);

  const chatEntries = Array.from(appFallback.storage.entries()).filter(([k]) => k.includes('.chat.'));
  assert.equal(chatEntries.length, 1);
  const savedChat = JSON.parse(chatEntries[0][1]);
  assert.match(savedChat.id, UUID_V4_RE);
  assert.equal(savedChat.messages.length, 2);
  assert.match(savedChat.messages[0].id, UUID_V4_RE);
  assert.match(savedChat.messages[1].id, UUID_V4_RE);
  assert.notEqual(savedChat.messages[0].id, savedChat.messages[1].id);
  assert.notEqual(reqId, savedChat.messages[0].id);

  // 2. Secure context: uses native crypto.randomUUID when present.
  let nativeCalls = 0;
  const nativeCrypto = {
    randomUUID: () => {
      nativeCalls += 1;
      return crypto.randomUUID();
    },
    getRandomValues: arr => crypto.randomFillSync(arr)
  };
  const appNative = runAppInVm(nativeCrypto);
  appNative.$('#username').val('alice');
  appNative.$('#password').val('password-123');
  appNative.handlers.get('#login-form:submit')[0]({ preventDefault() {} });
  await new Promise(resolve => setTimeout(resolve, 20));

  appNative.$('#message-input').val('Hello');
  await appNative.handlers.get('#message-form:submit')[0]({ preventDefault() {} });
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.equal(nativeCalls >= 4, true);
  assert.match(appNative.sentAiCalls[0].clientRequestId, UUID_V4_RE);
});
