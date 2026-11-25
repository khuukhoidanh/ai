(function () {
  const icons = {
    success: 'fa-circle-check',
    error: 'fa-circle-exclamation',
    info: 'fa-circle-info'
  };
  let hideTimer;

  window.notifyUser = function (notification) {
    const options = notification || {};
    const type = Object.prototype.hasOwnProperty.call(icons, options.type) ? options.type : 'info';
    const message = typeof options.message === 'string' ? options.message.trim() : '';
    const developerDetails = options.developer;

    if (developerDetails !== undefined) {
      console.log('[developer]', developerDetails);
    }
    if (!message) {
      console.log('[developer] Notification skipped: no user-facing message was provided.');
      return;
    }

    const $toast = $('.app-notification').first();
    if (!$toast.length) {
      console.log('[developer] Notification could not be displayed:', message);
      return;
    }

    const assertive = type === 'error';
    $toast
      .empty()
      .removeClass('toast--success toast--error toast--info')
      .addClass('toast--' + type)
      .attr({
        role: assertive ? 'alert' : 'status',
        'aria-live': assertive ? 'assertive' : 'polite',
        'aria-atomic': 'true'
      });
    $('<span>', { class: 'toast-icon', 'aria-hidden': 'true' })
      .append($('<i>', { class: 'fa-solid ' + icons[type] }))
      .appendTo($toast);
    $('<span>', { class: 'toast-message' }).text(message).appendTo($toast);
    $toast.addClass('visible');

    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(function () {
      $toast.removeClass('visible');
    }, type === 'error' ? 5000 : 3200);
  };
})();
