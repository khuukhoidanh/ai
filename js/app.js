$(function () {
  const conversations = [];
  let activeId = null;
  let requestCount = 0;
  let sessionToken = null;
  let loginPending = false;
  let sessionRole = null;
  let historyPrefix = null;
  let historyWarningShown = false;
  let discordReady = false;
  let discordConnecting = false;
  let discordSaving = false;
  let discordEpoch = 0;
  const discordQueue = new Map();
  let adminCheckPending = false;
  const sessionStorageKey = 'chatbot.sessionToken';

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
    historyWarningShown = false;
    loadHistory();
    connectDiscord();
  }

  function saveConversation(conversation, localOnly) {
    if (!historyPrefix || !conversation) return;
    conversation.messages.forEach(function (message) {
      if (!message.id) message.id = crypto.randomUUID();
      if (!Number.isFinite(message.createdAt)) message.createdAt = conversation.createdAt || Date.now();
    });
    try {
      localStorage.setItem(historyPrefix + 'chat.' + conversation.id, JSON.stringify(conversation));
      localStorage.setItem(historyPrefix + 'active', String(activeId));
    } catch (error) {
      if (!historyWarningShown) notify('Không lưu được lịch sử trên trình duyệt. Dung lượng có thể đã đầy hoặc quyền lưu trữ bị chặn.', 'error');
      historyWarningShown = true;
    }
    if (!localOnly && discordReady && !conversation.cloudLoading) {
      discordQueue.set(conversation.id, conversation);
      flushDiscord();
    }
  }

  async function flushDiscord() {
    if (discordSaving || !discordReady || !sessionToken) return;
    const epoch = discordEpoch, token = sessionToken;
    discordSaving = true;
    $('#history-sync-status').text('Đang lưu lên Discord…');
    try {
      while (discordQueue.size && epoch === discordEpoch) {
        const [id, chat] = discordQueue.entries().next().value;
        discordQueue.delete(id);
        const snapshot = { id: chat.id, title: chat.title, messages: chat.messages.slice() };
        try {
          for (let offset = 0; offset < Math.max(1, snapshot.messages.length); offset += 100) {
            let result;
            do {
              result = await window.authApi.discordSave(token, Object.assign({}, snapshot, { messages: snapshot.messages.slice(offset, offset + 100) }));
              if (epoch !== discordEpoch) return;
              if (!result.ok) throw new Error(result.message || 'Backend chưa hỗ trợ đồng bộ Discord.');
            } while (result.remaining > 0);
          }
        } catch (error) {
          if (epoch === discordEpoch) discordQueue.set(id, chat);
          throw error;
        }
      }
      if (epoch === discordEpoch) $('#history-sync-status').text('Đã đồng bộ Discord');
    } catch (error) {
      if (epoch === discordEpoch) {
        $('#history-sync-status').text('Chưa đồng bộ · bấm thử lại');
        notify(error.message, 'error');
      }
    } finally { if (epoch === discordEpoch) discordSaving = false; }
  }

  async function readDiscordChat(chat) {
    if (!chat.cloudPending || chat.cloudLoading || !discordReady) return;
    const token = sessionToken, epoch = discordEpoch;
    chat.cloudLoading = true;
    $('#history-sync-status').text('Đang tải nội dung chat…');
    try {
      let before = null;
      const messages = new Map(chat.messages.map(message => [message.id, message]));
      do {
        const result = await window.authApi.discordLoad(token, chat.id, before);
        if (epoch !== discordEpoch) return;
        if (!result.ok) throw new Error(result.message || 'Không tải được lịch sử Discord.');
        result.messages.forEach(message => messages.set(message.id, message));
        before = result.before;
      } while (before);
      chat.messages = Array.from(messages.values()).sort((a, b) => a.createdAt - b.createdAt);
      chat.cloudPending = false;
      chat.cloudLoading = false;
      saveConversation(chat, true);
      if (activeId === chat.id) renderMessages();
      $('#history-sync-status').text('Đã tải lịch sử Discord');
    } catch (error) {
      if (epoch === discordEpoch) {
        $('#history-sync-status').text('Chưa tải xong · bấm thử lại');
        notify(error.message, 'error');
      }
    } finally { chat.cloudLoading = false; }
  }

  async function connectDiscord() {
    if (!sessionToken || discordConnecting || discordSaving) return;
    const token = sessionToken, epoch = discordEpoch;
    discordConnecting = true;
    $('#history-sync-retry').prop('disabled', true);
    $('#history-sync-status').text('Đang kết nối Discord…');
    try {
      const result = await window.authApi.discordList(token);
      if (epoch !== discordEpoch) return;
      if (!result.ok || !Array.isArray(result.chats)) throw new Error(result.message || 'Cần cập nhật backend Discord.');
      discordReady = true;
      const local = conversations.slice();
      result.chats.forEach(function (remote) {
        const existing = conversations.find(chat => chat.id === remote.id);
        if (existing) existing.cloudPending = true;
        else conversations.push(Object.assign({}, remote, { messages: [], cloudPending: true }));
      });
      renderHistory();
      if (activeConversation()) await readDiscordChat(activeConversation());
      if (epoch !== discordEpoch) return;
      local.forEach(chat => { saveConversation(chat, true); discordQueue.set(chat.id, chat); });
      await flushDiscord();
    } catch (error) {
      if (epoch === discordEpoch) {
        $('#history-sync-status').text('Chỉ lưu cục bộ · thử lại');
        notify(error.message, 'info');
      }
    } finally {
      if (epoch === discordEpoch) {
        discordConnecting = false;
        $('#history-sync-retry').prop('disabled', false);
      }
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
    requestCount = conversations.reduce((total, chat) => total + chat.messages.filter(message =>
      message.role === 'user' && message.createdAt && new Date(message.createdAt).toDateString() === new Date().toDateString()).length, 0);
    $('#quota-count').text(requestCount + ' / 200');
    $('#quota-bar').css('width', Math.min(requestCount / 200 * 100, 100) + '%');
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
    signOut: function () { $('#logout').trigger('click'); }
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
        readDiscordChat(conversation);
        closeMobileNav();
      });
      (conversation.yesterday ? $yesterday : $recent).append($item);
    });
  }

  function renderMessages() {
    const $messages = $('#messages').empty();
    const conversation = activeConversation();
    if (conversation && conversation.cloudPending && !conversation.messages.length) {
      $messages.append($('<p>').text('Đang tải lịch sử từ Discord. Nếu chưa tải được, bấm nút đồng bộ ở thanh bên.'));
      return;
    }
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
      const $bubble = $('<div>', { class: 'message-bubble' }).text(message.text);
      if (message.role === 'assistant') {
        $('<div>', { class: 'reply-note' })
          .text('Preview only — AI service is not connected.')
          .appendTo($bubble);
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
    const empty = conversations.find(chat => chat.messages.length === 0 && !chat.cloudPending);
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

  function sendMessage(text) {
    const content = (text || '').trim();
    if (!content || !sessionToken) return;
    if (!activeConversation()) newConversation();
    const conversation = activeConversation();
    if (!conversation) return;
    if (conversation.cloudPending || conversation.cloudLoading) { notify('Vui lòng tải xong lịch sử trước khi gửi tin nhắn.', 'info'); return; }

    conversation.messages.push({ role: 'user', text: content, createdAt: Date.now() });
    if (conversation.messages.length === 1) {
      conversation.title = content.length > 34 ? content.slice(0, 34).trim() + '…' : content;
    }
    conversation.messages.push({
      role: 'assistant',
      text: 'Your message is ready. Connect the backend to receive an AI response.'
    });
    requestCount += 1;
    conversation.updatedAt = Date.now();
    saveConversation(conversation);
    $('#quota-count').text(requestCount + ' / 200');
    $('#quota-bar').css('width', Math.min(requestCount / 200 * 100, 100) + '%');
    $('#message-input').val('').css('height', '25px');
    $('#send-button').prop('disabled', true);
    renderHistory();
    renderMessages();
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
    discordEpoch++;
    discordReady = false;
    discordConnecting = false;
    discordSaving = false;
    discordQueue.clear();
    $('#history-sync-retry').prop('disabled', false);
    $('#history-sync-status').text('Lịch sử trên trình duyệt');
    historyPrefix = null;
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
    $('#quota-count').text('0 / 200');
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

  $('#new-chat').on('click', newConversation);
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
    $('#send-button').prop('disabled', !this.value.trim());
  }).on('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      $('#message-form').trigger('submit');
    }
  });
  $('#model-select').on('change', function () {
    const group = $(this).find(':selected').closest('optgroup').attr('label');
    notify(group === 'Free'
      ? 'Model selected. AI is not connected in this preview.'
      : 'This model may have usage limits or cost. No request was sent.');
  });
  $(document).on('keydown', function (event) {
    if (event.key === 'Escape') closeMobileNav();
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !$('#chat-view').hasClass('is-hidden')) {
      event.preventDefault();
      newConversation();
    }
  });
  window.addEventListener('storage', function (event) {
    if ((event.key === sessionStorageKey || event.key === null) && !readSavedSession() && sessionToken) {
      $('#logout').trigger('click');
    }
  });
  $('#session-retry').on('click', restoreSession);
  $('#history-sync-retry').on('click', connectDiscord);
  $('#session-login').on('click', function () {
    saveSession(null);
    document.documentElement.classList.remove('restoring-session');
    $('#username').trigger('focus');
  });
  restoreSession();
});
