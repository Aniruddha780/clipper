import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_HOME_HASH, resolveRootView, shouldDefaultToLayout } from './routeResolve.js';

test('root startup without hash or with #landing defaults to #layout', () => {
  assert.equal(DEFAULT_HOME_HASH, '#layout');
  assert.equal(shouldDefaultToLayout({ pathname: '/', hash: '' }), true);
  assert.equal(shouldDefaultToLayout({ pathname: '/', hash: '#' }), true);
  assert.equal(shouldDefaultToLayout({ pathname: '/', hash: '#landing' }), true);
  assert.equal(shouldDefaultToLayout({ pathname: '/index.html', hash: '' }), true);
  assert.equal(shouldDefaultToLayout({ pathname: '/', hash: '#layout' }), false);
  assert.equal(shouldDefaultToLayout({ pathname: '/', hash: '#pricing' }), false);
  assert.equal(shouldDefaultToLayout({ pathname: '/platforms', hash: '' }), false);
});

test('cold open or refresh on #app resets to #layout, while navigation from subpages opens #app', () => {
  assert.equal(
    shouldDefaultToLayout({ pathname: '/', hash: '#app', navigationType: 'navigate', referrer: '', origin: 'http://localhost:3000' }),
    true,
  );
  assert.equal(
    shouldDefaultToLayout({ pathname: '/', hash: '#app', navigationType: 'navigate', referrer: 'https://aistudio.google.com/', origin: 'http://localhost:3000' }),
    true,
  );
  assert.equal(
    shouldDefaultToLayout({ pathname: '/', hash: '#app', navigationType: 'reload', referrer: 'http://localhost:3000/platforms', origin: 'http://localhost:3000' }),
    true,
  );
  assert.equal(
    shouldDefaultToLayout({ pathname: '/', hash: '#/app', navigationType: 'reload', referrer: '', origin: 'http://localhost:3000' }),
    true,
  );
  assert.equal(
    shouldDefaultToLayout({ pathname: '/', hash: '#app', navigationType: 'navigate', referrer: 'http://localhost:3000/platforms', origin: 'http://localhost:3000' }),
    false,
  );
  assert.equal(
    shouldDefaultToLayout({ pathname: '/', hash: '#app?tab=autopilot', navigationType: 'navigate', referrer: '', origin: 'http://localhost:3000' }),
    false,
  );
});

test('resolveRootView renders landing for #layout and root hashes, app only for #app routes', () => {
  assert.equal(resolveRootView(''), 'landing');
  assert.equal(resolveRootView('#layout'), 'landing');
  assert.equal(resolveRootView('#pricing'), 'landing');
  assert.equal(resolveRootView('#app'), 'app');
  assert.equal(resolveRootView('#app?tab=settings'), 'app');
  assert.equal(resolveRootView('#/app'), 'app');
  assert.equal(resolveRootView('#/pricing'), 'pricing');
  assert.equal(resolveRootView('#legal'), 'legal');
});
