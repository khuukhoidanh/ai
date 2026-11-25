(function () {
  'use strict';

  async function request(action, payload) {
    const url = (window.APP_CONFIG && window.APP_CONFIG.appsScriptUrl || '').trim();
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url)) {
      throw new Error('Vui lòng cấu hình URL Web App Google Apps Script trong js/config.js.');
    }

    const controller = new AbortController();
    const timeout = setTimeout(function () { controller.abort(); }, 90000);
    try {
      const response = await fetch(url, {
        method: 'POST',
        // A simple CORS request avoids an unsupported OPTIONS preflight.
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({}, payload, { action: action })),
        credentials: 'omit',
        redirect: 'follow',
        signal: controller.signal
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const result = await response.json();
      if (!result || typeof result.ok !== 'boolean') throw new Error('Invalid API response');
      return result;
    } catch (error) {
      throw new Error(error.name === 'AbortError'
        ? 'Hệ thống phản hồi quá lâu. Vui lòng thử lại.'
        : 'Không thể kết nối hệ thống đăng nhập. Hãy kiểm tra URL và quyền truy cập Web App.');
    } finally {
      clearTimeout(timeout);
    }
  }

  window.authApi = Object.freeze({
    discordList: function (token) { return request('discordList', { token: token }); },
    discordSave: function (token, chat) { return request('discordSave', { token: token, chat: chat }); },
    discordLoad: function (token, chatId, before) { return request('discordLoad', { token: token, chatId: chatId, before: before }); },
    adminDashboard: function (token) { return request('adminDashboard', { token: token }); },
    adminManageUser: function (token, data) { return request('adminManageUser', Object.assign({}, data, { token: token })); },
    login: function (username, password) { return request('login', { username: username, password: password }); },
    getSession: function (token) { return request('getSession', { token: token }); },
    logout: function (token) { return request('logout', { token: token }); }
  });
})();
