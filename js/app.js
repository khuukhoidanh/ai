$(function () {
  const conversations = [];
  let activeId = null;
  let requestCount = 0;
  let sessionToken = null;
  let loginPending = false;
  let sessionRole = null;
  let historyPrefix = null;
  let dailyQuotaKey = null;
  let historyWarningShown = false;
  let adminCheckPending = false;
  const sessionStorageKey = 'chatbot.sessionToken';
  const MAX_CHAT_STORAGE_BYTES = 4 * 1024 * 1024;
  const STORAGE_PROMPT_THRESHOLD_BYTES = 3 * 1024 * 1024;
  let maxDailyRequests = (window.APP_CONFIG && Number(window.APP_CONFIG.dailyRequestLimit) > 0)
    ? Math.floor(Number(window.APP_CONFIG.dailyRequestLimit))
    : 200;
  let isBotResponding = false;
  let sessionModalMode = 'login-low-space';
  const OPENROUTER_MODELS = {
    'auto': { key: 'auto', id: 'openrouter/free', label: 'Auto (Free)', free: true },
    'gpt-oss-120b': { key: 'gpt-oss-120b', id: 'openai/gpt-oss-120b', label: 'gpt-oss-120b', free: false },
    'gemini-flash-lite': { key: 'gemini-flash-lite', id: 'google/gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', free: false },
    'deepseek-flash': { key: 'deepseek-flash', id: 'deepseek/deepseek-v4-flash-0731', label: 'DeepSeek V4 Flash 0731', free: false }
  };
  const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

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
      .attr('aria-label', isBotResponding ? 'Bot đang trả lời…' : 'Send message');
  }

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatInlineMarkdown(escaped) {
    return escaped
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  }

  function renderMarkdownHtml(rawText) {
    const text = String(rawText || '').replace(/\r\n/g, '\n');
    const segments = text.split(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g);
    let html = '';
    for (let i = 0; i < segments.length; i += 3) {
      const prose = segments[i] || '';
      if (prose.trim()) {
        const blocks = prose.split(/\n{2,}/);
        blocks.forEach(function (block) {
          const lines = block.split('\n').filter(Boolean);
          if (!lines.length) return;
          if (lines.every(function (l) { return /^\s*[-*]\s+/.test(l); })) {
            html += '<ul>' + lines.map(function (l) {
              return '<li>' + formatInlineMarkdown(escapeHtml(l.replace(/^\s*[-*]\s+/, ''))) + '</li>';
            }).join('') + '</ul>';
          } else if (lines.every(function (l) { return /^\s*\d+\.\s+/.test(l); })) {
            html += '<ol>' + lines.map(function (l) {
              return '<li>' + formatInlineMarkdown(escapeHtml(l.replace(/^\s*\d+\.\s+/, ''))) + '</li>';
            }).join('') + '</ol>';
          } else {
            html += '<p>' + lines.map(function (l) {
              return formatInlineMarkdown(escapeHtml(l));
            }).join('<br>') + '</p>';
          }
        });
      }
      if (i + 2 < segments.length) {
        const code = segments[i + 2] || '';
        html += '<pre><code>' + escapeHtml(code.replace(/\n$/, '')) + '</code></pre>';
      }
    }
    return html || '<p></p>';
  }

  function getTodayKey() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }

  function readDailyQuota() {
    if (!dailyQuotaKey) return 0;
    try {
      const raw = localStorage.getItem(dailyQuotaKey);
      if (!raw) return 0;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.date === getTodayKey() && Number.isFinite(parsed.count) && parsed.count >= 0) {
        return Math.floor(parsed.count);
      }
    } catch (error) {}
    return 0;
  }

  function writeDailyQuota(count) {
    if (!dailyQuotaKey) return;
    try {
      localStorage.setItem(dailyQuotaKey, JSON.stringify({ date: getTodayKey(), count: Math.max(0, Math.floor(count)) }));
    } catch (error) {}
  }

  function updateQuotaUI(count) {
    requestCount = Math.max(0, Math.floor(count));
    $('#quota-count').text(requestCount + ' / ' + maxDailyRequests);
    $('#quota-bar').css('width', Math.min(requestCount / maxDailyRequests * 100, 100) + '%');
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
    updateQuotaUI(readDailyQuota());
    updateStorageIndicator();
  }

  function openSessionChoiceModal(mode, stats) {
    sessionModalMode = mode || 'login-low-space';
    const usedText = formatBytes(stats.bytes) + ' / 4 MB';
    if (sessionModalMode === 'new-chat-confirm') {
      $('#session-choice-title').text('Xoá phiên trò chuyện cũ?');
      $('#session-choice-desc').html(
        'Hiện tại chỉ dùng 1 phiên trò chuyện duy nhất (<strong id="session-choice-summary"></strong>). Bạn có muốn xoá toàn bộ đoạn chat cũ để tạo phiên mới không?'
      );
      $('#session-choice-summary').text(usedText);
      $('#session-choice-new').text('Xoá & tạo mới');
      $('#session-choice-continue').text('Giữ lại phiên cũ');
    } else {
      $('#session-choice-title').text('Dung lượng chat sắp đầy');
      $('#session-choice-desc').html(
        'Dữ liệu chat đã dùng <strong id="session-choice-summary"></strong> (chỉ còn dưới 1 MB). Bạn muốn tiếp tục bản cũ hay xoá để sang bản mới?'
      );
      $('#session-choice-summary').text(stats.chatCount + ' cuộc trò chuyện • ' + usedText);
      $('#session-choice-new').text('Sang bản mới');
      $('#session-choice-continue').text('Tiếp tục bản cũ');
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

  function showSignedIn(token, user) {
    sessionToken = token;
    sessionRole = user.role;
    $('#account-role').text({ standard: 'Standard', user: 'Standard', vip: 'Vip', admin: 'Admin' }[sessionRole] || 'Standard');
    $('#open-admin').toggleClass('is-hidden', sessionRole !== 'admin');
    $('#account-name').text(user.username);
    $('.avatar').text(user.username.charAt(0).toUpperCase());
    $('#login-view').addClass('is-hidden');
    $('#chat-view').removeClass('is-hidden');
    historyPrefix = 'chatbot.history.' + encodeURIComponent(user.username.trim().toLowerCase()) + '.';
    dailyQuotaKey = 'chatbot.dailyQuota.' + encodeURIComponent(user.username.trim().toLowerCase());
    if (Number(user.dailyLimit) > 0) {
      maxDailyRequests = Math.floor(Number(user.dailyLimit));
    }
    historyWarningShown = false;
    updateQuotaUI(readDailyQuota());
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
      if (!message.id) message.id = crypto.randomUUID();
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
        notify('Đã đạt giới hạn 4 MB dữ liệu chat trên trình duyệt. Vui lòng tạo bản mới để tiếp tục.', 'error');
        return false;
      }
      localStorage.setItem(chatKey, serialized);
      localStorage.setItem(historyPrefix + 'active', activeValue);
      updateStorageIndicator();
      return true;
    } catch (error) {
      if (!historyWarningShown) notify('Không lưu được lịch sử trên trình duyệt. Dung lượng có thể đã đầy hoặc quyền lưu trữ bị chặn.', 'error');
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
      notify('Không đọc được lịch sử đã lưu trên trình duyệt.', 'info');
    }
    if (!activeConversation()) activeId = conversations.length ? conversations[0].id : null;
    const todayMessages = conversations.reduce((total, chat) => total + chat.messages.filter(message =>
      message.role === 'user' && message.createdAt && new Date(message.createdAt).toDateString() === new Date().toDateString()).length, 0);
    const syncedCount = Math.max(readDailyQuota(), todayMessages);
    writeDailyQuota(syncedCount);
    updateQuotaUI(syncedCount);
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
    $('#session-restore-message').text('Đang khôi phục phiên đăng nhập…');
    let restoreFailed = false;
    loginPending = true;
    const $button = $('#login-form button[type="submit"]');
    $('#login-form').attr('aria-busy', 'true');
    $('#username, #password').prop('readOnly', true);
    $button.prop('disabled', true).addClass('is-loading');
    $button.find('.login-button-label').text('Đang xác thực…');
    try {
      const result = await window.authApi.getSession(token);
      if (readSavedSession() !== token) return;
      if (!result.ok || !result.user) {
        saveSession(null);
        notify('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.', 'info');
        return;
      }
      showSignedIn(token, result.user);
    } catch (error) {
      restoreFailed = true;
      $('.session-restore-spinner').addClass('is-hidden');
      $('#session-restore-message').text('Chưa kết nối được máy chủ. Phiên đăng nhập vẫn được lưu, bạn có thể thử lại.');
      $('#session-restore-actions').removeClass('is-hidden');
    } finally {
      if (!restoreFailed) document.documentElement.classList.remove('restoring-session');
      loginPending = false;
      $('#login-form').attr('aria-busy', 'false');
      $('#username, #password').prop('readOnly', false);
      $button.prop('disabled', false).removeClass('is-loading');
      $button.find('.login-button-label').text('Đăng nhập');
    }
  }
  window.adminPanel.init({
    getToken: function () { return sessionToken; },
    refresh: openAdmin,
    signOut: function () { $('#logout').trigger('click'); },
    onDailyLimitChanged: function (newLimit) {
      if (Number(newLimit) > 0) {
        maxDailyRequests = Math.floor(Number(newLimit));
        updateQuotaUI(readDailyQuota());
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
          $bubble.append('<div class="typing-dots" aria-label="Đang trả lời"><span></span><span></span><span></span></div>');
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
      id: crypto.randomUUID(),
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
      notify('Bot đang trả lời, vui lòng đợi phản hồi xong trước khi gửi tin mới.', 'info');
      return;
    }
    const currentQuota = readDailyQuota();
    if (currentQuota >= maxDailyRequests) {
      updateQuotaUI(currentQuota);
      notify('Bạn đã dùng hết ' + maxDailyRequests + ' lượt hỏi trong ngày hôm nay. Vui lòng quay lại vào ngày mai.', 'error');
      return;
    }

    const model = getSelectedModel();
    if (!activeConversation()) newConversation();
    const conversation = activeConversation();
    if (!conversation) return;

    const prevLength = conversation.messages.length;
    const prevTitle = conversation.title;
    const prevUpdatedAt = conversation.updatedAt;
    const userMessage = { id: crypto.randomUUID(), role: 'user', text: content, createdAt: Date.now() };
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

    const assistantMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      text: '',
      model: model.label,
      streaming: true,
      createdAt: Date.now()
    };
    conversation.messages.push(assistantMessage);

    isBotResponding = true;
    $('#message-input').val('').css('height', '25px');
    updateSendButtonState();
    renderHistory();
    renderMessages();

    try {
      const result = await window.authApi.aiChat(sessionToken, model.key, apiMessages);
      if (!result || !result.ok) {
        throw new Error((result && result.message) || 'Không thể nhận phản hồi từ OpenRouter.');
      }

      const finalReply = String(result.reply || '').trim() || '(Bot không trả về nội dung.)';
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

      if (Number(result.dailyLimit) > 0) {
        maxDailyRequests = Math.floor(Number(result.dailyLimit));
      }
      const nextQuota = Math.max(readDailyQuota() + 1, Number(result.dailyUsed) || 0);
      writeDailyQuota(nextQuota);
      updateQuotaUI(nextQuota);
      renderHistory();
      renderMessages();
    } catch (error) {
      conversation.messages.pop();
      renderMessages();
      notify(error && error.message ? error.message : 'Không thể nhận phản hồi từ OpenRouter.', 'error');
    } finally {
      isBotResponding = false;
      updateSendButtonState();
    }
  }

  $('#login-form').on('submit', function (event) {
    event.preventDefault();
    if (loginPending) return;
    const username = $('#username').val().trim();
    const password = $('#password').val();
    const $button = $('#login-form button[type="submit"]');

    if (!username || !password) {
      $('#username').attr('aria-invalid', String(!username));
      $('#password').attr('aria-invalid', String(!password));
      $( !username ? '#username' : '#password').trigger('focus');
      notify('Vui lòng nhập ' + (!username && !password ? 'tên đăng nhập và mật khẩu.' : !username ? 'tên đăng nhập.' : 'mật khẩu.'), 'error');
      return;
    }
    $('#username, #password').removeAttr('aria-invalid');
    loginPending = true;
    $('#login-form').attr('aria-busy', 'true');
    $('#username, #password').prop('readOnly', true);
    $button.prop('disabled', true).addClass('is-loading');
    $button.find('.login-button-label').text('Đang đăng nhập…');
    const slowLoginTimer = window.setTimeout(function () {
      notify('Hệ thống vẫn đang xử lý đăng nhập. Bạn vui lòng chờ thêm một chút.', 'info');
    }, 8000);
    window.authApi.login(username, password)
      .then(function (result) {
        $('#password').val('');
        if (!result || !result.ok) {
          const message = result && result.message ? result.message : 'Không thể đăng nhập. Vui lòng thử lại.';
          notify(message, 'error');
          return;
        }

        const saved = saveSession(result.token);
        showSignedIn(result.token, result);
        notify(saved ? 'Đăng nhập thành công.' : 'Đăng nhập thành công. Trình duyệt không cho phép lưu phiên đăng nhập.', saved ? 'success' : 'info');
      })
      .catch(function (error) {
        $('#password').val('');
        console.error('Apps Script login failed:', error);
        const message = error.message || 'Không thể kết nối hệ thống đăng nhập. Vui lòng thử lại.';
        notify(message, 'error');
      })
      .finally(function () {
        window.clearTimeout(slowLoginTimer);
        loginPending = false;
        $('#login-form').attr('aria-busy', 'false');
        $('#username, #password').prop('readOnly', false);
        $button.prop('disabled', false).removeClass('is-loading');
        $button.find('.login-button-label').text('Đăng nhập');
      });
  });

  $('#username, #password').on('input', function () {
    $(this).removeAttr('aria-invalid');
  });

  $('.password-toggle').on('click', function () {
    const showPassword = $('#password').attr('type') === 'password';
    $('#password').attr('type', showPassword ? 'text' : 'password');
    $(this)
      .attr('aria-pressed', String(showPassword))
      .attr('aria-label', showPassword ? 'Hide password' : 'Show password')
      .text(showPassword ? 'Hide' : 'Show');
  });

  $('#logout, #admin-logout').on('click', function () {
    const token = sessionToken;
    saveSession(null);
    sessionToken = null;
    sessionRole = null;
    isBotResponding = false;
    closeSessionChoiceModal();
    $('#history-sync-status').text('Lưu trên trình duyệt (tối đa 4 MB)');
    $('#storage-limit-badge').text('0 KB / 4 MB').removeClass('is-warning is-full');
    historyPrefix = null;
    dailyQuotaKey = null;
    window.adminPanel.clear();
    $('#account-role').text('Standard');
    $('#admin-view, #open-admin').addClass('is-hidden');
    $('#admin-username, #admin-checked-at').text('—');
    $('#admin-api-status').text('Chưa kiểm tra');
    $('#chat-view').addClass('is-hidden');
    $('#login-view').removeClass('is-hidden');
    $('#username, #password').val('');
    $('#account-name').text('Guest');
    $('.avatar').text('G');
    $('.password-toggle').attr({ 'aria-pressed': 'false', 'aria-label': 'Show password' }).text('Show');
    $('#username, #password').removeAttr('aria-invalid');
    closeMobileNav();
    conversations.length = 0;
    activeId = null;
    requestCount = 0;
    renderHistory();
    renderMessages();
    $('#quota-count').text('0 / ' + maxDailyRequests);
    $('#quota-bar').css('width', '0%');
    $('#password').attr('type', 'password');
    $('#message-input').val('').css('height', '25px');
    $('#send-button').prop('disabled', true);
    if (token) {
      window.authApi.logout(token).catch(function (error) {
        notify('Đã thoát trên trình duyệt nhưng chưa thu hồi được phiên trên máy chủ.', 'error');
      });
    }
  });

  async function openAdmin() {
    if (!sessionToken || sessionRole !== 'admin' || adminCheckPending) return;
    const checkedToken = sessionToken;
    const alreadyOpen = !$('#admin-view').hasClass('is-hidden');
    adminCheckPending = true;
    $('#open-admin, #admin-refresh').prop('disabled', true).attr('aria-busy', 'true');
    $('#admin-api-status').text('Đang kiểm tra…');
    try {
      const result = await window.authApi.adminDashboard(checkedToken);
      if (sessionToken !== checkedToken) return;
      if (!result.ok && result.code !== 'FORBIDDEN') {
        throw new Error(result.message || 'Hãy cập nhật backend và chạy setupAdminSheets.');
      }
      if (!result.ok || !result.user || result.user.role !== 'admin') {
        $('#logout').trigger('click');
        notify('Phiên đã hết hạn hoặc không có quyền quản trị. Vui lòng đăng nhập lại.', 'error');
        return;
      }
      $('#admin-username').text(result.user.username);
      window.adminPanel.render(result);
      $('#admin-api-status').text('Đã kết nối');
      $('#admin-checked-at').text(new Date().toLocaleTimeString('vi-VN'));
      closeMobileNav();
      $('#chat-view').addClass('is-hidden');
      $('#admin-view').removeClass('is-hidden');
      if (!alreadyOpen) $('#admin-title').trigger('focus');
      else notify('Kết nối và quyền quản trị đã được xác nhận.', 'success');
    } catch (error) {
      if (sessionToken !== checkedToken) return;
      $('#admin-api-status').text('Không thể kết nối');
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
    $('#open-admin').trigger('focus');
  });

  function requestNewChat() {
    if (!sessionToken) return;
    if (isBotResponding) {
      notify('Bot đang trả lời, vui lòng đợi xong trước khi tạo phiên mới.', 'info');
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

  $('#message-form').on('submit', function (event) {
    event.preventDefault();
    sendMessage($('#message-input').val());
  });
  $('#message-input').on('input', function () {
    this.style.height = '25px';
    this.style.height = Math.min(this.scrollHeight, 150) + 'px';
    updateSendButtonState();
  }).on('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (isBotResponding) {
        notify('Bot đang trả lời, bạn vẫn có thể nhập tiếp nhưng chưa thể gửi.', 'info');
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
      notify('Model trả phí đang bị khoá. Chỉ có thể dùng chế độ Auto miễn phí.', 'info');
      return;
    }
    notify('Đã chọn model: ' + selected.label, 'info');
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
    notify('Đã xoá dữ liệu cũ và tạo cuộc trò chuyện mới.', 'info');
  });
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
