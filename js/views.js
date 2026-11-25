(function () {
  'use strict';

  const VERSION = '20261125-6';

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = function () { reject(new Error('Không tải được ' + src)); };
      document.body.appendChild(script);
    });
  }

  async function mountViews() {
    const slots = Array.prototype.slice.call(document.querySelectorAll('[data-include]'));
    const htmlList = await Promise.all(
      slots.map(function (slot) {
        const path = slot.getAttribute('data-include') + '?v=' + VERSION;
        return fetch(path, { credentials: 'same-origin' }).then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status + ' loading ' + path);
          return res.text();
        });
      })
    );

    slots.forEach(function (slot, index) {
      slot.outerHTML = htmlList[index];
    });

    await loadScript('js/admin.js?v=' + VERSION);
    await loadScript('js/app.js?v=' + VERSION);
  }

  mountViews().catch(function (error) {
    console.error('Failed to initialize views:', error);
    if (typeof window.notifyUser === 'function') {
      window.notifyUser({ type: 'error', message: 'Không thể tải giao diện ứng dụng. Vui lòng tải lại trang.' });
    }
  });
})();
