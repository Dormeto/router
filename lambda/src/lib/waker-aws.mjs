// The AWS waker: the shared core with the branded waiting page on (Google Cloud's keeps the built-in one). Its own file so that
// the entry point (waker.mjs, which builds AWS clients at load) holds no wiring a test cannot reach.
import { createWaitingPages } from './waiting-pages.mjs';
import { createWaker } from './waker-core.mjs';

// readMs: how long the page waits for its settings at most (waiting-pages.mjs).
export function createAwsWaker({ readMs, ...deps }) {
  return createWaker({ ...deps, waitingPages: createWaitingPages({ store: deps.store, now: deps.now, log: deps.log, readMs }) });
}
