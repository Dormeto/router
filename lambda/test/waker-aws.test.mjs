import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAwsWaker } from '../src/lib/waker-aws.mjs';
import { STATES } from '../src/lib/state.mjs';
import { albEvent, fakeClock, fakeStore, silentLog, testConfig } from './fakes.mjs';
import { PAGE_CSP } from '../src/lib/page.mjs';

// The AWS waker\'s entry (lambda/src/waker.mjs) builds its handler with createAwsWaker: the branded page is on in it.
test('the AWS waker answers the branded page: the stored template, the visitor\'s language, the policy', async () => {
  const clock = fakeClock();
  const store = fakeStore({ config: testConfig({ waitSeconds: 0 }), run: { state: STATES.ASLEEP }, clock });
  store.state.pages.organization = { page: { mode: 'template', title: 'Acme portal' }, by: 'settings.json', at: 1 };
  const handler = createAwsWaker({ store, invokeController: async () => {}, prefix: 'dmt-dev-', now: clock.now, sleep: clock.sleep, log: silentLog });
  const res = await handler(albEvent({ headers: { 'accept-language': 'fr' } }));
  assert.match(res.body, /<h1>Acme portal<\/h1>/);
  assert.match(res.body, /<html lang="fr">/);
  assert.equal(res.multiValueHeaders['content-security-policy'][0], PAGE_CSP);
});

test('the entry point uses it', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/waker.mjs', import.meta.url), 'utf8');
  assert.match(source, /createAwsWaker\(\{/);
  assert.doesNotMatch(source, /createWaker\(/);
});

test('a store that hangs on the page still lets the wake happen and the page answer', async () => {
  const clock = fakeClock();
  const store = fakeStore({ config: testConfig({ waitSeconds: 0 }), run: { state: STATES.ASLEEP }, clock });
  store.getWaitingPage = () => new Promise(() => {});
  store.getFavicon = () => new Promise(() => {});
  const woken = [];
  const handler = createAwsWaker({ store, invokeController: async (p) => { woken.push(p.action); }, prefix: 'dmt-dev-', now: clock.now, sleep: clock.sleep, log: silentLog, readMs: 40 });
  const res = await handler(albEvent());
  assert.equal(res.statusCode, 503);
  assert.match(res.body, /Waking up the application/);
  assert.deepEqual(woken, ['wake']);
});
