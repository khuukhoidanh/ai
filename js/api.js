(function () {
  'use strict';

  function msg(key, fallback) {
    return window.appI18n ? window.appI18n.t(key) : fallback;
  }

  async function request(action, payload, timeoutMs) {
    const url = (window.APP_CONFIG && window.APP_CONFIG.appsScriptUrl || '').trim();
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url)) {
      throw new Error(msg('api.missingUrl', 'Vui lòng cấu hình URL Web App Google Apps Script trong js/config.js.'));
    }

    const controller = new AbortController();
    const timeout = setTimeout(function () { controller.abort(); }, Number(timeoutMs) || 90000);
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
        ? msg('api.timeout', 'Hệ thống phản hồi quá lâu (timeout). Vui lòng thử lại.')
        : msg('api.network', 'Không thể kết nối hệ thống máy chủ. Hãy kiểm tra URL và quyền truy cập Web App.'));
    } finally {
      clearTimeout(timeout);
    }
  }

  window.authApi = Object.freeze({
    aiChat: function (token, modelKey, messages, clientRequestId) {
      return request('aiChat', { token: token, modelKey: modelKey, messages: messages, clientRequestId: clientRequestId }, 60000);
    },
    getQuota: function (token) { return request('getQuota', { token: token }); },
    adminDashboard: function (token) { return request('adminDashboard', { token: token }); },
    adminManageUser: function (token, data) { return request('adminManageUser', Object.assign({}, data, { token: token })); },
    adminSetDailyLimit: function (token, dailyLimit) { return request('adminSetDailyLimit', { token: token, dailyLimit: dailyLimit }); },
    login: function (username, password) { return request('login', { username: username, password: password }); },
    register: function (discordId, username, password, confirmPassword) {
      return request('register', { discordId: discordId, username: username, password: password, confirmPassword: confirmPassword });
    },
    getSession: function (token) { return request('getSession', { token: token }); },
    logout: function (token) { return request('logout', { token: token }); }
  });
})();
