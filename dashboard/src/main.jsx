import { StrictMode, useState, useEffect, lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import Landing from './Landing.jsx'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { capture as captureAttribution } from './lib/attribution'
import PricingPage from './components/PricingPage'
import AccountPage from './components/AccountPage'
import LoginModal from './components/LoginModal'
import { readPendingPlan } from './lib/pendingPlan'
import { track } from './lib/analytics'
import { applyConsent } from './lib/consent'
import CookieBanner from './components/CookieBanner'

import { initBackTracking, navigateBack } from './lib/backNav'
import { DEFAULT_HOME_HASH, resolveRootView, shouldDefaultToLayout } from './lib/routeResolve'

const App = lazy(() => import('./App.jsx'))
const Legal = lazy(() => import('./Legal.jsx'))
const OAuthConsent = lazy(() => import('./components/OAuthConsent'))

initBackTracking();

const goBack = () => {
  navigateBack();
};

function PageShell({ title, children }) {
  return (
    <div className="min-h-screen bg-paper text-ink2">
      <header className="h-14 sm:h-16 border-b border-rule bg-paper flex items-center justify-between gap-3 px-4 sm:px-6 sticky top-0 z-20">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={goBack}
            aria-label="Go back"
            className="btn-quiet px-2.5 py-1.5 text-xs lowercase shrink-0"
          >
            ← Back
          </button>
          <a href="#layout" className="font-display lowercase text-xl text-ink truncate">Clipper</a>
        </div>
      </header>
      <main className="p-4 sm:p-6 md:p-8 pb-[max(2rem,env(safe-area-inset-bottom))]">
        {title && <h1 className="font-display lowercase text-2xl sm:text-3xl text-ink text-center mb-6 sm:mb-10">{title}</h1>}
        {children}
      </main>
    </div>
  );
}

function PricingView() {
  const { isSignedIn, loading } = useAuth();
  // A plan picked on the landing while signed out lands here: ask for the
  // sign-in straight away instead of a second click on the same plan.
  const [showLogin, setShowLogin] = useState(false);
  // Back from Stripe without paying (cancel_url of a checkout opened here):
  // straight to the plans, not the top of the page, and the query dropped so
  // a reload does not count it twice.
  useEffect(() => {
    if (!window.location.hash.includes('checkout=cancel')) { window.scrollTo(0, 0); return; }
    track('CheckoutCanceled', { props: { back_to: 'pricing' } });
    try { window.history.replaceState(null, '', '#/pricing'); } catch (_) { /* ignore */ }
    requestAnimationFrame(() => document.getElementById('pricing-plans')?.scrollIntoView());
  }, []);
  useEffect(() => {
    if (!loading && !isSignedIn && readPendingPlan()) setShowLogin(true);
  }, [loading, isSignedIn]);
  return (
    <PageShell>
      <PricingPage onRequireLogin={() => setShowLogin(true)} />
      {showLogin && <LoginModal onClose={() => setShowLogin(false)} />}
    </PageShell>
  );
}

function AccountView() {
  const { isSignedIn, loading } = useAuth();
  useEffect(() => {
    if (!loading && !isSignedIn) window.location.hash = '#/pricing';
  }, [loading, isSignedIn]);
  return <PageShell><AccountPage /></PageShell>;
}

// Direct sign-in page (#/login), the URL handed to app-directory reviewers:
// the sign-in form opens straight away and a signed-in visitor goes to the app.
function LoginView() {
  const { isSignedIn, loading } = useAuth();
  const toApp = () => { window.location.hash = '#app'; };
  useEffect(() => {
    if (!loading && isSignedIn) toApp();
  }, [loading, isSignedIn]);
  return (
    <PageShell>
      {!loading && !isSignedIn && <LoginModal onClose={toApp} />}
    </PageShell>
  );
}

// Landing spot after an account is erased. Its own view because the session is
// gone: sending the user to #/account would bounce them to pricing with no
// explanation.
function DeletedView() {
  return (
    <div className="min-h-screen bg-paper text-ink2 flex items-center justify-center p-6 relative">
      <button
        type="button"
        onClick={goBack}
        aria-label="Go back"
        className="btn-quiet px-2.5 py-1.5 text-xs lowercase fixed top-4 left-4 z-20"
      >
        ← Back
      </button>
      <div className="max-w-md text-center space-y-4">
        <h1 className="font-display lowercase text-2xl sm:text-3xl text-ink">Your account is deleted</h1>
        <p className="text-sm">
          Your projects, clips and transcripts are gone, any subscription is
          cancelled, and your API keys no longer work. We've emailed you a
          confirmation with the details.
        </p>
        <p className="text-sm text-muted">
          You're welcome back any time — signing up again with the same address
          starts a brand-new, empty account.
        </p>
        <a href="#layout" className="btn-ghost px-4 py-2 inline-flex">Back to Clipper</a>
      </div>
    </div>
  );
}

function Root() {
  const resolveView = () => resolveRootView(window.location.hash || '');

  const [view, setView] = useState(resolveView);

  useEffect(() => {
    const handleHashChange = () => setView(resolveView());
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const handleLaunchApp = () => {
    window.location.hash = '#app';
    setView('app');
  };

  if (view === 'legal') return <Legal />;
  if (view === 'pricing') return <PricingView />;
  if (view === 'login') return <LoginView />;
  if (view === 'account') return <AccountView />;
  if (view === 'oauth') return <OAuthConsent />;
  if (view === 'deleted') return <DeletedView />;
  if (view === 'auth') {
    return <div className="min-h-screen flex items-center justify-center bg-background text-zinc-400">Signing you in…</div>;
  }
  if (view === 'app') return <App />;
  return <Landing onLaunchApp={handleLaunchApp} />;
}

// Before React mounts: AuthContext rewrites the URL on auth redirects, which
// would destroy the referrer and any UTM params we still need to read.
captureAttribution();

// Always start at /#layout on initial open or refresh rather than landing directly on #app.
const navEntry = typeof performance !== 'undefined' && performance.getEntriesByType
  ? performance.getEntriesByType('navigation')?.[0]
  : null;
if (shouldDefaultToLayout({
  pathname: window.location.pathname,
  hash: window.location.hash,
  navigationType: navEntry?.type || 'navigate',
  referrer: document.referrer,
  origin: window.location.origin,
})) {
  try {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${DEFAULT_HOME_HASH}`);
  } catch (_) {
    window.location.hash = DEFAULT_HOME_HASH;
  }
}

// Start whatever the visitor previously agreed to. Nothing at all on a first
// visit: index.html only publishes the analytics initialiser, it never runs it.
applyConsent();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AuthProvider>
      <Suspense fallback={<div className="min-h-screen bg-paper flex items-center justify-center text-muted text-sm lowercase">loading…</div>}>
        <Root />
      </Suspense>
      <CookieBanner />
    </AuthProvider>
  </StrictMode>,
)
