// UI theme: 'system' (follows the device), 'light' or 'dark'. Loaded as a plain script in <head>, before the page
// is drawn, so a dark interface never flashes light first. Only the interface is themed: paper keeps its own colour.
(() => {
  const KEY = 'inkpad.theme';
  const media = matchMedia('(prefers-color-scheme: dark)');
  const get = () => { const t = localStorage.getItem(KEY); return t === 'light' || t === 'dark' ? t : 'system'; };
  const apply = () => {
    const t = get(), dark = t === 'dark' || (t === 'system' && media.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#16171b' : '#f6f4ef');
    window.dispatchEvent(new Event('inkpad-theme'));
  };
  media.addEventListener('change', () => { if (get() === 'system') apply(); });
  window.inkpadTheme = { get, set(t) { if (t === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, t); apply(); } };
  apply();

  // iPad (Safari / the app): pinching must zoom the page you write on, not the whole app
  document.addEventListener('gesturestart', (e) => e.preventDefault());
})();
