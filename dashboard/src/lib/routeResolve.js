export const DEFAULT_HOME_HASH = '#layout';

export function resolveRootView(hash = '') {
  const h = String(hash || '');
  if (h.startsWith('#/auth/')) return 'auth';
  if (h.startsWith('#/oauth/authorize')) return 'oauth';
  if (h.startsWith('#/account')) return 'account';
  if (h.startsWith('#/deleted')) return 'deleted';
  if (h.startsWith('#/pricing')) return 'pricing';
  if (h.startsWith('#/login')) return 'login';
  if (h === '#legal') return 'legal';
  if (h === '#app' || h.startsWith('#app?') || h === '#/app') return 'app';
  return 'landing';
}

export function shouldDefaultToLayout({
  pathname = '/',
  hash = '',
  navigationType = 'navigate',
  referrer = '',
  origin = '',
} = {}) {
  const p = String(pathname || '/');
  const h = String(hash || '');
  if (p !== '/' && p !== '/index.html') return false;
  if (h === '' || h === '#' || h === '#landing') return true;
  if (h === '#app' || h === '#/app') {
    if (navigationType === 'reload') return true;
    if (referrer && origin) {
      try {
        const ref = new URL(referrer);
        if (ref.origin === origin && ref.pathname !== '/' && ref.pathname !== '/index.html') {
          return false;
        }
      } catch {
        // Malformed referrer: default back to #layout.
      }
    }
    return true;
  }
  return false;
}
