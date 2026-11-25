// UI theme: 'light' or 'dark'. Loaded as a plain script in <head>, before the page is drawn, so a dark interface
// never flashes light first. Until one is picked, the device's setting decides. Only the interface is themed.
(() => {
  const KEY = 'inkpad.theme';
  const get = () => { const t = localStorage.getItem(KEY); return t === 'light' || t === 'dark' ? t : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); };
  const apply = () => {
    const dark = get() === 'dark';
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#16171b' : '#f6f4ef');
    window.dispatchEvent(new Event('inkpad-theme'));
  };
  window.inkpadTheme = { get, set(t) { localStorage.setItem(KEY, t === 'dark' ? 'dark' : 'light'); apply(); } };
  apply();

  // iPad (Safari / the app): pinching must zoom the page you write on, not the whole app
  document.addEventListener('gesturestart', (e) => e.preventDefault());
})();
