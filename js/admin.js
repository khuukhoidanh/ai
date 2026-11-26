(function () {
  let options;
  let users = [];
  let auditEntries = [];
  let lastUsage = null;
  let busy = false;
  let currentUsername = '';
  let currentPage = 'admin-overview';

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

  const pageKeys = {
    'admin-overview': ['admin.pageOverviewTitle', 'admin.pageOverviewDesc', 'Tổng quan ứng dụng', 'Các số liệu tổng hợp về tài khoản và sử dụng AI.'],
    'admin-analytics': ['admin.pageAnalyticsTitle', 'admin.pageAnalyticsDesc', 'Sử dụng AI', 'Theo dõi token và phân bổ sử dụng theo tài khoản.'],
    'admin-users-section': ['admin.pageUsersTitle', 'admin.pageUsersDesc', 'Quản lý tài khoản', 'Tìm kiếm, đổi quyền, khoá tài khoản và đặt lại mật khẩu.'],
    'admin-create-section': ['admin.pageCreateTitle', 'admin.pageCreateDesc', 'Tạo tài khoản mới', 'Cấp tài khoản Standard, Vip hoặc Admin cho người dùng.'],
    'admin-system-section': ['admin.pageSystemTitle', 'admin.pageSystemDesc', 'Hệ thống', 'Kiểm tra trạng thái kết nối và cấu hình phân quyền.'],
    'admin-audit-section': ['admin.pageAuditTitle', 'admin.pageAuditDesc', 'Nhật ký hoạt động', 'Theo dõi các thao tác quản trị gần nhất.']
  };

  function showPage(page, focus) {
    if (!pageKeys[page]) return;
    currentPage = page;
    const $panels = $('#admin-view [data-admin-page]');
    const $selected = $panels.filter(function () { return this.dataset.adminPage === page; });
    if (!$selected.length) return;
    $panels.addClass('is-hidden').removeClass('admin-page-enter');
    $selected.removeClass('is-hidden').addClass('admin-page-enter');
    $('#admin-editor').addClass('is-hidden');
    $('#admin-edit-password, #admin-create-password').val('');
    $('.admin-nav a').each(function () {
      const selected = $(this).attr('href') === '#' + page;
      $(this).toggleClass('active', selected);
      if (selected) $(this).attr('aria-current', 'page');
      else $(this).removeAttr('aria-current');
    });
    const meta = pageKeys[page];
    $('#admin-title, .admin-breadcrumb strong').text(t(meta[0], null, meta[2]));
    $('.admin-intro p:not(.admin-eyebrow)').text(t(meta[1], null, meta[3]));
    if (focus) {
      window.scrollTo(0, 0);
      $('#admin-title').trigger('focus');
    }
  }

  const roles = { standard: 'Standard', vip: 'Vip', admin: 'Admin' };
  const actionKeyMap = {
    create: ['admin.actCreate', 'Tạo tài khoản'],
    update: ['admin.actUpdate', 'Đổi quyền / trạng thái'],
    resetPassword: ['admin.actResetPassword', 'Đặt lại mật khẩu'],
    revokeSessions: ['admin.actRevokeSessions', 'Thu hồi phiên'],
    delete: ['admin.actDelete', 'Xoá tài khoản'],
    setDailyLimit: ['admin.actSetDailyLimit', 'Đổi giới hạn lượt/ngày']
  };
  const number = value => window.appI18n && typeof window.appI18n.formatNumber === 'function'
    ? window.appI18n.formatNumber(value)
    : Number(value || 0).toLocaleString('vi-VN');
  const date = value => window.appI18n && typeof window.appI18n.formatDate === 'function'
    ? window.appI18n.formatDate(value)
    : (value && !isNaN(Date.parse(value)) ? new Date(value).toLocaleString('vi-VN') : '—');
  const notify = (message, type) => window.notifyUser({ message: message, type: type || 'error' });

  function renderCharts() {
    const colors = ['#7183e7', '#76cfbc', '#b69ae8'];
    const counts = Object.keys(roles).map(role => users.filter(user => user.role === role).length);
    let offset = 0;
    const stops = counts.map(function (count, index) {
      const start = offset;
      offset += users.length ? count / users.length * 100 : 0;
      return colors[index] + ' ' + start + '% ' + offset + '%';
    });
    $('#admin-role-chart').css('background', users.length ? 'conic-gradient(' + stops.join(',') + ')' : '#edf0f6')
      .attr('aria-label', Object.keys(roles).map((role, i) => roles[role] + ': ' + counts[i]).join(', '));
    $('#admin-role-total').text(number(users.length));
    const legend = $('#admin-role-legend').empty();
    Object.keys(roles).forEach(function (role, index) {
      const item = $('<span>');
      $('<i>', { class: 'legend-dot', 'aria-hidden': 'true' }).css('background', colors[index]).appendTo(item);
      $('<span>').text(roles[role] + ' ' + number(counts[index])).appendTo(item);
      legend.append(item);
    });
    const chart = $('#admin-token-chart').empty();
    const ranked = users.filter(user => user.usage.inputTokens + user.usage.outputTokens > 0)
      .slice().sort((a, b) => (b.usage.inputTokens + b.usage.outputTokens) - (a.usage.inputTokens + a.usage.outputTokens)).slice(0, 8);
    if (!ranked.length) {
      const empty = $('<div>', { class: 'admin-chart-empty' });
      $('<i>', { class: 'fa-solid fa-chart-column', 'aria-hidden': 'true' }).appendTo(empty);
      $('<strong>').text(t('admin.chartEmptyTitle', null, 'Chưa có dữ liệu token AI')).appendTo(empty);
      $('<p>').text(t('admin.chartEmptyDesc', null, 'Biểu đồ sẽ xuất hiện khi có sử dụng AI thực tế được ghi nhận.')).appendTo(empty);
      chart.append(empty);
      return;
    }
    const max = ranked[0].usage.inputTokens + ranked[0].usage.outputTokens;
    ranked.forEach(function (user) {
      const input = user.usage.inputTokens, output = user.usage.outputTokens;
      const row = $('<div>', { class: 'admin-bar-row', role: 'img', 'aria-label': user.username + ': ' + number(input) + ' ' + t('admin.legendInput', null, 'đầu vào') + ', ' + number(output) + ' ' + t('admin.legendOutput', null, 'đầu ra') });
      $('<span>', { class: 'admin-bar-name', title: user.username }).text(user.username).appendTo(row);
      const track = $('<div>', { class: 'admin-bar-track', 'aria-hidden': 'true' });
      $('<span>', { class: 'admin-bar-input' }).css('width', input / max * 100 + '%').appendTo(track);
      $('<span>', { class: 'admin-bar-output' }).css('width', output / max * 100 + '%').appendTo(track);
      row.append(track);
      $('<span>', { class: 'admin-bar-value' }).text(number(input + output)).appendTo(row);
      chart.append(row);
    });
  }

  function renderUsers() {
    const query = ($('#admin-search').val() || '').trim().toLowerCase();
    const role = $('#admin-role-filter').val();
    const body = $('#admin-users-body').empty();
    const filtered = users.filter(user => user.username.toLowerCase().includes(query) && (!role || user.role === role));
    const manageLabel = t('admin.manageBtn', null, 'Quản lý');
    const deleteLabel = t('admin.deleteBtn', null, 'Xoá');
    filtered.forEach(function (user) {
      const row = $('<tr>');
      const statusText = user.status === 'disabled'
        ? t('admin.statusDisabled', null, 'Đã khoá')
        : t('admin.statusActive', null, 'Hoạt động');
      [user.username, roles[user.role], statusText,
        number(user.usage.inputTokens) + ' / ' + number(user.usage.outputTokens), date(user.lastLogin)].forEach(value => $('<td>').text(value).appendTo(row));
      const cell = $('<td>').appendTo(row);
      $('<button>', { type: 'button', class: 'admin-button', text: manageLabel, 'aria-label': manageLabel + ' ' + user.username })
        .prop('disabled', busy).on('click', function () { edit(user); }).appendTo(cell);
      $('<button>', { type: 'button', class: 'admin-button admin-danger admin-delete-button', text: deleteLabel, 'aria-label': deleteLabel + ' ' + user.username })
        .prop('disabled', busy || user.username.toLowerCase() === currentUsername.toLowerCase())
        .on('click', function () { edit(user, 'delete'); }).appendTo(cell);
      body.append(row);
    });
    if (!filtered.length) body.append($('<tr>').append($('<td>', { colspan: 6, text: t('admin.noMatchingUsers', null, 'Không có tài khoản phù hợp.') })));
  }

  function renderAudit() {
    const body = $('#admin-audit-body').empty();
    auditEntries.forEach(function (item) {
      const row = $('<tr>');
      const actionMeta = actionKeyMap[item.action];
      const actionLabel = actionMeta ? t(actionMeta[0], null, actionMeta[1]) : item.action;
      [date(item.timestamp), item.actor, actionLabel, item.target].forEach(value => $('<td>').text(value).appendTo(row));
      body.append(row);
    });
    if (!auditEntries.length) body.append($('<tr>').append($('<td>', { colspan: 4, text: t('admin.noAuditYet', null, 'Chưa có thao tác quản trị.') })));
  }

  function renderSummaryStats() {
    if (!users.length && !lastUsage) return;
    $('#admin-user-count').text(number(users.length));
    $('#admin-active-count').text(t('admin.activeAccountsCount', { count: number(users.filter(user => user.status === 'active').length) }, number(users.filter(user => user.status === 'active').length) + ' đang hoạt động'));
    if (lastUsage) {
      $('#admin-input-count').text(lastUsage.requests ? number(lastUsage.inputTokens) : '—');
      $('#admin-output-count').text(lastUsage.requests ? number(lastUsage.outputTokens) : '—');
      $('#admin-token-count').text(lastUsage.requests ? number(lastUsage.inputTokens + lastUsage.outputTokens) : '—');
      $('#admin-token-detail').text(lastUsage.requests
        ? t('admin.tokenDetailSummary', { input: number(lastUsage.inputTokens), output: number(lastUsage.outputTokens), requests: number(lastUsage.requests) }, 'Vào: ' + number(lastUsage.inputTokens) + ' · Ra: ' + number(lastUsage.outputTokens) + ' · ' + number(lastUsage.requests) + ' yêu cầu')
        : t('admin.noUsageYet', null, 'Chưa ghi nhận sử dụng AI thực tế'));
    }
  }

  function fields() {
    const operation = $('#admin-operation').val();
    $('#admin-role-field').toggleClass('is-hidden', !['create', 'update'].includes(operation));
    $('#admin-status-field').toggleClass('is-hidden', operation !== 'update');
    $('#admin-password-field').toggleClass('is-hidden', !['create', 'resetPassword'].includes(operation));
    $('#admin-edit-password').val('');
    $('#admin-delete-field').toggleClass('is-hidden', operation !== 'delete');
    $('#admin-delete-confirm').val('');
    $('#admin-save-user')
      .toggleClass('admin-danger', operation === 'delete')
      .text(operation === 'delete' ? t('admin.confirmDeleteBtn', null, 'Xác nhận xoá tài khoản') : t('admin.confirmSaveBtn', null, 'Xác nhận thay đổi'));
  }

  function edit(user, operation) {
    if (busy) return;
    $('#admin-editor-title').text(t('admin.manageUserTitle', { username: user.username }, 'Quản lý: ' + user.username));
    $('#admin-edit-username').val(user.username).prop('readOnly', true);
    $('#admin-edit-role').val(user.role);
    $('#admin-edit-status').val(user.status);
    $('#admin-operation option[value="delete"]').prop('disabled', user.username.toLowerCase() === currentUsername.toLowerCase());
    $('#admin-operation').val(operation || 'update');
    fields();
    $('#admin-editor').removeClass('is-hidden');
    document.getElementById('admin-editor').scrollIntoView({ block: 'nearest' });
    $('#admin-editor-title').trigger('focus');
  }

  function clear() {
    users = [];
    auditEntries = [];
    lastUsage = null;
    currentUsername = '';
    $('#admin-users-body, #admin-audit-body').empty();
    $('#admin-user-count, #admin-token-count, #admin-input-count, #admin-output-count').text('—');
    renderCharts();
    showPage('admin-overview', false);
    document.getElementById('admin-create-form').reset();
    $('#admin-active-count').text(t('common.notLoaded', null, 'Chưa tải dữ liệu'));
    $('#admin-token-detail').text(t('admin.noUsageYet', null, 'Chưa có dữ liệu sử dụng AI'));
    $('#admin-editor').addClass('is-hidden');
    $('#admin-edit-password, #admin-edit-username, #admin-search').val('');
    $('#admin-role-filter').val('');
  }

  window.adminPanel = {
    clear: clear,
    init: function (config) {
      options = config;
      showPage('admin-overview', false);
      $('.admin-nav a').on('click', function (event) {
        event.preventDefault();
        if (busy) { notify(t('admin.busySwitching', null, 'Đang lưu thay đổi, vui lòng chờ hoàn tất trước khi chuyển mục.'), 'info'); return; }
        showPage($(this).attr('href').slice(1), true);
      });
      $('#admin-search').on('input', renderUsers);
      $('#admin-role-filter').on('change', renderUsers);
      $('#admin-create-cancel').on('click', function () { showPage('admin-users-section', true); });
      $('#admin-operation').on('change', fields);
      $('#admin-daily-limit-form').on('submit', async function (event) {
        event.preventDefault();
        if (busy) return;
        const token = options.getToken();
        if (!token) return;
        const limit = Number($('#admin-daily-limit-input').val());
        if (!Number.isInteger(limit) || limit < 1 || limit > 10000) {
          notify(t('admin.invalidLimit', null, 'Giới hạn phải là số nguyên từ 1 đến 10.000.'));
          $('#admin-daily-limit-input').trigger('focus');
          return;
        }
        busy = true;
        $('#admin-daily-limit-submit, #admin-daily-limit-input').prop('disabled', true);
        $('#admin-daily-limit-submit').text(t('common.saving', null, 'Đang lưu…'));
        try {
          const result = await window.authApi.adminSetDailyLimit(token, limit);
          if (options.getToken() !== token) return;
          if (!result.ok) {
            if (result.code === 'FORBIDDEN') options.signOut();
            throw new Error(tServer(result, 'admin.limitSaveError'));
          }
          if (typeof options.onDailyLimitChanged === 'function') {
            options.onDailyLimitChanged(result.dailyLimit);
          }
          notify(t('admin.limitUpdated', { limit: result.dailyLimit }, 'Đã cập nhật giới hạn thành ' + result.dailyLimit + ' lượt/ngày.'), 'success');
          await options.refresh();
        } catch (error) {
          if (options.getToken() === token || !options.getToken()) notify(error.message);
        } finally {
          busy = false;
          $('#admin-daily-limit-submit, #admin-daily-limit-input').prop('disabled', false);
          $('#admin-daily-limit-submit').text(t('admin.saveLimitBtn', null, 'Lưu giới hạn'));
        }
      });
      $('#admin-cancel-edit, #admin-back').on('click', function () { $('#admin-editor').addClass('is-hidden'); $('#admin-edit-password, #admin-create-password').val(''); });
      $('#admin-user-form, #admin-create-form').on('submit', async function (event) {
        event.preventDefault();
        if (busy) return;
        const token = options.getToken();
        if (!token) return;
        const creating = this.id === 'admin-create-form';
        const data = creating
          ? { operation: 'create', username: $('#admin-create-username').val().trim(), role: $('#admin-create-role').val() }
          : { operation: $('#admin-operation').val(), username: $('#admin-edit-username').val().trim(), role: $('#admin-edit-role').val(), status: $('#admin-edit-status').val() };
        const $password = $(creating ? '#admin-create-password' : '#admin-edit-password');
        if (!data.username || /^[=+@-]/.test(data.username)) { notify(t('admin.invalidAccountName', null, 'Nhập tên tài khoản hợp lệ, không bắt đầu bằng =, +, @ hoặc -.')); return; }
        if (data.operation === 'delete') {
          data.confirmUsername = $('#admin-delete-confirm').val();
          if (data.confirmUsername !== data.username) {
            notify(t('admin.confirmDeleteName', null, 'Nhập chính xác tên tài khoản để xác nhận xoá.'));
            $('#admin-delete-confirm').trigger('focus');
            return;
          }
        }
        if (['create', 'resetPassword'].includes(data.operation)) {
          data.password = $password.val();
          if (data.password.length < 8 || data.password.length > 256) { notify(t('msg.invalidPasswordLen', null, 'Mật khẩu cần từ 8 đến 256 ký tự.')); $password.trigger('focus'); return; }
        }
        busy = true;
        $('#admin-user-fields, #admin-create-fields').prop('disabled', true);
        $(this).attr('aria-busy', 'true');
        $('#admin-save-user, #admin-create-submit').text(t('common.saving', null, 'Đang lưu…'));
        renderUsers();
        try {
          const result = await window.authApi.adminManageUser(token, data);
          if (options.getToken() !== token) return;
          if (!result.ok) {
            if (result.code === 'FORBIDDEN') options.signOut();
            throw new Error(tServer(result, 'admin.saveError'));
          }
          $('#admin-editor').addClass('is-hidden');
          if (result.sessionRevoked) {
            options.signOut();
            notify(t('admin.savedRevoked', null, 'Đã lưu. Vui lòng đăng nhập lại vì phiên của bạn đã được thu hồi.'), 'success');
          } else {
            notify(data.operation === 'delete' ? t('admin.deletedAccount', null, 'Đã xoá tài khoản.') : t('admin.savedChanges', null, 'Đã lưu thay đổi.'), 'success');
            if (creating) document.getElementById('admin-create-form').reset();
            showPage('admin-users-section', true);
            await options.refresh();
          }
        } catch (error) {
          if (options.getToken() === token || !options.getToken()) notify(error.message);
        } finally {
          delete data.password;
          $password.val('');
          busy = false;
          $('#admin-user-fields, #admin-create-fields').prop('disabled', false);
          $(this).attr('aria-busy', 'false');
          $('#admin-save-user').text(t('common.saveChanges', null, 'Lưu thay đổi'));
          $('#admin-create-submit').text(t('admin.createSubmit', null, 'Tạo tài khoản'));
          renderUsers();
        }
      });
      if (typeof window !== 'undefined' && window.appI18n && typeof window.appI18n.onChange === 'function') {
        window.appI18n.onChange(function () {
          const meta = pageKeys[currentPage];
          if (meta) {
            $('#admin-title, .admin-breadcrumb strong').text(t(meta[0], null, meta[2]));
            $('.admin-intro p:not(.admin-eyebrow)').text(t(meta[1], null, meta[3]));
          }
          renderSummaryStats();
          renderUsers();
          renderCharts();
          renderAudit();
          if (!$('#admin-editor').hasClass('is-hidden') && $('#admin-edit-username').val()) {
            $('#admin-editor-title').text(t('admin.manageUserTitle', { username: $('#admin-edit-username').val() }, 'Quản lý: ' + $('#admin-edit-username').val()));
            fields();
          }
        });
      }
    },
    render: function (result) {
      currentUsername = result.user.username;
      users = result.users;
      auditEntries = result.audit || [];
      lastUsage = result.usage;
      if (Number(result.dailyLimit) > 0) {
        $('#admin-daily-limit-input').val(result.dailyLimit);
        if (options && typeof options.onDailyLimitChanged === 'function') {
          options.onDailyLimitChanged(result.dailyLimit);
        }
      }
      renderSummaryStats();
      renderUsers();
      renderCharts();
      renderAudit();
    }
  };
})();
