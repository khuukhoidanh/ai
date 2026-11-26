$(function () {
  const conversations = [];
  let activeId = null;
  let sessionToken = null;
  let loginPending = false;
  let registerPending = false;
  let sessionRole = null;
  let historyPrefix = null;
  let historyWarningShown = false;
  let adminCheckPending = false;
  const sessionStorageKey = 'chatbot.sessionToken';
  const MAX_CHAT_STORAGE_BYTES = 4 * 1024 * 1024;
  const STORAGE_PROMPT_THRESHOLD_BYTES = 3 * 1024 * 1024;
  let quotaState = { loaded: false, used: 0, limit: 0 };
  let isBotResponding = false;
  let sessionModalMode = 'login-low-space';
  const OPENROUTER_MODELS = {
    'auto': { key: 'auto', id: 'openrouter/free', label: 'Auto (Free)', free: true },
    'gpt-oss-120b': { key: 'gpt-oss-120b', id: 'openai/gpt-oss-120b', label: 'gpt-oss-120b', free: false },
    'gemini-flash-lite': { key: 'gemini-flash-lite', id: 'google/gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', free: false },
    'deepseek-flash': { key: 'deepseek-flash', id: 'deepseek/deepseek-v4-flash-0731', label: 'DeepSeek V4 Flash 0731', free: false }
  };
  const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
  let lastQuotaStatusKey = null;

  function t(key, vars, fallback) {
    if (typeof window !== 'undefined' && window.appI18n && typeof window.appI18n.t === 'function') {
      return window.appI18n.t(key, vars, fallback);
    }
    if (!vars) return fallback || key;
    return String(fallback || key).replace(/\{(\w+)\}/g, function (_, k) {
      return Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : '';
    });
  }

  function tServer(result, fallbackKey) {
    if (typeof window !== 'undefined' && window.appI18n && typeof window.appI18n.translateServerResult === 'function') {
      return window.appI18n.translateServerResult(result, fallbackKey);
    }
    return (result && result.message) || t(fallbackKey, null, 'Đã xảy ra lỗi.');
  }

  function createUniqueId() {
    const webCrypto = typeof crypto !== 'undefined' ? crypto : null;
    if (webCrypto && typeof webCrypto.randomUUID === 'function') {
      return webCrypto.randomUUID();
    }
    if (webCrypto && typeof webCrypto.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      webCrypto.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, function (byte) {
        return byte.toString(16).padStart(2, '0');
      }).join('');
      return (
        hex.slice(0, 8) + '-' +
        hex.slice(8, 12) + '-' +
        hex.slice(12, 16) + '-' +
        hex.slice(16, 20) + '-' +
        hex.slice(20)
      );
    }
    throw new Error(t('msg.cryptoUnsupported', null, 'Trình duyệt không hỗ trợ tạo mã ngẫu nhiên an toàn.'));
  }

  function getSelectedModel() {
    const key = String($('#model-select').val() || 'auto');
    const model = OPENROUTER_MODELS[key];
    if (!model || !model.free) {
      $('#model-select').val('auto');
      return OPENROUTER_MODELS['auto'];
    }
    return model;
  }

  function updateSendButtonState() {
    const hasText = Boolean(($('#message-input').val() || '').trim());
    $('#send-button')
      .prop('disabled', !hasText || isBotResponding)
      .toggleClass('is-responding', isBotResponding)
      .attr('aria-label', isBotResponding ? t('chat.respondingAria', null, 'Bot đang trả lời…') : t('chat.sendAria', null, 'Send message'));
  }

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatInlineMarkdown(raw) {
    const escaped = escapeHtml(raw)
      .replace(/&lt;br\s*\/?&gt;/gi, '<br>');
    return escaped
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  }

  function splitTableRow(line) {
    const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    return trimmed.split('|').map(function (cell) { return cell.trim(); });
  }

  function isTableSeparator(line) {
    return /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?$/.test(line.trim());
  }

  function renderProseLines(prose) {
    const lines = prose.split('\n');
    let html = '';
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      if (!trimmed) {
        i += 1;
        continue;
      }

      if (/^(?:---+|===+|\*\*\*+)$/.test(trimmed)) {
        html += '<hr>';
        i += 1;
        continue;
      }

      const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        html += '<h' + level + '>' + formatInlineMarkdown(headingMatch[2]) + '</h' + level + '>';
        i += 1;
        continue;
      }

      if (trimmed.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
        const headers = splitTableRow(trimmed);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
          rows.push(splitTableRow(lines[i]));
          i += 1;
        }
        html += '<div class="table-wrap"><table><thead><tr>' +
          headers.map(function (h) { return '<th>' + formatInlineMarkdown(h) + '</th>'; }).join('') +
          '</tr></thead><tbody>' +
          rows.map(function (r) {
            return '<tr>' + headers.map(function (_, idx) {
              return '<td>' + formatInlineMarkdown(r[idx] || '') + '</td>';
            }).join('') + '</tr>';
          }).join('') +
          '</tbody></table></div>';
        continue;
      }

      if (/^>\s?/.test(trimmed)) {
        const quoteLines = [];
        while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
          quoteLines.push(formatInlineMarkdown(lines[i].trim().replace(/^>\s?/, '')));
          i += 1;
        }
        html += '<blockquote>' + quoteLines.join('<br>') + '</blockquote>';
        continue;
      }

      if (/^\s*[-*•]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) {
          items.push('<li>' + formatInlineMarkdown(lines[i].replace(/^\s*[-*•]\s+/, '')) + '</li>');
          i += 1;
        }
        html += '<ul>' + items.join('') + '</ul>';
        continue;
      }

      if (/^\s*\d+\.\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          items.push('<li>' + formatInlineMarkdown(lines[i].replace(/^\s*\d+\.\s+/, '')) + '</li>');
          i += 1;
        }
        html += '<ol>' + items.join('') + '</ol>';
        continue;
      }

      const paraLines = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^(?:---+|===+|\*\*\*+)$/.test(lines[i].trim()) &&
        !/^#{1,4}\s+/.test(lines[i].trim()) &&
        !/^>\s?/.test(lines[i].trim()) &&
        !/^\s*[-*•]\s+/.test(lines[i]) &&
        !/^\s*\d+\.\s+/.test(lines[i]) &&
        !(lines[i].includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]))
      ) {
        paraLines.push(formatInlineMarkdown(lines[i]));
        i += 1;
      }
      html += '<p>' + paraLines.join('<br>') + '</p>';
    }

    return html;
  }

  function renderMarkdownHtml(rawText) {
    const text = String(rawText || '').replace(/\r\n/g, '\n');
    const segments = text.split(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g);
    let html = '';
    for (let i = 0; i < segments.length; i += 3) {
      const prose = segments[i] || '';
      if (prose.trim()) {
        html += renderProseLines(prose);
      }
      if (i + 2 < segments.length) {
        const lang = (segments[i + 1] || 'code').trim();
        const code = (segments[i + 2] || '').replace(/\n$/, '');
        html += '<div class="code-block">' +
          '<div class="code-block-head"><span>' + escapeHtml(lang) + '</span>' +
          '<button type="button" class="copy-code-btn">Copy</button></div>' +
          '<pre><code>' + escapeHtml(code) + '</code></pre></div>';
      }
    }
    return html || '<p></p>';
  }

  function clearLegacyLocalQuota() {
    try {
      const legacyKeys = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key && key.startsWith('chatbot.dailyQuota.')) legacyKeys.push(key);
      }
      legacyKeys.forEach(function (key) { localStorage.removeItem(key); });
    } catch (error) {}
  }

  function setQuotaFromServer(used, limit) {
    const parsedUsed = Number(used);
    const parsedLimit = Number(limit);
    if (!Number.isFinite(parsedUsed) || parsedUsed < 0 || !Number.isFinite(parsedLimit) || parsedLimit <= 0) {
      setQuotaUnverified('common.loadError');
      return;
    }
    lastQuotaStatusKey = null;
    quotaState = {
      loaded: true,
      used: Math.floor(parsedUsed),
      limit: Math.floor(parsedLimit)
    };
    $('#quota-count').text(quotaState.used + ' / ' + quotaState.limit);
    $('#quota-bar').css('width', Math.min(quotaState.used / quotaState.limit * 100, 100) + '%');
  }

  function setQuotaUnverified(labelOrKey) {
    quotaState = { loaded: false, used: 0, limit: 0 };
    if (labelOrKey === '— / —') {
      lastQuotaStatusKey = null;
      $('#quota-count').text('— / —');
    } else {
      lastQuotaStatusKey = labelOrKey || 'common.loadError';
      $('#quota-count').text(t(lastQuotaStatusKey, null, 'Chưa tải được'));
    }
    $('#quota-bar').css('width', '0%');
  }

  async function refreshQuotaFromServer() {
    if (!sessionToken) return;
    const token = sessionToken;
    try {
      const res = await window.authApi.getQuota(token);
      if (sessionToken !== token) return;
      if (res && res.ok) {
        setQuotaFromServer(res.dailyUsed, res.dailyLimit);
      } else {
        setQuotaUnverified('common.loadError');
      }
    } catch (error) {
      if (sessionToken === token) setQuotaUnverified('common.loadError');
    }
  }

  function getByteSize(text) {
    const str = String(text || '');
    if (textEncoder) return textEncoder.encode(str).length;
    return unescape(encodeURIComponent(str)).length;
  }

  function formatBytes(bytes) {
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    return Math.round(bytes / 1024) + ' KB';
  }

  function getStoredChatStats(prefix) {
    if (!prefix) return { bytes: 0, chatCount: 0, messageCount: 0 };
    let bytes = 0;
    let chatCount = 0;
    let messageCount = 0;
    try {
      const chatKeyPrefix = prefix + 'chat.';
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith(prefix)) continue;
        const val = localStorage.getItem(key) || '';
        bytes += getByteSize(val);
        if (key.startsWith(chatKeyPrefix)) {
          chatCount += 1;
          try {
            const parsed = JSON.parse(val);
            if (parsed && Array.isArray(parsed.messages)) {
              messageCount += parsed.messages.length;
            }
          } catch (e) {}
        }
      }
    } catch (error) {}
    return { bytes: bytes, chatCount: chatCount, messageCount: messageCount };
  }

  function updateStorageIndicator() {
    const stats = getStoredChatStats(historyPrefix);
    const ratio = stats.bytes / MAX_CHAT_STORAGE_BYTES;
    const $badge = $('#storage-limit-badge');
    $badge
      .text(formatBytes(stats.bytes) + ' / 4 MB')
      .toggleClass('is-warning', ratio >= 0.8 && ratio < 0.95)
      .toggleClass('is-full', ratio >= 0.95);
    return stats;
  }

  function clearLocalHistory() {
    if (historyPrefix) {
      try {
        const keysToRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.startsWith(historyPrefix)) keysToRemove.push(key);
        }
        keysToRemove.forEach(function (key) { localStorage.removeItem(key); });
      } catch (error) {}
    }
    conversations.length = 0;
    activeId = null;
    updateStorageIndicator();
  }

  function openSessionChoiceModal(mode, stats) {
    sessionModalMode = mode || 'login-low-space';
    const usedText = formatBytes(stats.bytes) + ' / 4 MB';
    if (sessionModalMode === 'new-chat-confirm') {
      $('#session-choice-title').text(t('modal.newChatTitle', null, 'Xoá phiên trò chuyện cũ?'));
      $('#session-choice-desc').html(
        t('modal.newChatDesc', null, 'Hiện tại chỉ dùng 1 phiên trò chuyện duy nhất (<strong id="session-choice-summary"></strong>). Bạn có muốn xoá toàn bộ đoạn chat cũ để tạo phiên mới không?')
      );
      $('#session-choice-summary').text(usedText);
      $('#session-choice-new').text(t('modal.newChatConfirm', null, 'Xoá & tạo mới'));
      $('#session-choice-continue').text(t('modal.newChatKeep', null, 'Giữ lại phiên cũ'));
    } else {
      $('#session-choice-title').text(t('modal.lowSpaceTitle', null, 'Dung lượng chat sắp đầy'));
      $('#session-choice-desc').html(
        t('modal.lowSpaceDesc', null, 'Dữ liệu chat đã dùng <strong id="session-choice-summary"></strong> (chỉ còn dưới 1 MB). Bạn muốn tiếp tục bản cũ hay xoá để sang bản mới?')
      );
      $('#session-choice-summary').text(t('modal.lowSpaceSummary', { count: stats.chatCount, used: usedText }, stats.chatCount + ' cuộc trò chuyện • ' + usedText));
      $('#session-choice-new').text(t('modal.lowSpaceNew', null, 'Sang bản mới'));
      $('#session-choice-continue').text(t('modal.lowSpaceContinue', null, 'Tiếp tục bản cũ'));
    }
    $('#session-choice-modal').removeClass('is-hidden');
    $('#session-choice-continue').trigger('focus');
  }

  function closeSessionChoiceModal() {
    $('#session-choice-modal').addClass('is-hidden');
  }

  function readSavedSession() {
    try { return window.localStorage.getItem(sessionStorageKey); }
    catch (error) { return null; }
  }

  function saveSession(token) {
    try {
      if (token) window.localStorage.setItem(sessionStorageKey, token);
      else window.localStorage.removeItem(sessionStorageKey);
      return true;
    } catch (error) { return false; }
  }

  function setChatViewportLock(locked) {
    const root = typeof document !== 'undefined' ? document.documentElement : null;
    if (!root || !root.classList) return;
    if (locked) {
      root.classList.add('chat-active');
      syncChatViewportSize();
    } else {
      root.classList.remove('chat-active');
      if (root.style && typeof root.style.removeProperty === 'function') {
        root.style.removeProperty('--chat-vh');
        root.style.removeProperty('--chat-top');
      }
    }
  }

  function syncChatViewportSize() {
    const root = typeof document !== 'undefined' ? document.documentElement : null;
    if (!root || !root.classList || typeof root.classList.contains !== 'function' || !root.classList.contains('chat-active')) return;
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (vv && root.style && typeof root.style.setProperty === 'function') {
      root.style.setProperty('--chat-vh', Math.round(vv.height) + 'px');
      root.style.setProperty('--chat-top', Math.max(0, Math.round(vv.offsetTop)) + 'px');
      if (typeof window.scrollTo === 'function' && (window.scrollY || window.pageYOffset)) {
        window.scrollTo(0, 0);
      }
    }
  }

  if (typeof window !== 'undefined' && window.visualViewport && typeof window.visualViewport.addEventListener === 'function') {
    window.visualViewport.addEventListener('resize', syncChatViewportSize);
    window.visualViewport.addEventListener('scroll', syncChatViewportSize);
  }

  function syncTextareaScrollState(textarea) {
    if (!textarea || !textarea.classList) return;
    textarea.classList.toggle('is-scrollable', textarea.scrollHeight > textarea.clientHeight + 1);
  }

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('touchmove', function (event) {
      const root = document.documentElement;
      if (!root || !root.classList || typeof root.classList.contains !== 'function' || !root.classList.contains('chat-active')) {
        return;
      }
      const target = event.target;
      if (target && typeof target.closest === 'function') {
        if (target.closest('.messages') || target.closest('.sidebar')) {
          return;
        }
        const inputEl = target.closest('#message-input');
        if (inputEl && inputEl.scrollHeight > inputEl.clientHeight + 1) {
          return;
        }
      }
      event.preventDefault();
    }, { passive: false });
  }

  function showSignedIn(token, user) {
    sessionToken = token;
    sessionRole = user.role;
    $('#account-role').text({ standard: 'Standard', user: 'Standard', vip: 'Vip', admin: 'Admin' }[sessionRole] || 'Standard');
    $('#open-admin').toggleClass('is-hidden', sessionRole !== 'admin');
    $('#account-name').text(user.username);
    $('.avatar').text(user.username.charAt(0).toUpperCase());
    $('#login-view').addClass('is-hidden');
    $('#chat-view').removeClass('is-hidden');
    setChatViewportLock(true);
    historyPrefix = 'chatbot.history.' + encodeURIComponent(user.username.trim().toLowerCase()) + '.';
    clearLegacyLocalQuota();
    if (Number.isFinite(Number(user.dailyUsed)) && Number(user.dailyLimit) > 0) {
      setQuotaFromServer(user.dailyUsed, user.dailyLimit);
    } else {
      setQuotaUnverified('common.loading');
      refreshQuotaFromServer();
    }
    historyWarningShown = false;
    updateSendButtonState();
    const stats = getStoredChatStats(historyPrefix);
    if (stats.bytes >= STORAGE_PROMPT_THRESHOLD_BYTES) {
      updateStorageIndicator();
      renderHistory();
      renderMessages();
      openSessionChoiceModal('login-low-space', stats);
    } else {
      loadHistory();
    }
  }

  function saveConversation(conversation) {
    if (!historyPrefix || !conversation) return false;
    conversation.messages.forEach(function (message) {
      if (!message.id) message.id = createUniqueId();
      if (!Number.isFinite(message.createdAt)) message.createdAt = conversation.createdAt || Date.now();
    });
    const chatKey = historyPrefix + 'chat.' + conversation.id;
    const serialized = JSON.stringify(conversation);
    const activeValue = String(activeId || '');
    try {
      const currentStats = getStoredChatStats(historyPrefix);
      const prevChatBytes = getByteSize(localStorage.getItem(chatKey) || '');
      const prevActiveBytes = getByteSize(localStorage.getItem(historyPrefix + 'active') || '');
      const projectedBytes = currentStats.bytes - prevChatBytes - prevActiveBytes + getByteSize(serialized) + getByteSize(activeValue);
      if (projectedBytes > MAX_CHAT_STORAGE_BYTES) {
        notify(t('msg.storageFull', null, 'Đã đạt giới hạn 4 MB dữ liệu chat trên trình duyệt. Vui lòng tạo bản mới để tiếp tục.'), 'error');
        return false;
      }
      localStorage.setItem(chatKey, serialized);
      localStorage.setItem(historyPrefix + 'active', activeValue);
      updateStorageIndicator();
      return true;
    } catch (error) {
      if (!historyWarningShown) notify(t('msg.storageWriteError', null, 'Không lưu được lịch sử trên trình duyệt. Dung lượng có thể đã đầy hoặc quyền lưu trữ bị chặn.'), 'error');
      historyWarningShown = true;
      return false;
    }
  }

  function loadHistory() {
    conversations.length = 0;
    activeId = null;
    try {
      const prefix = historyPrefix + 'chat.';
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (!key || !key.startsWith(prefix)) continue;
        try {
          const chat = JSON.parse(localStorage.getItem(key));
          if (!chat || typeof chat.id !== 'string' || key !== prefix + chat.id || typeof chat.title !== 'string' ||
              !Number.isFinite(chat.updatedAt) || !Array.isArray(chat.messages) ||
              !chat.messages.every(message => message && ['user', 'assistant'].includes(message.role) && typeof message.text === 'string')) continue;
          chat.cloudLoading = false;
          conversations.push(chat);
        } catch (error) { /* Ignore a damaged entry without deleting the saved data. */ }
      }
      conversations.sort((a, b) => b.updatedAt - a.updatedAt);
      activeId = localStorage.getItem(historyPrefix + 'active');
    } catch (error) {
      notify(t('msg.storageReadError', null, 'Không đọc được lịch sử đã lưu trên trình duyệt.'), 'info');
    }
    if (!activeConversation()) activeId = conversations.length ? conversations[0].id : null;
    updateStorageIndicator();
    if (!conversations.length) newConversation();
    else { renderHistory(); renderMessages(); }
  }

  async function restoreSession() {
    if (loginPending) return;
    const token = readSavedSession();
    if (!token || !/^[a-f0-9]{64}$/.test(token)) {
      saveSession(null);
      document.documentElement.classList.remove('restoring-session');
      return;
    }
    document.documentElement.classList.add('restoring-session');
    $('#session-restore-actions').addClass('is-hidden');
    $('.session-restore-spinner').removeClass('is-hidden');
    $('#session-restore-message').text(t('restore.checking', null, 'Đang khôi phục phiên đăng nhập…'));
    let restoreFailed = false;
    loginPending = true;
    const $button = $('#login-form button[type="submit"]');
    $('#login-form').attr('aria-busy', 'true');
    $('#username, #password').prop('readOnly', true);
    $button.prop('disabled', true).addClass('is-loading');
    $button.find('.login-button-label').text(t('auth.verifyingBtn', null, 'Đang xác thực…'));
    try {
      const result = await window.authApi.getSession(token);
      if (readSavedSession() !== token) return;
      if (!result.ok || !result.user) {
        saveSession(null);
        notify(t('restore.expired', null, 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.'), 'info');
        return;
      }
      showSignedIn(token, result.user);
    } catch (error) {
      restoreFailed = true;
      $('.session-restore-spinner').addClass('is-hidden');
      $('#session-restore-message').text(t('restore.networkError', null, 'Chưa kết nối được máy chủ. Phiên đăng nhập vẫn được lưu, bạn có thể thử lại.'));
      $('#session-restore-actions').removeClass('is-hidden');
    } finally {
      if (!restoreFailed) document.documentElement.classList.remove('restoring-session');
      loginPending = false;
      $('#login-form').attr('aria-busy', 'false');
      $('#username, #password').prop('readOnly', false);
      $button.prop('disabled', false).removeClass('is-loading');
      $button.find('.login-button-label').text(t('auth.loginBtn', null, 'Đăng nhập'));
    }
  }
  window.adminPanel.init({
    getToken: function () { return sessionToken; },
    refresh: openAdmin,
    signOut: function () { $('#logout').trigger('click'); },
    onDailyLimitChanged: function (newLimit) {
      if (Number(newLimit) > 0 && quotaState.loaded) {
        setQuotaFromServer(quotaState.used, Number(newLimit));
      }
    }
  });

  function notify(message, type, developer) {
    window.notifyUser({ type: type || 'info', message: message, developer: developer });
  }

  function activeConversation() {
    return conversations.find(function (conversation) {
      return conversation.id === activeId;
    });
  }

  function renderHistory() {
    const $recent = $('#recent-list').empty();
    const $yesterday = $('#yesterday-list').empty();
    conversations.forEach(function (conversation) {
      const $item = $('<button>', {
        type: 'button',
        class: 'history-item' + (conversation.id === activeId ? ' active' : ''),
        'aria-current': conversation.id === activeId ? 'page' : null
      });
      $('<i>', { class: 'fa-solid fa-message', 'aria-hidden': 'true' }).appendTo($item);
      $('<span>').text(conversation.title).appendTo($item);
      $item.on('click', function () {
        activeId = conversation.id;
        try { localStorage.setItem(historyPrefix + 'active', String(activeId)); } catch (error) {}
        renderHistory();
        renderMessages();
        closeMobileNav();
      });
      (conversation.yesterday ? $yesterday : $recent).append($item);
    });
  }

  function renderMessages() {
    const $messages = $('#messages').empty();
    const conversation = activeConversation();
    if (!conversation || conversation.messages.length === 0) {
      $messages.append(
        '<section class="welcome" id="welcome">' +
          '<h1>How can I help you today?</h1>' +
          '<p>A big idea, a small question, or a blank page. Let\'s make it happen.</p>' +
        '</section>'
      );
      return;
    }

    conversation.messages.forEach(function (message) {
      const $row = $('<article>', { class: 'message-row ' + message.role });
      const $bubble = $('<div>', { class: 'message-bubble' });
      if (message.role === 'assistant') {
        if (message.streaming && !message.text) {
          $bubble.append('<div class="typing-dots" aria-label="' + escapeHtml(t('chat.typingAria', null, 'Đang trả lời')) + '"><span></span><span></span><span></span></div>');
        } else {
          $('<div>', { class: 'message-content' }).html(renderMarkdownHtml(message.text)).appendTo($bubble);
        }
        $('<div>', { class: 'reply-note' })
          .text(message.model || 'Auto (Free)')
          .appendTo($bubble);
      } else {
        $bubble.text(message.text);
      }
      $row.append($bubble);
      $messages.append($row);
    });
    $messages.scrollTop($messages[0].scrollHeight);
  }

  function closeMobileNav() {
    $('body').removeClass('mobile-nav-open');
  }

  function newConversation() {
    if (!sessionToken) return;
    const empty = conversations.find(chat => chat.messages.length === 0);
    if (empty) {
      activeId = empty.id;
      saveConversation(empty);
      renderHistory();
      renderMessages();
      closeMobileNav();
      $('#message-input').trigger('focus');
      return;
    }
    const conversation = {
      id: createUniqueId(),
      title: 'New chat',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      yesterday: false
    };
    conversations.unshift(conversation);
    activeId = conversation.id;
    saveConversation(conversation);
    renderHistory();
    renderMessages();
    closeMobileNav();
    $('#message-input').trigger('focus');
  }

  function animateSmoothReply(conversation, assistantMessage, fullText) {
    return new Promise(function (resolve) {
      const target = String(fullText || '');
      if (!target) {
        resolve();
        return;
      }
      const step = Math.max(3, Math.ceil(target.length / 80));
      let cursor = 0;
      const $messagesEl = $('#messages');

      function tick() {
        cursor = Math.min(target.length, cursor + step);
        assistantMessage.text = target.slice(0, cursor);
        if (activeId === conversation.id) {
          const $lastBubble = $messagesEl.find('.message-row.assistant:last .message-bubble');
          if ($lastBubble.length) {
            let $content = $lastBubble.find('.message-content');
            if (!$content.length) {
              $lastBubble.find('.typing-dots').remove();
              $content = $('<div>', { class: 'message-content' }).prependTo($lastBubble);
            }
            $content.html(renderMarkdownHtml(assistantMessage.text));
            $messagesEl.scrollTop($messagesEl[0].scrollHeight);
          }
        }
        if (cursor < target.length) {
          window.requestAnimationFrame(tick);
        } else {
          resolve();
        }
      }

      window.requestAnimationFrame(tick);
    });
  }

  async function sendMessage(text) {
    const content = (text || '').trim();
    if (!content || !sessionToken) return;
    if (isBotResponding) {
      notify(t('msg.botResponding', null, 'Bot đang trả lời, vui lòng đợi phản hồi xong trước khi gửi tin mới.'), 'info');
      return;
    }
    if (quotaState.loaded && quotaState.used >= quotaState.limit) {
      notify(t('msg.quotaReached', { limit: quotaState.limit }, 'Bạn đã dùng hết ' + quotaState.limit + ' lượt hỏi trong ngày hôm nay. Vui lòng quay lại vào ngày mai.'), 'error');
      return;
    }

    const model = getSelectedModel();
    if (!activeConversation()) newConversation();
    const conversation = activeConversation();
    if (!conversation) return;

    const prevLength = conversation.messages.length;
    const prevTitle = conversation.title;
    const prevUpdatedAt = conversation.updatedAt;
    const userMessage = { id: createUniqueId(), role: 'user', text: content, createdAt: Date.now() };
    conversation.messages.push(userMessage);
    if (prevLength === 0) {
      conversation.title = content.length > 34 ? content.slice(0, 34).trim() + '…' : content;
    }
    conversation.updatedAt = Date.now();
    if (!saveConversation(conversation)) {
      conversation.messages.length = prevLength;
      conversation.title = prevTitle;
      conversation.updatedAt = prevUpdatedAt;
      return;
    }

    const apiMessages = conversation.messages.slice(-20).map(function (m) {
      return { role: m.role, content: m.text };
    });
    const clientRequestId = createUniqueId();

    const assistantMessage = {
      id: createUniqueId(),
      role: 'assistant',
      text: '',
      model: model.label,
      streaming: true,
      createdAt: Date.now()
    };
    conversation.messages.push(assistantMessage);

    isBotResponding = true;
    $('#message-input').val('').css('height', '25px').removeClass('is-scrollable');
    updateSendButtonState();
    renderHistory();
    renderMessages();

    try {
      const result = await window.authApi.aiChat(sessionToken, model.key, apiMessages, clientRequestId);
      if (result && Number.isFinite(Number(result.dailyUsed)) && Number(result.dailyLimit) > 0) {
        setQuotaFromServer(result.dailyUsed, result.dailyLimit);
      }
      if (!result || !result.ok) {
        const err = new Error(tServer(result, 'msg.aiError'));
        err.code = result && result.code;
        throw err;
      }

      const finalReply = String(result.reply || '').trim() || t('msg.emptyBotReply', null, '(Bot không trả về nội dung.)');
      if (result.model) assistantMessage.model = result.model;
      await animateSmoothReply(conversation, assistantMessage, finalReply);

      assistantMessage.text = finalReply;
      delete assistantMessage.streaming;
      conversation.updatedAt = Date.now();

      if (!saveConversation(conversation)) {
        conversation.messages.pop();
        renderMessages();
        return;
      }

      renderHistory();
      renderMessages();
    } catch (error) {
      conversation.messages.pop();
      renderMessages();
      notify(error && error.message ? error.message : t('msg.aiError', null, 'Không thể nhận phản hồi từ OpenRouter.'), 'error');
    } finally {
      isBotResponding = false;
      updateSendButtonState();
    }
  }

  function setAuthMode(mode, skipFocus) {
    const isRegister = mode === 'register';
    $('#auth-tab-login')
      .toggleClass('is-active', !isRegister)
      .attr('aria-selected', String(!isRegister));
    $('#auth-tab-register')
      .toggleClass('is-active', isRegister)
      .attr('aria-selected', String(isRegister));
    $('#login-form').toggleClass('is-hidden', isRegister);
    $('#register-form').toggleClass('is-hidden', !isRegister);
    $('#login-title').text(t(isRegister ? 'auth.registerTitle' : 'auth.loginTitle', null, isRegister ? 'REGISTER' : 'LOGIN PAGE'));
    $('#username, #password, #reg-discord-id, #reg-username, #reg-password, #reg-confirm-password').removeAttr('aria-invalid');
    if (!skipFocus) $(isRegister ? '#reg-discord-id' : '#username').trigger('focus');
  }

  $('#auth-tab-login').on('click', function () {
    if (!loginPending && !registerPending) setAuthMode('login');
  });

  $('#auth-tab-register').on('click', function () {
    if (!loginPending && !registerPending) setAuthMode('register');
  });

  $('#login-form').on('submit', function (event) {
    event.preventDefault();
    if (loginPending || registerPending) return;
    const username = $('#username').val().trim();
    const password = $('#password').val();
    const $button = $('#login-form button[type="submit"]');

    if (!username || !password) {
      $('#username').attr('aria-invalid', String(!username));
      $('#password').attr('aria-invalid', String(!password));
      $( !username ? '#username' : '#password').trigger('focus');
      notify(t(!username && !password ? 'msg.enterBoth' : (!username ? 'msg.enterUsername' : 'msg.enterPassword'), null,
        'Vui lòng nhập ' + (!username && !password ? 'tên đăng nhập và mật khẩu.' : !username ? 'tên đăng nhập.' : 'mật khẩu.')), 'error');
      return;
    }
    $('#username, #password').removeAttr('aria-invalid');
    loginPending = true;
    $('#login-form').attr('aria-busy', 'true');
    $('#username, #password').prop('readOnly', true);
    $button.prop('disabled', true).addClass('is-loading');
    $button.find('.login-button-label').text(t('auth.loggingInBtn', null, 'Đang đăng nhập…'));
    const slowLoginTimer = window.setTimeout(function () {
      notify(t('msg.loginSlow', null, 'Hệ thống vẫn đang xử lý đăng nhập. Bạn vui lòng chờ thêm một chút.'), 'info');
    }, 8000);
    window.authApi.login(username, password)
      .then(function (result) {
        $('#password').val('');
        if (!result || !result.ok) {
          notify(tServer(result, 'msg.loginFailed'), 'error');
          return;
        }

        const saved = saveSession(result.token);
        showSignedIn(result.token, result);
        notify(saved ? t('msg.loginSuccess', null, 'Đăng nhập thành công.') : t('msg.loginNoStorage', null, 'Đăng nhập thành công. Trình duyệt không cho phép lưu phiên đăng nhập.'), saved ? 'success' : 'info');
      })
      .catch(function (error) {
        $('#password').val('');
        console.error('Apps Script login failed:', error);
        const message = (error && error.message) || t('msg.loginConnectError', null, 'Không thể kết nối hệ thống đăng nhập. Vui lòng thử lại.');
        notify(message, 'error');
      })
      .finally(function () {
        window.clearTimeout(slowLoginTimer);
        loginPending = false;
        $('#login-form').attr('aria-busy', 'false');
        $('#username, #password').prop('readOnly', false);
        $button.prop('disabled', false).removeClass('is-loading');
        $button.find('.login-button-label').text(t('auth.loginBtn', null, 'Đăng nhập'));
      });
  });

  $('#register-form').on('submit', function (event) {
    event.preventDefault();
    if (loginPending || registerPending) return;

    const discordId = ($('#reg-discord-id').val() || '').trim();
    const username = ($('#reg-username').val() || '').trim();
    const password = $('#reg-password').val() || '';
    const confirmPassword = $('#reg-confirm-password').val() || '';
    const $button = $('#register-form button[type="submit"]');

    $('#reg-discord-id, #reg-username, #reg-password, #reg-confirm-password').removeAttr('aria-invalid');

    if (!/^\d{17,20}$/.test(discordId)) {
      $('#reg-discord-id').attr('aria-invalid', 'true').trigger('focus');
      notify(t('msg.invalidDiscordId', null, 'Discord ID phải gồm 17 đến 20 chữ số.'), 'error');
      return;
    }
    if (!username || username.length > 64 || /[\u0000-\u001f\u007f]/.test(username) || /^[=+@-]/.test(username)) {
      $('#reg-username').attr('aria-invalid', 'true').trigger('focus');
      notify(t('msg.invalidUsername', null, 'Tên đăng nhập không hợp lệ (không bắt đầu bằng =, +, @, -).'), 'error');
      return;
    }
    if (!password || password.length < 8 || password.length > 256) {
      $('#reg-password').attr('aria-invalid', 'true').trigger('focus');
      notify(t('msg.invalidPasswordLen', null, 'Mật khẩu cần từ 8 đến 256 ký tự.'), 'error');
      return;
    }
    if (password !== confirmPassword) {
      $('#reg-confirm-password').attr('aria-invalid', 'true').trigger('focus');
      notify(t('msg.passwordMismatch', null, 'Mật khẩu xác nhận không khớp.'), 'error');
      return;
    }

    registerPending = true;
    $('#register-form').attr('aria-busy', 'true');
    $('#reg-discord-id, #reg-username, #reg-password, #reg-confirm-password').prop('readOnly', true);
    $button.prop('disabled', true).addClass('is-loading');
    $button.find('.login-button-label').text(t('auth.registeringBtn', null, 'Đang xác minh…'));

    window.authApi.register(discordId, username, password, confirmPassword)
      .then(function (result) {
        $('#reg-password, #reg-confirm-password').val('');
        if (!result || !result.ok) {
          notify(tServer(result, 'msg.registerFailed'), 'error');
          return;
        }
        $('#reg-discord-id, #reg-username').val('');
        setAuthMode('login');
        $('#username').val(result.username || username);
        $('#password').val('').trigger('focus');
        notify(t('msg.registerSuccess', null, 'Đăng ký thành công. Bạn có thể đăng nhập ngay.'), 'success');
      })
      .catch(function (error) {
        $('#reg-password, #reg-confirm-password').val('');
        notify((error && error.message) || t('msg.registerUnavailable', null, 'Hệ thống xác minh đăng ký tạm thời không khả dụng. Vui lòng thử lại sau.'), 'error');
      })
      .finally(function () {
        registerPending = false;
        $('#register-form').attr('aria-busy', 'false');
        $('#reg-discord-id, #reg-username, #reg-password, #reg-confirm-password').prop('readOnly', false);
        $button.prop('disabled', false).removeClass('is-loading');
        $button.find('.login-button-label').text(t('auth.registerBtn', null, 'Đăng ký'));
      });
  });

  $('#username, #password, #reg-discord-id, #reg-username, #reg-password, #reg-confirm-password').on('input', function () {
    $(this).removeAttr('aria-invalid');
  });

  $('.password-toggle').on('click', function () {
    const $input = $(this).closest('.password-field').find('input');
    const showPassword = $input.attr('type') === 'password';
    $input.attr('type', showPassword ? 'text' : 'password');
    $(this)
      .attr('aria-pressed', String(showPassword))
      .attr('aria-label', t(showPassword ? 'auth.hidePasswordAria' : 'auth.showPasswordAria', null, showPassword ? 'Hide password' : 'Show password'))
      .text(t(showPassword ? 'auth.hidePassword' : 'auth.showPassword', null, showPassword ? 'Hide' : 'Show'));
  });

  $('#logout, #admin-logout').on('click', function () {
    const token = sessionToken;
    saveSession(null);
    sessionToken = null;
    sessionRole = null;
    isBotResponding = false;
    closeSessionChoiceModal();
    $('#history-sync-status').text(t('chat.historySync', null, 'Lưu trên trình duyệt (tối đa 4 MB)'));
    $('#storage-limit-badge').text('0 KB / 4 MB').removeClass('is-warning is-full');
    historyPrefix = null;
    clearLegacyLocalQuota();
    window.adminPanel.clear();
    $('#account-role').text('Standard');
    $('#admin-view, #open-admin').addClass('is-hidden');
    $('#admin-username, #admin-checked-at').text('—');
    $('#admin-api-status').text(t('admin.apiUnchecked', null, 'Chưa kiểm tra'));
    $('#chat-view').addClass('is-hidden');
    setChatViewportLock(false);
    $('#login-view').removeClass('is-hidden');
    setAuthMode('login');
    $('#username, #password, #reg-discord-id, #reg-username, #reg-password, #reg-confirm-password').val('');
    $('#account-name').text('Guest');
    $('.avatar').text('G');
    $('.password-toggle').attr({ 'aria-pressed': 'false', 'aria-label': t('auth.showPasswordAria', null, 'Show password') }).text(t('auth.showPassword', null, 'Show'));
    $('#reg-password, #reg-confirm-password').attr('type', 'password');
    $('#username, #password').removeAttr('aria-invalid');
    closeMobileNav();
    conversations.length = 0;
    activeId = null;
    renderHistory();
    renderMessages();
    setQuotaUnverified('— / —');
    $('#password').attr('type', 'password');
    $('#message-input').val('').css('height', '25px').removeClass('is-scrollable');
    $('#send-button').prop('disabled', true);
    if (token) {
      window.authApi.logout(token).catch(function (error) {
        notify(t('msg.logoutRemoteError', null, 'Đã thoát trên trình duyệt nhưng chưa thu hồi được phiên trên máy chủ.'), 'error');
      });
    }
  });

  async function openAdmin() {
    if (!sessionToken || sessionRole !== 'admin' || adminCheckPending) return;
    const checkedToken = sessionToken;
    const alreadyOpen = !$('#admin-view').hasClass('is-hidden');
    adminCheckPending = true;
    $('#open-admin, #admin-refresh').prop('disabled', true).attr('aria-busy', 'true');
    $('#admin-api-status').text(t('admin.apiChecking', null, 'Đang kiểm tra…'));
    try {
      const result = await window.authApi.adminDashboard(checkedToken);
      if (sessionToken !== checkedToken) return;
      if (!result.ok && result.code !== 'FORBIDDEN') {
        throw new Error(tServer(result, 'msg.adminLoadError'));
      }
      if (!result.ok || !result.user || result.user.role !== 'admin') {
        $('#logout').trigger('click');
        notify(t('msg.adminExpired', null, 'Phiên đã hết hạn hoặc không có quyền quản trị. Vui lòng đăng nhập lại.'), 'error');
        return;
      }
      $('#admin-username').text(result.user.username);
      window.adminPanel.render(result);
      $('#admin-api-status').text(t('admin.apiConnected', null, 'Đã kết nối'));
      const timeLocale = window.appI18n && window.appI18n.getLang() === 'en' ? 'en-US' : 'vi-VN';
      $('#admin-checked-at').text(new Date().toLocaleTimeString(timeLocale));
      closeMobileNav();
      $('#chat-view').addClass('is-hidden');
      setChatViewportLock(false);
      $('#admin-view').removeClass('is-hidden');
      if (!alreadyOpen) $('#admin-title').trigger('focus');
      else notify(t('msg.adminConfirmed', null, 'Kết nối và quyền quản trị đã được xác nhận.'), 'success');
    } catch (error) {
      if (sessionToken !== checkedToken) return;
      $('#admin-api-status').text(t('admin.apiDisconnected', null, 'Không thể kết nối'));
      notify(error.message, 'error');
    } finally {
      adminCheckPending = false;
      $('#open-admin, #admin-refresh').prop('disabled', false).attr('aria-busy', 'false');
    }
  }

  $('#open-admin, #admin-refresh').on('click', openAdmin);
  $('#admin-back').on('click', function () {
    $('#admin-view').addClass('is-hidden');
    $('#chat-view').removeClass('is-hidden');
    setChatViewportLock(true);
    $('#open-admin').trigger('focus');
  });

  function requestNewChat() {
    if (!sessionToken) return;
    if (isBotResponding) {
      notify(t('msg.botRespondingNewChat', null, 'Bot đang trả lời, vui lòng đợi xong trước khi tạo phiên mới.'), 'info');
      return;
    }
    const stats = getStoredChatStats(historyPrefix);
    const hasMessages = stats.messageCount > 0 || conversations.some(function (c) { return c.messages.length > 0; });
    if (hasMessages) {
      openSessionChoiceModal('new-chat-confirm', stats);
    } else {
      closeMobileNav();
      $('#message-input').trigger('focus');
    }
  }

  $('#new-chat').on('click', requestNewChat);
  $('.collapse-sidebar').on('click', function () {
    $('body').toggleClass('sidebar-collapsed');
  });
  $('.open-sidebar').on('click', function () {
    $('body').addClass('mobile-nav-open');
  });
  $('.close-sidebar, #scrim').on('click', closeMobileNav);
  $('.brand').on('click', function (event) { event.preventDefault(); });

  function copyTextFallback(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.setAttribute('aria-hidden', 'true');
    textarea.style.position = 'fixed';
    textarea.style.top = '0';
    textarea.style.left = '-9999px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    const copied = document.execCommand('copy');
    textarea.remove();
    if (!copied) throw new Error('Clipboard copy failed');
  }

  $('#messages').on('click', '.copy-code-btn', async function () {
    const $btn = $(this);
    const code = $btn.closest('.code-block').find('code').text();
    if (!code) return;

    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(code);
      } else {
        copyTextFallback(code);
      }
      $btn.text('Copied!');
      if ($btn.data('copy-reset-timer')) clearTimeout($btn.data('copy-reset-timer'));
      $btn.data('copy-reset-timer', setTimeout(function () {
        $btn.text('Copy');
        $btn.removeData('copy-reset-timer');
      }, 1500));
    } catch (error) {
      $btn.text('Copy failed');
      if ($btn.data('copy-reset-timer')) clearTimeout($btn.data('copy-reset-timer'));
      $btn.data('copy-reset-timer', setTimeout(function () {
        $btn.text('Copy');
        $btn.removeData('copy-reset-timer');
      }, 2000));
    }
  });
  $('#message-form').on('submit', function (event) {
    event.preventDefault();
    sendMessage($('#message-input').val());
  });
  $('#message-input').on('input', function () {
    this.style.height = '25px';
    this.style.height = Math.min(this.scrollHeight, 150) + 'px';
    syncTextareaScrollState(this);
    updateSendButtonState();
  }).on('focus', function () {
    syncChatViewportSize();
  }).on('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (isBotResponding) {
        notify(t('msg.botRespondingEnter', null, 'Bot đang trả lời, bạn vẫn có thể nhập tiếp nhưng chưa thể gửi.'), 'info');
        return;
      }
      $('#message-form').trigger('submit');
    }
  });
  $('#model-select').on('change', function () {
    const key = String($(this).val() || '');
    const selected = OPENROUTER_MODELS[key];
    if (!selected || !selected.free) {
      $(this).val('auto');
      notify(t('msg.modelLocked', null, 'Model trả phí đang bị khoá. Chỉ có thể dùng chế độ Auto miễn phí.'), 'info');
      return;
    }
    notify(t('msg.modelSelected', { label: selected.label }, 'Đã chọn model: ' + selected.label), 'info');
  });
  $(document).on('keydown', function (event) {
    if (event.key === 'Escape') {
      closeMobileNav();
      if (!$('#session-choice-modal').hasClass('is-hidden')) {
        $('#session-choice-continue').trigger('click');
      }
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !$('#chat-view').hasClass('is-hidden') && $('#session-choice-modal').hasClass('is-hidden')) {
      event.preventDefault();
      requestNewChat();
    }
  });
  $('#session-choice-continue').on('click', function () {
    const mode = sessionModalMode;
    closeSessionChoiceModal();
    if (mode === 'login-low-space') {
      loadHistory();
    }
  });
  $('#session-choice-new').on('click', function () {
    closeSessionChoiceModal();
    clearLocalHistory();
    newConversation();
    notify(t('msg.clearedChat', null, 'Đã xoá dữ liệu cũ và tạo cuộc trò chuyện mới.'), 'info');
  });
  if (typeof window !== 'undefined' && window.appI18n && typeof window.appI18n.onChange === 'function') {
    window.appI18n.onChange(function () {
      const isRegister = !$('#register-form').hasClass('is-hidden');
      setAuthMode(isRegister ? 'register' : 'login', true);
      updateSendButtonState();
      if (lastQuotaStatusKey) setQuotaUnverified(lastQuotaStatusKey);
    });
  }
  window.addEventListener('storage', function (event) {
    if ((event.key === sessionStorageKey || event.key === null) && !readSavedSession() && sessionToken) {
      $('#logout').trigger('click');
    }
  });
  $('#session-retry').on('click', restoreSession);
  $('#session-login').on('click', function () {
    saveSession(null);
    document.documentElement.classList.remove('restoring-session');
    $('#username').trigger('focus');
  });
  restoreSession();
});
