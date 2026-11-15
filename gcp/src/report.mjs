// The router's reports to the manager (vision docs/specs/2026-11-14-google-cloud-router-push-design.md, §4, and
// docs/specs/2026-11-15-router-credentials-design.md, §5): what an AWS router puts on the manager's event bus, a Google Cloud router puts
// there too, with AWS credentials the manager's API gives it. It asks `events.url` (the route `POST /routers/credentials`) with the
// service account's identity token (audience `events.audience`); the manager proves the router's project and region from the token
// and answers a session of its own role, an hour long, allowed to put the source `dormeto.router.gcp/<project>/<region>` only, with
// the bus's name and region. The router keeps it in memory (never in the store, never in a log) and asks again 5 minutes before it
// expires, plus up to 5 minutes by instance; then it calls PutEvents itself, signed by sigv4.mjs. After each state change, the
// journal's entries after the cursor; after each check, the same, then `Router checked` in chunks under 64 KB
// (lambda/src/lib/events.mjs's, AWS's detail) with the ETag of the organization's settings the router holds; in calls of 10 entries
// and 256 KB at most.
//
// The cursor is router/report: `sentThrough`, the last journal id put, moved through the last entry before the first that PutEvents
// failed; `recent`, the ids put within 5 minutes before it, since an entry can commit after a later one (its time is taken before
// its commit, and the waker and the controller are two services): the journal is read again from 5 minutes before the cursor, and
// what `recent` holds is not put twice. A failed report is said (`lastError`, `ReportFailed`; the credentials route's 403
// `router_unknown`, `lastRefusal`, and `ReportRefused` once a check) and never holds a transition nor a check more than 2 s: the next
// report starts from the cursor. While a refusal lasts, only the checks ask. Without `events` (a manager below 0.25.0, or none),
// nothing is sent.
import { STATUS_CODES } from 'node:http';
import { ENTRY_MAX, callsOf, checkedChunks } from '../../lambda/src/lib/events.mjs';
import { signedHeaders } from './sigv4.mjs';

// A transition waits this long at most for its report: the waker's are on the path of a wake.
export const REPORT_BUDGET_MS = 2000;
// One report, its credentials, its calls and their tries included; a try that ran out of that time is not made again.
export const SEND_MS = 2000;
export const ATTEMPTS = 2;
// The credentials are asked again this long before they expire, plus the instance's jitter, up to JITTER_MS: the instances of a
// fleet do not all ask at once.
export const RENEW_MS = 5 * 60_000;
export const JITTER_MS = 5 * 60_000;
// How long after its time an entry may commit (above a commit's time at worst): the journal is read again this far behind the cursor.
const OVERLAP_MS = 5 * 60_000;
const PAGE = 100;
const STATE_CHANGED = 'Workload state changed';
const CHECKED = 'Router checked';
const ROUTER_UNKNOWN = 'router_unknown';
const SOURCE_PREFIX = 'dormeto.router.gcp';
const REGION_SHAPE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// PutEvents' errors that say the credentials are refused (expired, or unknown): asked again once.
const EXPIRED = new Set(['ExpiredTokenException', 'UnrecognizedClientException']);
// PutEvents' per-entry errors that may pass at a later try: the cursor stops before them. Any other refuses the entry for good.
const TRANSIENT = new Set(['ThrottlingException', 'InternalFailure', 'InternalException']);
const VALIDATION = 'ValidationException';
const TOO_LARGE = 'EntryTooLarge';
const TEXT_MAX = 200;

// The journal's ids: `<stateAt, 13 digits>-<workloadId>-<state>`. The id before every entry of a millisecond: a workload id starts
// with a letter, after `0`.
const msOf = (id) => Number(id.slice(0, 13));
const idBefore = (ms) => `${String(Math.max(0, ms)).padStart(13, '0')}-0-A`;
const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};
const isText = (value) => typeof value === 'string' && value.length > 0;
// A text an answer gave, as the store and the logs keep it: its first line, the session's secrets and any quoted security token
// masked, 200 characters at most (AWS's InvalidSignatureException quotes the canonical request, the token in it).
const clip = (text, secrets = []) => {
  let line = String(text ?? '').split(/\r?\n/, 1)[0];
  for (const secret of secrets) if (secret) line = line.split(secret).join('***');
  return line.replace(/x-amz-security-token[:=]\S*/gi, 'x-amz-security-token:***').slice(0, TEXT_MAX);
};
const parsed = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// The record after a put of journal `ids`: the cursor at the last one put (never back), the ids put within the window before it,
// the error and refusal gone.
function advanced(was, ids, at) {
  const sentThrough = [was?.sentThrough, ...ids].filter(Boolean).sort().at(-1) ?? null;
  const floor = sentThrough ? idBefore(msOf(sentThrough) - OVERLAP_MS) : '';
  const recent = [...new Set([...(was?.recent ?? []), ...ids])].filter((id) => id > floor).sort();
  return { sentThrough, lastSentAt: at, recent };
}

// The credentials route's answer, checked: the session, the bus and this router's own source; else why not, in words that name no
// secret.
function sessionOf(body, source) {
  const c = body?.credentials;
  if (!isText(c?.accessKeyId) || !isText(c.secretAccessKey) || !isText(c.sessionToken) || !Number.isFinite(Date.parse(c.expiration))) {
    return { error: 'the manager\'s answer holds no credentials' };
  }
  if (!isText(body.bus?.name) || typeof body.bus.region !== 'string' || !REGION_SHAPE.test(body.bus.region)) return { error: 'the manager\'s answer names no bus in a region' };
  if (body.source !== source) return { error: `the manager's answer names another source than ${source}` };
  return {
    session: {
      credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, sessionToken: c.sessionToken },
      expiresAt: Date.parse(c.expiration), bus: { name: body.bus.name, region: body.bus.region }, source,
    },
  };
}

// `store`: firestore.mjs's (the manager's settings, the journal, router/report); `tokens`: google.mjs's createIdentityTokens; `rows()`:
// the `list` action's answer ({ router, workloads }), for `Router checked`; `project`, `region`: the router's. `random`: the
// instance's jitter, drawn once.
export function createReporter({
  store, tokens, fetch = globalThis.fetch, project, region, rows = async () => null, now = Date.now, log, sendMs = SEND_MS, random = Math.random,
}) {
  const source = `${SOURCE_PREFIX}/${project}/${region}`;
  const jitterMs = random() * JITTER_MS;
  // The manager's session, in memory only: { session, url, renewAt }.
  let held = null;

  // Where to report, and the ETag the router holds; null without `events`.
  async function managerOf() {
    const manager = await store.getManagerSettings();
    return manager?.events?.url && manager.events.audience ? { events: manager.events, etag: manager.etag ?? null } : null;
  }

  // One request, tried once more on a 429, a 5xx or a lost connection while the report has time: `{ status, text }`, or the
  // failure `{ status: 0, error }`. A request that ran out of the report's time is not tried again.
  async function exchange(request, deadline) {
    let last = null;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      const left = Math.ceil(deadline - performance.now());
      if (left <= 0) break;
      try {
        const res = await request(AbortSignal.timeout(left));
        last = { status: res.status, text: await res.text() };
        if (res.ok || (res.status !== 429 && res.status < 500)) return last;
      } catch (err) {
        last = { status: 0, error: err.message };
        if (err.name === 'TimeoutError' || err.name === 'AbortError') break;
      }
    }
    return last ?? { status: 0, error: `not sent within ${sendMs} ms` };
  }

  // The session to put with: the one held while it lasts, else the manager's answer. `{ session }` or `{ failure }`.
  async function session(events, deadline) {
    if (held && held.url === events.url && now() < held.renewAt) return { session: held.session };
    held = null;
    let token;
    try {
      token = await tokens.token(events.audience);
    } catch (err) {
      return { failure: { status: 0, error: clip(err.message) } };
    }
    const answer = await exchange((signal) => fetch(events.url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, signal }), deadline);
    if (answer.error) return { failure: { status: 0, error: clip(answer.error) } };
    const said = parsed(answer.text);
    if (answer.status !== 200) {
      const reason = clip(said?.error ?? said?.message ?? ((said === null && answer.text.trim()) || STATUS_CODES[answer.status] || 'refused'));
      const refusal = answer.status === 403 && said?.error === ROUTER_UNKNOWN ? ROUTER_UNKNOWN : null;
      return { failure: { status: answer.status, error: `${answer.status} ${reason}`, ...(refusal ? { refusal } : {}) } };
    }
    const checked = sessionOf(said, source);
    if (checked.error) return { failure: { status: 200, error: `200 ${checked.error}` } };
    held = { session: checked.session, url: events.url, renewAt: checked.session.expiresAt - RENEW_MS - jitterMs };
    return { session: checked.session };
  }

  // One PutEvents call of `entries` ({ Source, DetailType, Detail }) with `s`: `{ results }`, each entry's null (put) or
  // `{ code, message }`; or `{ failure, expired?, validation? }` for the whole call. What AWS says is clipped, the session masked.
  async function putOnce(s, entries, deadline) {
    const url = `https://events.${s.bus.region}.amazonaws.com/`;
    const secrets = [s.credentials.sessionToken, s.credentials.secretAccessKey, s.credentials.accessKeyId];
    const body = JSON.stringify({ Entries: entries.map((e) => ({ EventBusName: s.bus.name, ...e })) });
    const headers = { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSEvents.PutEvents' };
    const answer = await exchange((signal) => fetch(url, {
      method: 'POST', body, signal,
      headers: signedHeaders({ method: 'POST', url, headers, body, credentials: s.credentials, region: s.bus.region, service: 'events', now: now() }),
    }), deadline);
    if (answer.error) return { failure: { status: 0, error: clip(answer.error, secrets) } };
    const said = parsed(answer.text);
    if (answer.status === 200) {
      if (!said?.FailedEntryCount) return { results: entries.map(() => null) };
      const results = entries.map((_, i) => {
        const e = said.Entries?.[i];
        return e?.ErrorCode ? { code: clip(e.ErrorCode, secrets), message: clip(e.ErrorMessage, secrets) } : null;
      });
      if (!results.some(Boolean)) return { failure: { status: 200, error: '200 failed' } };
      return { results };
    }
    const type = clip(String(said?.__type ?? '').split('#').at(-1), secrets);
    const message = clip(said?.message ?? said?.Message ?? '', secrets);
    const reason = type ? `${type}${message ? `: ${message}` : ''}` : (STATUS_CODES[answer.status] ?? 'refused');
    return {
      failure: { status: answer.status, error: `${answer.status} ${reason}` },
      expired: answer.status === 403 || EXPIRED.has(type), validation: answer.status === 400 && type === VALIDATION,
    };
  }

  // `entries` put in one call, the session asked first when none is held; a put refused for its credentials drops them and asks
  // again once. putOnce's answer.
  async function put(manager, entries, deadline) {
    for (let renewed = false; ; renewed = true) {
      const s = await session(manager.events, deadline);
      if (s.failure) return { failure: s.failure };
      const out = await putOnce(s.session, entries, deadline);
      if (!out.expired || renewed) return out;
      held = null;
    }
  }

  // The journal's entries not put yet, oldest first, a page at most: from 5 minutes before the cursor, what `recent` holds aside.
  async function unsent(state) {
    const recent = new Set(state?.recent ?? []);
    let after = state?.sentThrough ? idBefore(msOf(state.sentThrough) - OVERLAP_MS) : null;
    const out = [];
    for (;;) {
      const { events, next } = await store.listEvents({ after, limit: PAGE });
      for (const { id, ...detail } of events) {
        if (recent.has(id)) continue;
        out.push({ id, entry: { Source: source, DetailType: STATE_CHANGED, Detail: JSON.stringify(detail) } });
        if (out.length >= PAGE) return out;
      }
      if (!next) return out;
      after = next;
    }
  }

  const failed = (failure) => store.updateReport((was) => ({
    ...(was ?? {}), sentThrough: was?.sentThrough ?? null, lastError: failure.error, ...(failure.refusal ? { lastRefusal: failure.refusal } : {}),
  }));

  const tooLarge = (item) => Buffer.byteLength(item.entry.Detail) > ENTRY_MAX;
  const dropped = (item, error) => log.warn('ReportDropped', { id: item.id, detailType: item.entry.DetailType, error });

  // `items` ({ id, entry }: a journal id, or `check` for a Router checked chunk) put in order, call after call, within the report's
  // time. An entry that can never be accepted is dropped (ReportDropped) and counts as done: a detail over 64 KB, before any call; a
  // per-entry error other than throttling or internal; a 400 ValidationException to a call of one entry (a call of several is put
  // again one entry a call). `done(ids)` after each step, with the ids put or dropped, in order. The failure that stopped it (a
  // transient one: the next report starts from the cursor), or null.
  async function putItems(manager, items, deadline, done) {
    let singleUntil = 0;
    for (let i = 0; i < items.length;) {
      if (tooLarge(items[i])) {
        dropped(items[i], TOO_LARGE);
        await done([items[i].id]);
        i += 1;
        continue;
      }
      let end = i + 1;
      while (end < items.length && end > singleUntil && !tooLarge(items[end])) end += 1;
      const run = items.slice(i, end);
      const call = run.slice(0, callsOf(run.map((item) => item.entry))[0].length);
      const out = await put(manager, call.map((item) => item.entry), deadline);
      if (out.failure) {
        if (!out.validation) return out.failure;
        if (call.length > 1) {
          singleUntil = i + call.length;
          continue;
        }
        dropped(call[0], VALIDATION);
        await done([call[0].id]);
        i += 1;
        continue;
      }
      const ids = [];
      let failure = null;
      for (const [k, result] of out.results.entries()) {
        if (result && TRANSIENT.has(result.code)) {
          failure = { status: 200, error: `200 ${result.code}${result.message ? `: ${result.message}` : ''}` };
          break;
        }
        if (result) dropped(call[k], result.code);
        ids.push(call[k].id);
      }
      if (ids.length) await done(ids);
      if (failure) return failure;
      i += call.length;
    }
    return null;
  }

  // The journal after the cursor, call after call, the cursor moved by each through what it put or dropped: the failure that stopped
  // it, or null.
  async function sendJournal(manager, state, deadline) {
    let current = state;
    for (;;) {
      const batch = await unsent(current);
      if (!batch.length) return null;
      const failure = await putItems(manager, batch, deadline, async (ids) => {
        current = await store.updateReport((was) => advanced(was, ids, now()));
      });
      if (failure) {
        await failed(failure);
        return failure;
      }
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
    const deadline = performance.now() + sendMs;
    let manager = null;
    try {
      manager = await managerOf();
      if (!manager) return;
      const state = await store.getReport();
      if (state?.lastRefusal) return;
      const failure = await sendJournal(manager, state, deadline);
      if (failure) said(failure, 'state', manager);
    } catch (err) {
      log.warn('ReportFailed', { what: 'state', ...(manager ? { host: hostOf(manager.events.url) } : {}), error: err.message });
    }
  }

  // After a check: the journal, then `Router checked` from the check's summary (router/check: `checkedAt` in ms) and the list's rows.
  async function afterCheck(summary) {
    const deadline = performance.now() + sendMs;
    let manager = null;
    try {
      manager = await managerOf();
      if (!manager) return;
      const failure = await sendJournal(manager, await store.getReport(), deadline);
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
      const chunks = details.map((detail) => ({ id: 'check', entry: { Source: source, DetailType: CHECKED, Detail: JSON.stringify(detail) } }));
      const refused = await putItems(manager, chunks, deadline, async () => {});
      if (refused) {
        await failed(refused);
        said(refused, 'check', manager);
        return;
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
