// Tracks real in-app navigation so Back never leaves the app for about:blank
// or fails silently inside an iframe when a route (like /#app) is opened directly.
let inAppHistorySteps = 0;
let initialized = false;

export function initBackTracking() {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;
  let lastHref = window.location.href;
  const onHash = () => {
    if (window.location.href !== lastHref) {
      inAppHistorySteps += 1;
      lastHref = window.location.href;
    }
  };
  window.addEventListener('hashchange', onHash);
  window.addEventListener('popstate', () => {
    if (inAppHistorySteps > 0) inAppHistorySteps -= 1;
    lastHref = window.location.href;
  });
}

export function canUseBrowserBack() {
  if (typeof window === 'undefined') return false;
  if (inAppHistorySteps > 0 && window.history.length > 1) return true;
  try {
    if (document.referrer) {
      const ref = new URL(document.referrer);
      if (ref.origin === window.location.origin && ref.href !== window.location.href && window.history.length > 1) {
        return true;
      }
    }
  } catch {
    // Ignore malformed referrer.
  }
  return false;
}

export function navigateBack() {
  if (canUseBrowserBack()) {
    window.history.back();
    return;
  }
  if (window.location.pathname !== '/') {
    window.location.href = '/#layout';
    return;
  }
  if (window.location.hash !== '#layout') {
    window.location.hash = '#layout';
  }
}
