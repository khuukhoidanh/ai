const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function collectI18nKeysFromHtml(html) {
  const keys = new Set();
  const re = /data-i18n(?:-(?:html|placeholder|aria-label|title|label))?="([^"]+)"/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    keys.add(match[1]);
  }
  return keys;
}

test('every data-i18n key in HTML partials exists in both vi and en dictionaries', () => {
  const storage = new Map();
  const ctx = vm.createContext({
    window: {
      localStorage: {
        getItem: k => (storage.has(k) ? storage.get(k) : null),
        setItem: (k, v) => storage.set(k, String(v))
      }
    },
    document: {
      documentElement: { lang: 'vi' },
      querySelectorAll: () => [],
      addEventListener: () => {}
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/i18n.js'), 'utf8'), ctx);
  const { DICT } = ctx.window.appI18n;

  for (const partial of ['login.html', 'chat.html', 'admin.html']) {
    const html = fs.readFileSync(path.join(__dirname, '../partials', partial), 'utf8');
    const keys = collectI18nKeysFromHtml(html);
    assert.ok(keys.size > 0, `${partial} should declare i18n keys`);
    for (const key of keys) {
      assert.equal(Object.hasOwn(DICT.vi, key), true, `Missing vi key "${key}" referenced in ${partial}`);
      assert.equal(Object.hasOwn(DICT.en, key), true, `Missing en key "${key}" referenced in ${partial}`);
    }
  }
});

test('appI18n switches between vi and en, translates DOM attributes, persists preference and translates server codes', () => {
  const storage = new Map();
  const makeNode = (attrs = {}) => {
    const classes = new Set();
    return {
      textContent: '',
      innerHTML: '',
      attrs: { ...attrs },
      getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; },
      setAttribute(name, val) { this.attrs[name] = String(val); },
      querySelectorAll() { return []; },
      classList: {
        toggle: (cls, force) => (force ? classes.add(cls) : classes.delete(cls)),
        contains: cls => classes.has(cls)
      }
    };
  };

  const tabLogin = makeNode({ 'data-i18n': 'auth.tabLogin' });
  const inputUser = makeNode({ 'data-i18n-placeholder': 'auth.discordIdPlaceholder' });
  const langBtn = makeNode({ 'data-lang-toggle': '' });
  const optVi = makeNode({ 'data-lang-opt': 'vi' });
  const optEn = makeNode({ 'data-lang-opt': 'en' });
  langBtn.querySelectorAll = () => [optVi, optEn];

  const nodes = {
    '[data-i18n]': [tabLogin],
    '[data-i18n-html]': [],
    '[data-i18n-placeholder]': [inputUser],
    '[data-i18n-aria-label]': [],
    '[data-i18n-title]': [],
    '[data-i18n-label]': [],
    '[data-lang-toggle]': [langBtn]
  };

  const doc = {
    documentElement: { lang: 'vi' },
    querySelectorAll: selector => nodes[selector] || [],
    addEventListener: () => {}
  };
  const win = {
    localStorage: {
      getItem: k => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v))
    }
  };
  const ctx = vm.createContext({ window: win, document: doc });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/i18n.js'), 'utf8'), ctx);

  let changeCount = 0;
  win.appI18n.onChange(() => { changeCount += 1; });

  win.appI18n.setLang('en');
  assert.equal(win.appI18n.getLang(), 'en');
  assert.equal(doc.documentElement.lang, 'en');
  assert.equal(storage.get('chatbot.lang'), 'en');
  assert.equal(tabLogin.textContent, 'Sign in');
  assert.equal(inputUser.attrs.placeholder, 'Discord ID (17–20 digits)');
  assert.equal(optEn.classList.contains('is-active'), true);
  assert.equal(optVi.classList.contains('is-active'), false);
  assert.equal(changeCount, 1);
  assert.equal(
    win.appI18n.translateServerResult({ code: 'NOT_DISCORD_MEMBER', message: 'Vietnamese msg' }),
    'This Discord ID is not a member of the Discord server yet. Please join the Discord server first and try again.'
  );

  win.appI18n.toggleLang();
  assert.equal(win.appI18n.getLang(), 'vi');
  assert.equal(tabLogin.textContent, 'Đăng nhập');
  assert.equal(optVi.classList.contains('is-active'), true);
  assert.equal(
    win.appI18n.translateServerResult({ code: 'NOT_DISCORD_MEMBER', message: 'Thông báo tiếng Việt' }),
    'Thông báo tiếng Việt'
  );
});
