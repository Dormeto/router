// The router's reports to the manager (vision docs/specs/2026-11-14-google-cloud-router-push-design.md, §4): what an AWS router puts on
// the manager's event bus, a Google Cloud router sends to the manager's API (`events.url`, the route `POST /routers/events`), which
// proves the router's project and region from the service account's identity token (audience `events.audience`) and puts the entries
// on the bus. After each state change, the journal's entries after the cursor; after each check, the same, then `Router checked` in
// chunks under 64 KB (lambda/src/lib/events.mjs's, AWS's detail) with the ETag of the organization's settings the router holds.
//
// The cursor is router/report: `sentThrough`, the last journal id sent, moved on a 200 only; `recent`, the ids sent within 5 minutes
// before it, since an entry can commit after a later one (its time is taken before its commit, and the waker and the controller are
// two services): the journal is read again from 5 minutes before the cursor, and what `recent` holds is not sent twice. A failed send
// is said (`lastError`, `ReportFailed`; a 403 `router_unknown`, `lastRefusal`, and `ReportRefused` once a check) and never holds a
// transition more than 2 s: the next send starts from the cursor. While a refusal lasts, only the checks send. Without `events` (a
// manager below 0.25.0, or none), nothing is sent.
import { STATUS_CODES } from 'node:http';
import { checkedChunks } from '../../lambda/src/lib/events.mjs';

// A transition waits this long at most for its report: the waker's are on the path of a wake.
export const REPORT_BUDGET_MS = 2000;
// One request to the manager's API, its tries included; a try that ran out of that time is not made again.
export const SEND_MS = 2000;
export const ATTEMPTS = 2;
// The route's limits: entries and bytes a request.
const ENTRIES_MAX = 100;
const BODY_MAX = 1_000_000;
// How long after its time an entry may commit (above a commit's time at worst): the journal is read again this far behind the cursor.
const OVERLAP_MS = 5 * 60_000;
const PAGE = 100;
const STATE_CHANGED = 'Workload state changed';
const CHECKED = 'Router checked';
const ROUTER_UNKNOWN = 'router_unknown';

// The journal's ids: `<stateAt, 13 digits>-<workloadId>-<state>`. The id before every entry of a millisecond: a workload id starts
// with a letter, after `0`.
const msOf = (id) => Number(id.slice(0, 13));
const idBefore = (ms) => `${String(Math.max(0, ms)).padStart(13, '0')}-0-A`;
const sizeOf = (entry) => Buffer.byteLength(JSON.stringify(entry)) + 1;
const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};

// Requests of ENTRIES_MAX entries and BODY_MAX bytes at most, in order.
function requestsOf(entries) {
  const requests = [];
  let bytes = 0;
  for (const entry of entries) {
    const size = sizeOf(entry);
    const last = requests.at(-1);
    if (last && last.length < ENTRIES_MAX && bytes + size <= BODY_MAX) {
      last.push(entry);
      bytes += size;
    } else {
      requests.push([entry]);
      bytes = 20 + size;
    }
  }
  return requests;
}

// The record after a 200 for journal `ids`: the cursor at the last one sent (never back), the ids sent within the window before it,
// the error and refusal gone.
function advanced(was, ids, at) {
  const sentThrough = [was?.sentThrough, ...ids].filter(Boolean).sort().at(-1) ?? null;
  const floor = sentThrough ? idBefore(msOf(sentThrough) - OVERLAP_MS) : '';
  const recent = [...new Set([...(was?.recent ?? []), ...ids])].filter((id) => id > floor).sort();
  return { sentThrough, lastSentAt: at, recent };
}

// `store`: firestore.mjs's (the manager's settings, the journal, router/report); `tokens`: google.mjs's createIdentityTokens; `rows()`:
// the `list` action's answer ({ router, workloads }), for `Router checked`; `region`: the router's.
export function createReporter({ store, tokens, fetch = globalThis.fetch, region, rows = async () => null, now = Date.now, log, sendMs = SEND_MS }) {
  // Where to report, and the ETag the router holds; null without `events`.
  async function managerOf() {
    const manager = await store.getManagerSettings();
    return manager?.events?.url && manager.events.audience ? { events: manager.events, etag: manager.etag ?? null } : null;
  }

  // One request: null on a 200, else the failure `{ status, error, refusal? }`. A 429, a 5xx or a lost connection is tried once more
  // within the request's time; a refusal or a request that ran out of time is not.
  async function post(events, entries) {
    const body = JSON.stringify({ events: entries });
    const started = performance.now();
    let failure = null;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      const left = Math.ceil(sendMs - (performance.now() - started));
      if (left <= 0) break;
      try {
        const token = await tokens.token(events.audience);
        const res = await fetch(events.url, {
          method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(left),
        });
        const text = await res.text();
        if (res.ok) return null;
        let said = null;
        try {
          said = JSON.parse(text);
        } catch { /* not JSON */ }
        const reason = said?.error ?? said?.message ?? ((said === null && text.trim().slice(0, 200)) || STATUS_CODES[res.status] || 'refused');
        const refusal = res.status === 403 && said?.error === ROUTER_UNKNOWN ? ROUTER_UNKNOWN : null;
        failure = { status: res.status, error: `${res.status} ${reason}`, ...(refusal ? { refusal } : {}) };
        if (res.status !== 429 && res.status < 500) break;
      } catch (err) {
        failure = { status: 0, error: err.message };
        if (err.name === 'TimeoutError' || err.name === 'AbortError') break;
      }
    }
    return failure;
  }

  // The journal's entries not sent yet, oldest first, for one request: from 5 minutes before the cursor, what `recent` holds aside.
  async function unsent(state) {
    const recent = new Set(state?.recent ?? []);
    let after = state?.sentThrough ? idBefore(msOf(state.sentThrough) - OVERLAP_MS) : null;
    const out = [];
    let bytes = 20;
    for (;;) {
      const { events, next } = await store.listEvents({ after, limit: PAGE });
      for (const { id, ...detail } of events) {
        if (recent.has(id)) continue;
        const entry = { detailType: STATE_CHANGED, detail };
        const size = sizeOf(entry);
        if (out.length >= ENTRIES_MAX || (out.length && bytes + size > BODY_MAX)) return out;
        out.push({ id, entry });
        bytes += size;
      }
      if (!next) return out;
      after = next;
    }
  }

  const failed = (failure) => store.updateReport((was) => ({
    ...(was ?? {}), sentThrough: was?.sentThrough ?? null, lastError: failure.error, ...(failure.refusal ? { lastRefusal: failure.refusal } : {}),
  }));

  // The journal after the cursor, request after request: the failure that stopped it, or null.
  async function sendJournal(manager, state) {
    let current = state;
    for (;;) {
      const batch = await unsent(current);
      if (!batch.length) return null;
      const failure = await post(manager.events, batch.map((b) => b.entry));
      if (failure) {
        await failed(failure);
        return failure;
      }
      current = await store.updateReport((was) => advanced(was, batch.map((b) => b.id), now()));
    }
  }

  function said(failure, what, manager) {
    if (failure.refusal && what === 'check') log.warn('ReportRefused', { host: hostOf(manager.events.url), refusal: failure.refusal });
    else log.warn('ReportFailed', { what, host: hostOf(manager.events.url), status: failure.status, error: failure.error });
  }

  // One report at a time in this instance; transitions that come while one waits are one report.
  let tail = Promise.resolve();
  const serial = (work) => {
    const done = tail.then(work);
    tail = done.catch(() => {});
    return done;
  };
  let queued = null;

  // After a state change: the journal, unless the manager refused this router (the next check asks again).
  async function afterTransition() {
    queued = null;
    let manager = null;
    try {
      manager = await managerOf();
      if (!manager) return;
      const state = await store.getReport();
      if (state?.lastRefusal) return;
      const failure = await sendJournal(manager, state);
      if (failure) said(failure, 'state', manager);
    } catch (err) {
      log.warn('ReportFailed', { what: 'state', ...(manager ? { host: hostOf(manager.events.url) } : {}), error: err.message });
    }
  }

  // After a check: the journal, then `Router checked` from the check's summary (router/check: `checkedAt` in ms) and the list's rows.
  async function afterCheck(summary) {
    let manager = null;
    try {
      manager = await managerOf();
      if (!manager) return;
      const failure = await sendJournal(manager, await store.getReport());
      if (failure) {
        said(failure, 'check', manager);
        return;
      }
      if (!summary) return;
      const listed = await rows();
      const details = checkedChunks({
        router: { ...listed.router, region },
        checkedAt: new Date(summary.checkedAt).toISOString(), durationMs: summary.durationMs, health: summary.health, pauses: summary.pauses, counts: summary.counts,
        managerSettings: { etag: manager.etag },
        workloads: listed.workloads ?? [],
      });
      for (const entries of requestsOf(details.map((detail) => ({ detailType: CHECKED, detail })))) {
        const refused = await post(manager.events, entries);
        if (refused) {
          await failed(refused);
          said(refused, 'check', manager);
          return;
        }
      }
      await store.updateReport((was) => {
        const { lastError: _e, lastRefusal: _r, ...kept } = was ?? {};
        return { ...kept, sentThrough: was?.sentThrough ?? null, lastSentAt: now() };
      });
    } catch (err) {
      log.warn('ReportFailed', { what: 'check', ...(manager ? { host: hostOf(manager.events.url) } : {}), error: err.message });
    }
  }

  return {
    transitioned: () => (queued ??= serial(afterTransition)),
    checked: (summary) => serial(() => afterCheck(summary)),
  };
}

// The store, with every committed state change reported (the controller's and the waker's), each holding its transition
// REPORT_BUDGET_MS at most: a slower report goes on, unwaited.
export function withReports(store, reporter, { budgetMs = REPORT_BUDGET_MS, log = null } = {}) {
  return Object.assign(Object.create(store), store, {
    async transition(workloadId, change) {
      const next = await store.transition(workloadId, change);
      if (next && change?.set?.state !== undefined) {
        let timer;
        const slow = new Promise((resolve) => { timer = setTimeout(() => resolve('slow'), budgetMs); });
        try {
          if ((await Promise.race([reporter.transitioned(), slow])) === 'slow') log?.warn('ReportSlow', { workloadId, budgetMs });
        } finally {
          clearTimeout(timer);
        }
      }
      return next;
    },
  });
}

// What the router's reports stand at, for `GET /v1/health` and the `router` action (the CLI's `dormeto gcp routers show`): where it
// reports (the URL's host), its last report, the cursor, the last error and refusal while they last; null without `events`. Never
// throws, nor holds the health: an unreadable store, or one that does not answer within `timeoutMs`, is `{ error }`.
export const READ_REPORT_MS = 2000;
export async function readReport(store, { timeoutMs = READ_REPORT_MS } = {}) {
  let timer;
  try {
    const late = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(`not read within ${timeoutMs} ms`)), timeoutMs); });
    const [manager, state] = await Promise.race([Promise.all([store.getManagerSettings?.(), store.getReport?.()]), late]);
    if (!manager?.events?.url) return null;
    return {
      host: hostOf(manager.events.url),
      lastSentAt: typeof state?.lastSentAt === 'number' ? new Date(state.lastSentAt).toISOString() : null,
      sentThrough: state?.sentThrough ?? null,
      ...(state?.lastError ? { lastError: state.lastError } : {}),
      ...(state?.lastRefusal ? { lastRefusal: state.lastRefusal } : {}),
    };
  } catch (err) {
    return { error: err.message };
  } finally {
    clearTimeout(timer);
  }
}
