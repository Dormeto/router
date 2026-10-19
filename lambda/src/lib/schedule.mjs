// Time-based behavior (R12 design, section 3): a workload's weekly awake and nap windows in its time zone, exception
// dates and a maximum nap. Pure: instants are epoch milliseconds passed in; local wall times come from Intl only.
export const WINDOWS_MAX = 20;
export const EXCEPTIONS_MAX = 100;
export const NAP_DAYS_MAX = 60;
// An idle nap, or a nap window's occurrence, is skipped when an awake window starts within this delay.
export const CLOSE_START_MS = 30 * 60_000;

const MINUTE = 60_000;
const DAY = 86_400_000;
const WEEK = 7 * 1440;
const HORIZON_DAYS = 8;
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WAKES = ['never', 'header'];
// The fields of a schedule and of a window; `by` and `at` (who set it, when) are accepted and ignored, so a schedule
// read back can be sent again as it is.
const FIELDS = ['timeZone', 'windows', 'exceptions', 'maxNapDays', 'by', 'at'];
const WINDOW_FIELDS = ['kind', 'days', 'start', 'end', 'wake'];
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const absent = (value) => value === undefined || value === null;
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const defined = (object) => Object.fromEntries(Object.entries(object).filter(([, value]) => !absent(value)));
const iso = (ms) => new Date(ms).toISOString();
const pad = (n) => String(n).padStart(2, '0');

// Minutes after local midnight of an HH:MM on a 5-minute step, or null.
function minutesOf(text) {
  const match = typeof text === 'string' && HHMM.exec(text);
  const minutes = match ? Number(match[1]) * 60 + Number(match[2]) : NaN;
  return minutes % 5 === 0 ? minutes : null;
}

// A calendar date: Date.parse takes 2027-02-30 for March 2, so it must come back unchanged.
function isDate(text) {
  const ms = typeof text === 'string' && DATE.test(text) ? Date.parse(text) : NaN;
  return Number.isFinite(ms) && iso(ms).startsWith(text);
}

// The name Intl resolves a time zone to (Europe/Paris for europe/paris), or null when it refuses it. Intl also takes UTC
// offsets (+01:00, −05:00), resolved with a leading sign: not zone names, and Go's time.LoadLocation (the CLI) refuses
// them.
function canonicalZone(timeZone) {
  if (typeof timeZone !== 'string') return null;
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone;
    return /^[+-]/.test(name) ? null : name;
  } catch {
    return null;
  }
}

// The schedule as stored: its own fields only (no by or at, no null one, each exception date once), its time zone in
// canonical form so the router and the dashboard read the same name. Validate first.
export function normalizeSchedule(s) {
  if (!isObject(s)) return s;
  return defined({
    timeZone: canonicalZone(s.timeZone) ?? s.timeZone,
    windows: (s.windows ?? []).map((w) => defined({ kind: w.kind, days: w.days, start: w.start, end: w.end, wake: w.wake })),
    exceptions: s.exceptions && [...new Set(s.exceptions)],
    maxNapDays: s.maxNapDays,
  });
}

// Local days are numbered from 1970-01-01, a Thursday; weekdays from 0 (mon).
const weekday = (day) => (((day + 3) % 7) + 7) % 7;
const dateOf = (day) => iso(day * DAY).slice(0, 10);

const formatters = new Map();
function formatter(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

// The local wall clock at t, read as if it were UTC, to the second.
function wallClock(t, timeZone) {
  const p = {};
  for (const { type, value } of formatter(timeZone).formatToParts(t)) p[type] = value;
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

const offsetAt = (t, timeZone) => wallClock(t, timeZone) - Math.floor(t / 1000) * 1000;
const localDay = (t, timeZone) => Math.floor(wallClock(t, timeZone) / DAY);

// The instant of the local wall time `minutes` after midnight of local day `day`. A wall time a clock change skips is
// the first valid minute after it (the change itself); one it repeats is its first instance. A zone changes at most
// once within a day of any wall time.
function instantOf(day, minutes, timeZone) {
  const wall = day * DAY + minutes * MINUTE;
  const before = offsetAt(wall - DAY, timeZone);
  const after = offsetAt(wall + DAY, timeZone);
  if (before === after) return wall - before;
  const valid = [wall - before, wall - after].filter((t) => t + offsetAt(t, timeZone) === wall);
  if (valid.length) return Math.min(...valid);
  // Skipped: the offset is `before` until the change and `after` from it; find the change to the minute.
  let [lo, hi] = [wall - after, wall - before];
  while (hi - lo > MINUTE) {
    const mid = lo + Math.floor((hi - lo) / 2 / MINUTE) * MINUTE;
    if (offsetAt(mid, timeZone) === before) lo = mid;
    else hi = mid;
  }
  return hi;
}

// A valid schedule's windows ready for arithmetic, or null when it has none.
function prepare(s) {
  if (!s?.timeZone || !Array.isArray(s.windows) || !s.windows.length) return null;
  return {
    timeZone: s.timeZone,
    exceptions: new Set(s.exceptions ?? []),
    windows: s.windows.map((w, window) => ({
      window, kind: w.kind, days: new Set(w.days), start: minutesOf(w.start), end: minutesOf(w.end),
      ...(w.kind === 'nap' ? { wake: w.wake ?? 'never' } : {}),
    })),
  };
}

// The occurrences of the windows (of `kind` when given) that start on local day `day`: an occurrence ends at `end` the
// same day, the next day when `end` <= `start` (24 hours of wall time when equal). None on an exception date, and none
// that a clock change leaves empty.
function occurrencesOn(plan, day, kind) {
  if (plan.exceptions.has(dateOf(day))) return [];
  const occurrences = [];
  for (const w of plan.windows) {
    if ((kind && w.kind !== kind) || !w.days.has(DAYS[weekday(day)])) continue;
    const start = instantOf(day, w.start, plan.timeZone);
    const end = instantOf(w.end > w.start ? day : day + 1, w.end, plan.timeZone);
    if (end > start) occurrences.push({ kind: w.kind, window: w.window, start, end, ...(w.wake ? { wake: w.wake } : {}) });
  }
  return occurrences;
}

const byStart = (a, b) => a.start - b.start;

// The window occurrence active at t, or null. Windows of one kind may overlap: the occurrence is the one that started
// last (its id changes only when a window starts), `end` is where their union ends (within 8 days: when the nap
// actually ends), and a nap's `wake` is `never` when any active nap window says so.
export function occurrenceAt(s, t) {
  const plan = prepare(s);
  if (!plan) return null;
  const today = localDay(t, plan.timeZone);
  let near = [...occurrencesOn(plan, today - 1), ...occurrencesOn(plan, today)];
  const active = near.filter((o) => o.start <= t && t < o.end);
  if (!active.length) return null;
  const { kind, window, start } = active.reduce((a, b) => (b.start > a.start ? b : a));
  const same = active.filter((o) => o.kind === kind);
  let end = Math.max(...same.map((o) => o.end));
  // Extend it through the occurrences of this kind that start before it ends, or as it ends, a day at a time.
  for (let day = today + 1; ; day++) {
    for (const o of near.filter((n) => n.kind === kind).sort(byStart)) if (o.start <= end && o.end > end) end = o.end;
    if (day > today + HORIZON_DAYS || localDay(end, plan.timeZone) < day) break;
    near = occurrencesOn(plan, day, kind);
  }
  return {
    kind, window, id: `${window}@${iso(start)}`, start, end,
    ...(kind === 'nap' ? { wake: same.some((o) => o.wake === 'never') ? 'never' : 'header' } : {}),
  };
}

// The next `count` window starts and ends after t, within `horizonDays`; at one instant, an end comes first. Windows of
// one kind count as their union, as in occurrenceAt: an end that another occurrence of that kind holds (including one
// starting then) is not an end, while each start stays (a new occurrence); identical events are the lowest window's.
export function nextEvents(s, t, { count = 5, horizonDays = HORIZON_DAYS } = {}) {
  const plan = prepare(s);
  if (!plan) return [];
  const last = t + horizonDays * DAY;
  const occurrences = [];
  for (let day = localDay(t, plan.timeZone) - 1; day <= localDay(last, plan.timeZone); day++) occurrences.push(...occurrencesOn(plan, day));
  const held = (kind, at) => occurrences.some((o) => o.kind === kind && o.start <= at && at < o.end);
  const edges = [];
  for (const o of occurrences) {
    if (o.start > t && o.start <= last) edges.push({ at: o.start, kind: `${o.kind}-start`, window: o.window });
    if (o.end > t && o.end <= last && !held(o.kind, o.end)) edges.push({ at: o.end, kind: `${o.kind}-end`, window: o.window });
  }
  const rank = (e) => (e.kind.endsWith('-end') ? 0 : 1);
  return edges.sort((a, b) => a.at - b.at || rank(a) - rank(b) || a.window - b.window)
    .filter((e, i, sorted) => i === 0 || e.at !== sorted[i - 1].at || e.kind !== sorted[i - 1].kind)
    .slice(0, count).map((e) => ({ ...e, at: iso(e.at) }));
}

// Whether an awake window's occurrence starts from t to t + ms, both included.
export function awakeStartWithin(s, t, ms) {
  const plan = prepare(s);
  if (!plan) return false;
  for (let day = localDay(t, plan.timeZone) - 1; day <= localDay(t + ms, plan.timeZone); day++) {
    if (occurrencesOn(plan, day, 'awake').some((o) => o.start >= t && o.start <= t + ms)) return true;
  }
  return false;
}

// When a workload asleep since `asleepSince` is woken for maintenance: `maxNapDays` elapsed days later, or null.
export function maintenanceDue(s, asleepSince) {
  return s?.maxNapDays && Number.isFinite(asleepSince) ? asleepSince + s.maxNapDays * DAY : null;
}

// The local weekday and time at t, "Tue 07:00".
export function localTime(t, timeZone) {
  const wall = wallClock(t, timeZone);
  return `${LABELS[weekday(Math.floor(wall / DAY))]} ${iso(wall).slice(11, 16)}`;
}

function windowProblems(w, field) {
  if (!isObject(w)) return [`${field}: an object with kind, days, start and end`];
  const problems = [];
  if (w.kind !== 'awake' && w.kind !== 'nap') problems.push(`${field}.kind: awake or nap`);
  const days = Array.isArray(w.days) ? w.days : [];
  if (!days.length || new Set(days).size !== days.length || !days.every((d) => DAYS.includes(d))) {
    problems.push(`${field}.days: one or more of ${DAYS.join(', ')}, each once`);
  }
  if (minutesOf(w.start) === null) problems.push(`${field}.start: HH:MM, minutes a multiple of 5`);
  if (minutesOf(w.end) === null) problems.push(`${field}.end: HH:MM, minutes a multiple of 5`);
  if (!absent(w.wake)) {
    if (w.kind === 'awake') problems.push(`${field}.wake: nap windows only`);
    else if (!WAKES.includes(w.wake)) problems.push(`${field}.wake: never or header`);
  }
  return problems;
}

// Own keys, so a parsed __proto__ or constructor key is caught too.
const unknownFields = (object, fields, prefix) => Object.keys(object).filter((k) => !fields.includes(k)).map((k) => `${prefix}${k}: unknown field`);

// A window's occurrences in minutes of the local week (mon 00:00 = 0), each [from, to) with to up to a day past the
// week's end. Wall time, so the comparison holds whatever the clock changes.
function weekSpans(w) {
  const start = minutesOf(w.start);
  const end = minutesOf(w.end);
  const length = end > start ? end - start : end - start + 1440;
  return w.days.map((d) => DAYS.indexOf(d) * 1440 + start).map((from) => [from, from + length]);
}

const weekTime = (m) => `${DAYS[Math.floor(m / 1440) % 7]} ${pad(Math.floor((m % 1440) / 60))}:${pad(m % 60)}`;

// The first span of the week where two windows overlap, as "mon 18:00–19:00", or null.
function overlap(a, b) {
  let first = null;
  for (const [af, at] of weekSpans(a)) {
    for (const [bf, bt] of weekSpans(b)) {
      for (const shift of [-WEEK, 0, WEEK]) {
        const from = Math.max(af, bf + shift);
        const to = Math.min(at, bt + shift);
        if (from < to && (!first || from % WEEK < first[0])) first = [from % WEEK, from % WEEK + to - from];
      }
    }
  }
  if (!first) return null;
  const [from, to] = first;
  return `${weekTime(from)}–${Math.floor(to / 1440) === Math.floor(from / 1440) ? weekTime(to).slice(4) : weekTime(to)}`;
}

// An awake window and a nap window may not overlap anywhere in the week; two of the same kind may.
function overlapProblems(windows) {
  const valid = windows.map((w, i) => ({ w, i })).filter(({ w }) => !windowProblems(w, '').length);
  const problems = [];
  for (const b of valid) {
    for (const a of valid.filter((v) => v.i < b.i && v.w.kind !== b.w.kind)) {
      const span = overlap(a.w, b.w);
      if (span) problems.push(`windows[${b.i}]: the ${b.w.kind} window overlaps the ${a.w.kind} window windows[${a.i}] (${span})`);
    }
  }
  return problems;
}

// Why the schedule is refused, each problem naming its field; empty when it is valid.
export function scheduleProblems(s) {
  if (!isObject(s)) return ['schedule: an object'];
  const { timeZone, windows, exceptions, maxNapDays } = s;
  const listed = Array.isArray(windows) ? windows : [];
  const problems = [];
  if (absent(maxNapDays) && (absent(windows) || (Array.isArray(windows) && !windows.length))) {
    problems.push('schedule: windows or maxNapDays required');
  }
  if (!absent(timeZone) && !canonicalZone(timeZone)) problems.push('timeZone: an IANA time zone name, such as Europe/Paris');
  else if (absent(timeZone) && listed.length) problems.push('timeZone: required with windows');
  if (!absent(windows) && !Array.isArray(windows)) problems.push('windows: a list');
  else if (listed.length > WINDOWS_MAX) problems.push(`windows: at most ${WINDOWS_MAX}`);
  else {
    problems.push(...listed.flatMap((w, i) => [
      ...windowProblems(w, `windows[${i}]`), ...(isObject(w) ? unknownFields(w, WINDOW_FIELDS, `windows[${i}].`) : []),
    ]), ...overlapProblems(listed));
  }
  if (!absent(exceptions) && !Array.isArray(exceptions)) problems.push('exceptions: a list');
  else if (exceptions?.length > EXCEPTIONS_MAX) problems.push(`exceptions: at most ${EXCEPTIONS_MAX}`);
  else (exceptions ?? []).forEach((d, i) => !isDate(d) && problems.push(`exceptions[${i}]: a date YYYY-MM-DD`));
  if (!absent(maxNapDays) && !(Number.isInteger(maxNapDays) && maxNapDays >= 1 && maxNapDays <= NAP_DAYS_MAX)) {
    problems.push(`maxNapDays: a whole number from 1 to ${NAP_DAYS_MAX}`);
  }
  return [...problems, ...unknownFields(s, FIELDS, '')];
}
