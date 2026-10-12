import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderJson, renderPage } from '../src/lib/page.mjs';

test('renderPage is a self-contained page that probes the same URL', () => {
  const html = renderPage({ state: 'WAKING', pollSeconds: 3 });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /const pollMs = 3000;/);
  assert.match(html, /'x-dormeto-probe': '1'/);
  assert.match(html, /location\.reload\(\)/);
  assert.match(html, /<noscript><meta http-equiv="refresh" content="6"><\/noscript>/);
  assert.match(html, /Waking up the application/);
  assert.doesNotMatch(html, /<link|<script src|<img/, 'no external asset');
});

test('renderPage shows the failure message and escapes unknown states', () => {
  assert.match(renderPage({ state: 'FAILED', pollSeconds: 3 }), /could not be started/);
  assert.doesNotMatch(renderPage({ state: '<script>', pollSeconds: 3 }), /<h1[^>]*><script>/);
});

test('renderJson returns the lower-case status and retry delay', () => {
  assert.deepEqual(JSON.parse(renderJson({ state: 'WAKING', pollSeconds: 3 })), { status: 'waking', retryAfter: 3 });
});
