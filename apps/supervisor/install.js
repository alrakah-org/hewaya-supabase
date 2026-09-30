/* Installation is independent of login/API initialization. */
(() => {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
  const key = 'hawaya-supervisor-installed';
  let promptEvent = null;
  let installed = false;
  const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const button = document.getElementById('installBtn');
  const overlay = document.getElementById('iosInstallOverlay');
  if (!button || !overlay) return;
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.style.cssText = 'font-size:.82rem;line-height:1.8;text-align:center';
  button.after(status);
  function remember(value) {
    installed = value;
    try { if (value) localStorage.setItem(key, '1'); else localStorage.removeItem(key); } catch (_) {}
  }
  function render() {
    const hide = installed || standalone();
    button.classList.toggle('hidden', hide);
    if (hide) { overlay.classList.add('hidden'); status.textContent = ''; }
  }
  try { installed = localStorage.getItem(key) === '1'; } catch (_) {}
  if (standalone()) remember(true);
  render();
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    promptEvent = event;
    // A new offer also means a previous installation was removed.
    remember(false);
    render();
    status.textContent = '';
  });
  window.addEventListener('appinstalled', () => {
    promptEvent = null;
    remember(true);
    render();
  });
  const mode = window.matchMedia('(display-mode: standalone)');
  mode.addEventListener?.('change', () => { if (standalone()) remember(true); render(); });
  window.addEventListener('storage', event => { if (event.key === key) { installed = event.newValue === '1'; render(); } });
  document.getElementById('closeIosHint')?.addEventListener('click', () => overlay.classList.add('hidden'));
  button.addEventListener('click', async () => {
    if (installed || standalone()) { render(); return; }
    if (ios) { overlay.classList.remove('hidden'); return; }
    if (!promptEvent) {
      status.textContent = 'لم يوفّر المتصفح نافذة التثبيت بعد. افتح الرابط في Chrome خارج واتساب، ثم اختر من قائمته «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية». لن يبدأ تنزيل دون موافقتك.';
      return;
    }
    const event = promptEvent;
    promptEvent = null;
    button.disabled = true;
    try {
      await event.prompt();
      const choice = await event.userChoice;
      status.textContent = choice.outcome === 'accepted' ? 'تم قبول الطلب؛ انتظر اكتمال التثبيت من المتصفح.' : 'تم إلغاء التثبيت. يمكنك المحاولة من قائمة المتصفح.';
      // Acceptance is not proof of completion: only appinstalled hides the button.
    } catch (_) {
      status.textContent = 'تعذّر فتح نافذة التثبيت. جرّب خيار التثبيت من قائمة Chrome.';
    } finally { button.disabled = false; render(); }
  });
  if (navigator.getInstalledRelatedApps) {
    navigator.getInstalledRelatedApps().then(apps => {
      const url = new URL('manifest.json', location.href).href;
      if (apps.some(app => app.platform === 'webapp' && app.url === url)) {
        remember(true); render();
      }
    }).catch(() => {});
  }
})();
