// Time-based behavior (R12 design, section 3): a workload's awake and nap windows in its time zone, exception dates and a
// maximum nap. A window repeats on weekly days, or by a pattern or a cron expression within a range of dates (schedule
// recurrence design). Pure: instants are epoch milliseconds passed in; local wall times come from Intl only.
export const WINDOWS_MAX = 100;
export const EXCEPTIONS_MAX = 100;
export const NAP_DAYS_MAX = 60;
// An idle nap, or a nap window's occurrence, is skipped when an awake window starts within this delay.
export const CLOSE_START_MS = 30 * 60_000;
// Two occurrences of one kind separated by this gap or less count as one (design, section 11).
export const JOIN_DEFAULT_MINUTES = 15;
export const JOIN_MINUTES_MAX = 120;
// How long after its end a window stays in the schedule (the user, 2026-11-02): the organization's workloads.endedWindowDays,
// 0 (kept) or 30 days to 10 years, a year by default.
export const ENDED_DAYS_DEFAULT = 365;
export const ENDED_DAYS_MIN = 30;
export const ENDED_DAYS_MAX = 3650;

const MINUTE = 60_000;
const DAY = 86_400_000;
const WEEK = 7 * 1440;
const HORIZON_DAYS = 8;
// What nextEvents reads when a window has a repeat or a from, long enough for a yearly one.
const REPEAT_HORIZON_DAYS = 400;
// What the overlap check compares when a window has a from, an until or a repeat.
const OVERLAP_DAYS = 400;
// At least what a clock change moves a wall time by: how far a joined gap's local day can be from its minutes.
const CLOCK_CHANGE_MINUTES = 120;
const END_DATED_MS = 6 * DAY;
const INTERVAL_MAX = 99;
const CRON_LENGTH_MAX = 200;
const CRON_MINUTES_MAX = WEEK;
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WAKES = ['never', 'header'];
// The fields of a schedule and of a window; `by` and `at` (who set it, when) are accepted and ignored, so a schedule
// read back can be sent again as it is.
const FIELDS = ['timeZone', 'windows', 'exceptions', 'maxNapDays', 'joinMinutes', 'by', 'at'];
const WINDOW_FIELDS = ['kind', 'days', 'start', 'end', 'repeat', 'from', 'until', 'wake', 'exceptions'];
// The fields of a repeat, by pattern.
const REPEAT_FIELDS = {
  daily: ['pattern', 'interval'],
  weekly: ['pattern', 'interval', 'days'],
  monthly: ['pattern', 'interval', 'day', 'nth', 'weekday'],
  cron: ['pattern', 'cron', 'minutes'],
};
const PATTERNS = Object.keys(REPEAT_FIELDS);
const REPEAT_KNOWN = [...new Set(Object.values(REPEAT_FIELDS).flat())];
const NTHS = [1, 2, 3, 4, -1];
const CRON_WORDING = 'five fields: minute hour day-of-month month day-of-week';
// What EventBridge and Quartz take and crontab does not: it reads as their expression, not as a typing mistake.
const CRON_FOREIGN = /^cron\(|#|(^|[\s,])(\d*L|L-\d+|LW|\d*W|[a-z]{3}L)(?=$|[\s,])/i;
const CRON_ITEM = /^(?:\*|(\w+)(?:-(\w+))?)(?:\/(\d+))?$/;
// `days`: a day field, which takes `?`. A weekday is 0 to 7, 0 and 7 both Sunday.
const CRON_FIELDS = [
  { name: 'minute', low: 0, high: 59 },
  { name: 'hour', low: 0, high: 23 },
  { name: 'day-of-month', low: 1, high: 31, days: true },
  { name: 'month', low: 1, high: 12, names: ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] },
  { name: 'day-of-week', low: 0, high: 7, days: true, names: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] },
];
// The longest each month can be, from 1: a cron date only has to exist in some year.
const MONTH_DAYS = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
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

// The schedule as stored: its own fields only (no by or at, no null one, each exception date once, a window's none when its
// list is empty), its time zone in canonical form so the router and the dashboard read the same name. Validate first.
export function normalizeSchedule(s) {
  if (!isObject(s)) return s;
  return defined({
    timeZone: canonicalZone(s.timeZone) ?? s.timeZone,
    windows: (s.windows ?? []).map((w) => defined({
      kind: w.kind, days: w.days, start: w.start, end: w.end, repeat: w.repeat && defined(w.repeat), from: w.from, until: w.until, wake: w.wake,
      exceptions: w.exceptions?.length ? [...new Set(w.exceptions)] : undefined,
    })),
    exceptions: s.exceptions && [...new Set(s.exceptions)],
    maxNapDays: s.maxNapDays,
    joinMinutes: s.joinMinutes,
  });
}

export const isEndedDays = (value) => Number.isInteger(value) && (value === 0 || (value >= ENDED_DAYS_MIN && value <= ENDED_DAYS_MAX));

export const isJoinMinutes = (value) => Number.isInteger(value) && value >= 0 && value <= JOIN_MINUTES_MAX && value % 5 === 0;

// The largest gap that joins: the most specific level that sets it, the workload's (its schedule), the router's, the
// organization's, else the default. Each level is its value; anything that is not one is unset.
export function resolveJoin({ workload, router, manager } = {}) {
  if (isJoinMinutes(workload)) return { joinMinutes: workload, from: 'workload' };
  if (isJoinMinutes(router)) return { joinMinutes: router, from: 'router' };
  if (isJoinMinutes(manager)) return { joinMinutes: manager, from: 'organization' };
  return { joinMinutes: JOIN_DEFAULT_MINUTES, from: 'default' };
}

// Local days are numbered from 1970-01-01, a Thursday; weekdays from 0 (mon).
const weekday = (day) => (((day + 3) % 7) + 7) % 7;
const dateOf = (day) => iso(day * DAY).slice(0, 10);
const dayOfDate = (text) => (absent(text) ? null : Date.parse(text) / DAY);
const mondayOf = (day) => day - weekday(day);
const monthOf = (date) => date.getUTCFullYear() * 12 + date.getUTCMonth();

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

// The zone's offset at a UTC midnight, read once per plan.
function midnightOffset(plan, day) {
  let offset = plan.midnights.get(day);
  if (offset === undefined) plan.midnights.set(day, offset = offsetAt(day * DAY, plan.timeZone));
  return offset;
}

// The offset of a local day's every wall time when no clock change is near it (the day before to the day after), or
// null. Most days are like this, so a day costs one read of the zone however many occurrences it has.
function steadyOffset(plan, day) {
  const before = midnightOffset(plan, day - 1);
  return before === midnightOffset(plan, day + 2) ? before : null;
}

// The instant of the local wall time `minutes` after midnight of local day `day`, past that day's end when it is over a
// day. A wall time a clock change skips is the first valid minute after it (the change itself); one it repeats is its
// first instance. A zone changes at most once within a day of any wall time.
function instantOf(plan, day, minutes) {
  const { timeZone } = plan;
  const wall = day * DAY + minutes * MINUTE;
  const steady = steadyOffset(plan, Math.floor(wall / DAY));
  if (steady !== null) return wall - steady;
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

// The values of one cron field, or null when it does not read: `*`, a number, a range `a-b`, a step `*/s` or `a-b/s`, or
// a comma list of those. Names in any case. `?` is a whole day field. FRI-SUN runs up to the 7 that is Sunday.
function cronValues(text, { low, high, days, names }) {
  const value = (word) => {
    const named = names ? names.indexOf(word.toLowerCase()) : -1;
    if (named >= 0) return named + low;
    return /^\d+$/.test(word) ? Number(word) : NaN;
  };
  const values = new Set();
  for (const item of (days && text === '?' ? '*' : text).split(',')) {
    const match = CRON_ITEM.exec(item);
    if (!match) return null;
    const [, first, last, step] = match;
    if (first && !last && step) return null;
    const from = first ? value(first) : low;
    let to = first ? value(last ?? first) : high;
    if (high === 7 && to === 0 && from > 0 && /^sun$/i.test(last)) to = 7;
    const by = step ? Number(step) : 1;
    if (!(from >= low && to <= high && from <= to && by >= 1)) return null;
    for (let v = from; v <= to; v += by) values.add(v);
  }
  return values;
}

// A cron expression ready for arithmetic: its start minutes in a day, sorted, and its day fields; { problem } when refused.
function parseCron(text) {
  if (typeof text !== 'string') return { problem: CRON_WORDING };
  if (text.length > CRON_LENGTH_MAX) return { problem: `at most ${CRON_LENGTH_MAX} characters` };
  // eslint-disable-next-line no-control-regex
  if (/[\0-\x08\x0a-\x1f\x7f]/.test(text)) return { problem: 'one line, without control characters' };
  const fields = text.trim().split(/\s+/);
  if (fields.length !== CRON_FIELDS.length || CRON_FOREIGN.test(text.trim())) return { problem: CRON_WORDING };
  const values = [];
  for (const [i, field] of CRON_FIELDS.entries()) {
    const read = cronValues(fields[i], field);
    if (!read) {
      const { name, low, high, names } = field;
      return { problem: `the ${name} field takes *, a number from ${low} to ${high}${names ? ' or a name' : ''}, a range a-b, a step */s or a-b/s, or a comma list of those: ${fields[i]}` };
    }
    values.push(read);
  }
  const [minutes, hours, days, months, weekdays] = values;
  if ([...minutes].some((m) => m % 5 !== 0)) return { problem: 'minutes must be multiples of 5, as schedule times are: * is every minute, */5 every five' };
  const open = (i) => fields[i] === '*' || fields[i] === '?';
  // Crontab's manual and its implementations disagree on whether */2 restricts a day field: refused beside the other one.
  const starred = (i) => fields[i].startsWith('*') && !open(i);
  if ((starred(2) && !open(4)) || (starred(4) && !open(2))) return { problem: 'a day field starting with * goes alone: cron versions read */2 with the other day field differently, so give a list or a range' };
  // A weekday comes in every month, so only a day of the month alone can never match.
  if (open(4) && ![...months].some((m) => [...days].some((d) => d <= MONTH_DAYS[m]))) return { problem: 'never matches: no such date in that month' };
  return {
    starts: [...hours].flatMap((h) => [...minutes].map((m) => h * 60 + m)).sort((a, b) => a - b),
    days, months, weekdays: new Set([...weekdays].map((d) => d % 7)), eitherDay: !open(2) && !open(4),
  };
}

// As crontab: the month, and the day fields, either of them when both are restricted.
function cronMatches(cron, date) {
  if (!cron.months.has(date.getUTCMonth() + 1)) return false;
  const inMonth = cron.days.has(date.getUTCDate());
  const inWeek = cron.weekdays.has(date.getUTCDay());
  return cron.eitherDay ? inMonth || inWeek : inMonth && inWeek;
}

// A window ready for arithmetic: plain days are a weekly pattern, and an occurrence is a start minute and a length in wall
// minutes, from `end` (up to 24 hours) or from a cron's `minutes`. `skips`: the window's own dates without it.
function prepareWindow(w, window) {
  const repeat = w.repeat ?? { pattern: 'weekly', days: w.days };
  const cron = repeat.pattern === 'cron' ? parseCron(repeat.cron) : null;
  const start = minutesOf(w.start);
  const end = minutesOf(w.end);
  return {
    window, kind: w.kind, from: dayOfDate(w.from), until: dayOfDate(w.until), skips: new Set(w.exceptions ?? []), pattern: repeat.pattern, interval: repeat.interval ?? 1,
    days: new Set(repeat.days), day: repeat.day, nth: repeat.nth, weekday: DAYS.indexOf(repeat.weekday), cron,
    starts: cron ? cron.starts ?? [] : [start],
    length: cron ? Number(repeat.minutes) || 0 : (end > start ? end - start : end - start + 1440),
    ...(w.kind === 'nap' ? { wake: w.wake ?? 'never' } : {}),
  };
}

// How many days before a day an occurrence of this length can have started and still run on that day.
const lookbackOf = (w, join = 0) => Math.max(1, Math.ceil((w.length + (join ? join + CLOCK_CHANGE_MINUTES : 0)) / 1440));

// A valid schedule's windows ready for arithmetic, or null when it has none. `joinMinutes`: the value its levels resolve
// to; without one, the schedule's own or the default.
function prepare(s, { joinMinutes } = {}) {
  if (!s?.timeZone || !Array.isArray(s.windows) || !s.windows.length) return null;
  const windows = s.windows.map((w, window) => prepareWindow(w, window));
  const join = isJoinMinutes(joinMinutes) ? joinMinutes : resolveJoin({ workload: s.joinMinutes }).joinMinutes;
  return {
    timeZone: s.timeZone,
    exceptions: new Set(s.exceptions ?? []),
    windows,
    midnights: new Map(),
    written: new Map(),
    joinMs: join * MINUTE,
    lookback: Math.max(...windows.map((w) => lookbackOf(w, join))),
    horizonDays: s.windows.some((w) => !absent(w.repeat) || !absent(w.from)) ? REPEAT_HORIZON_DAYS : HORIZON_DAYS,
  };
}

// Whether a window's pattern has local day `day`. Counting an interval needs `from`, and `day` is never before it.
function patternHas(w, day) {
  if (w.pattern === 'weekly') return w.days.has(DAYS[weekday(day)]) && (w.interval === 1 || (mondayOf(day) - mondayOf(w.from)) % (7 * w.interval) === 0);
  if (w.pattern === 'daily') return w.interval === 1 || (day - w.from) % w.interval === 0;
  const date = new Date(day * DAY);
  if (w.pattern === 'cron') return !!w.cron.starts && cronMatches(w.cron, date);
  if (w.pattern !== 'monthly' || (w.interval > 1 && (monthOf(date) - monthOf(new Date(w.from * DAY))) % w.interval !== 0)) return false;
  const inMonth = date.getUTCDate();
  const monthEnd = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  if (absent(w.nth)) return inMonth === Math.min(w.day, monthEnd);
  return weekday(day) === w.weekday && (w.nth === -1 ? inMonth + 7 > monthEnd : Math.ceil(inMonth / 7) === w.nth);
}

const NO_STARTS = [];

// The start minutes of a window's occurrences on local day `day`: none outside its range or its pattern, or on a date of its own
// without it.
function startsOn(w, day) {
  if ((w.from !== null && day < w.from) || (w.until !== null && day > w.until)) return NO_STARTS;
  if (w.skips.size && w.skips.has(dateOf(day))) return NO_STARTS;
  return patternHas(w, day) ? w.starts : NO_STARTS;
}

const byStart = (a, b) => a.start - b.start;

// The occurrences of the windows that start on local day `day`, as written, once per plan: an occurrence ends at `end` the
// same day, the next day when `end` <= `start` (24 hours of wall time when equal), or `minutes` of wall time later. None
// on an exception date, and none that a clock change leaves empty. `all` in the windows' order, each kind by start.
function writtenOn(plan, day) {
  let written = plan.written.get(day);
  if (written) return written;
  const all = [];
  if (!plan.exceptions.has(dateOf(day))) {
    for (const w of plan.windows) {
      for (const minutes of startsOn(w, day)) {
        const start = instantOf(plan, day, minutes);
        const end = instantOf(plan, day, minutes + w.length);
        if (end > start) all.push({ kind: w.kind, window: w.window, start, end, ...(w.wake ? { wake: w.wake } : {}) });
      }
    }
  }
  written = { all, awake: all.filter((o) => o.kind === 'awake').sort(byStart), nap: all.filter((o) => o.kind === 'nap').sort(byStart) };
  plan.written.set(day, written);
  return written;
}

// The first start of a kind from `from` to `to`, both included, or null. Starts are in the order of their days. The
// offset at the UTC day's midnight gives the local day of `from` within a day either way, and a gap ends within two more.
function firstStart(plan, kind, from, to) {
  const near = Math.floor((from + midnightOffset(plan, Math.floor(from / DAY))) / DAY);
  for (let day = near - 1; day <= near + 2; day++) {
    const starts = writtenOn(plan, day)[kind];
    let [lo, hi] = [0, starts.length];
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid].start < from) lo = mid + 1;
      else hi = mid;
    }
    if (lo < starts.length) return starts[lo].start <= to ? starts[lo].start : null;
  }
  return null;
}

// Where an occurrence ends once joined: at the next start of its kind when the gap, in elapsed time, is within the value,
// unless the other kind starts in the gap. A start an exception date or a range removes is no start.
function joinedEnd(plan, o) {
  const next = firstStart(plan, o.kind, o.end, o.end + plan.joinMs);
  if (next === null) return o.end;
  return firstStart(plan, o.kind === 'nap' ? 'awake' : 'nap', o.end, next - 1) === null ? next : o.end;
}

// The occurrences (of `kind` when given) that start on local day `day`, joined. What handles overlapping windows of one
// kind then applies to the gap: the union's end, nextEvents, a nap's wake mode.
function occurrencesOn(plan, day, kind) {
  const written = writtenOn(plan, day);
  const occurrences = kind ? written.all.filter((o) => o.kind === kind) : written.all;
  if (!plan.joinMs) return occurrences;
  return occurrences.map((o) => {
    const end = joinedEnd(plan, o);
    return end === o.end ? o : { ...o, end };
  });
}

// The window occurrence active at t, or null. Windows of one kind may overlap, or join across a short gap: the occurrence
// is the one that started last (its id changes only when a window starts), `end` is where their union ends (when the nap
// actually ends), and a nap's `wake` is `never` when any active nap window says so. Read for 8 days at most: when the union
// goes on past them, `endKnown: false` says `end` is only where the reading stopped. `joinMinutes`: the value the levels
// resolve to (resolveJoin).
export function occurrenceAt(s, t, { joinMinutes } = {}) {
  const plan = prepare(s, { joinMinutes });
  if (!plan) return null;
  const today = localDay(t, plan.timeZone);
  let near = [];
  for (let day = today - plan.lookback; day <= today; day++) near.push(...occurrencesOn(plan, day));
  const active = near.filter((o) => o.start <= t && t < o.end);
  if (!active.length) return null;
  const { kind, window, start } = active.reduce((a, b) => (b.start > a.start ? b : a));
  const same = active.filter((o) => o.kind === kind);
  let end = same.reduce((latest, o) => Math.max(latest, o.end), 0);
  let endKnown = true;
  // Extend it through the occurrences of this kind that start before it ends, or as it ends, a day at a time.
  for (let day = today + 1; ; day++) {
    for (const o of near.filter((n) => n.kind === kind).sort(byStart)) if (o.start <= end && o.end > end) end = o.end;
    const lastDay = localDay(end, plan.timeZone);
    if (lastDay < day) break;
    if (day > today + HORIZON_DAYS) {
      // Stopped by the horizon: its end is a true one unless an occurrence not read holds it.
      for (let unread = day; unread <= lastDay && endKnown; unread++) endKnown = !occurrencesOn(plan, unread, kind).some((o) => o.start <= end && o.end > end);
      break;
    }
    near = occurrencesOn(plan, day, kind);
  }
  return {
    kind, window, id: `${window}@${iso(start)}`, start, end, ...(endKnown ? {} : { endKnown: false }),
    ...(kind === 'nap' ? { wake: same.some((o) => o.wake === 'never') ? 'never' : 'header' } : {}),
  };
}

// Where the union of a kind's occurrences ends: an end that another occurrence of that kind holds (including one starting
// then) is not an end.
function unionEnds(occurrences, kind) {
  const ends = new Set();
  let end = -Infinity;
  for (const o of occurrences.filter((n) => n.kind === kind).sort(byStart)) {
    if (o.start > end) ends.add(end);
    end = o.start > end ? o.end : Math.max(end, o.end);
  }
  return ends.add(end);
}

// The starts and ends of these occurrences after t and up to `last`, in order, each once.
function edgesOf(occurrences, t, last) {
  const ends = { awake: unionEnds(occurrences, 'awake'), nap: unionEnds(occurrences, 'nap') };
  const edges = [];
  for (const o of occurrences) {
    if (o.start > t && o.start <= last) edges.push({ at: o.start, kind: `${o.kind}-start`, window: o.window });
    if (o.end > t && o.end <= last && ends[o.kind].has(o.end)) edges.push({ at: o.end, kind: `${o.kind}-end`, window: o.window });
  }
  const rank = (e) => (e.kind.endsWith('-end') ? 0 : 1);
  return edges.sort((a, b) => a.at - b.at || rank(a) - rank(b) || a.window - b.window)
    .filter((e, i, sorted) => i === 0 || e.at !== sorted[i - 1].at || e.kind !== sorted[i - 1].kind);
}

// The next `count` window starts and ends after t, within `horizonDays` (by default 8 days, 400 with a repeat or a from);
// at one instant, an end comes first. Windows of one kind count as their union, as in occurrenceAt: an end that another
// occurrence of that kind holds (including one starting then) is not an end, while each start stays (a new occurrence);
// identical events are the lowest window's. It reads day by day and stops once `count` events can no longer change.
export function nextEvents(s, t, { count = 5, horizonDays, joinMinutes } = {}) {
  const plan = prepare(s, { joinMinutes });
  if (!plan) return [];
  const shown = (edges) => edges.slice(0, count).map((e) => ({ ...e, at: iso(e.at) }));
  const last = t + (horizonDays ?? plan.horizonDays) * DAY;
  const lastDay = localDay(last, plan.timeZone);
  const occurrences = [];
  // An occurrence gives at most 2 events; reading them again only once there are twice as many keeps this linear.
  let enough = count;
  for (let day = localDay(t, plan.timeZone) - plan.lookback; day <= lastDay; day++) {
    occurrences.push(...occurrencesOn(plan, day).filter((o) => o.end > t));
    if (day < lastDay && occurrences.length * 2 >= enough) {
      // What is still to come starts at the next midnight or later: nothing before it can move or be held.
      const settled = edgesOf(occurrences, t, Math.min(last, instantOf(plan, day + 1, 0) - 1));
      if (settled.length >= count) return shown(settled);
      enough = occurrences.length * 4;
    }
  }
  return shown(edgesOf(occurrences, t, last));
}

// Whether an awake window's occurrence starts from t to t + ms, both included. Joining moves no start.
export function awakeStartWithin(s, t, ms) {
  const plan = prepare(s);
  if (!plan) return false;
  for (let day = localDay(t, plan.timeZone) - 1; day <= localDay(t + ms, plan.timeZone); day++) {
    if (writtenOn(plan, day).awake.some((o) => o.start >= t && o.start <= t + ms)) return true;
  }
  return false;
}

// When a workload asleep since `asleepSince` is woken for maintenance: `maxNapDays` elapsed days later, or null.
export function maintenanceDue(s, asleepSince) {
  return s?.maxNapDays && Number.isFinite(asleepSince) ? asleepSince + s.maxNapDays * DAY : null;
}

// The local weekday and time at t, "Tue 07:00". More than 6 days after `now`, a weekday alone would read as the next one:
// with its date, "Tue 2027-01-19 07:00".
export function localTime(t, timeZone, { now } = {}) {
  const wall = wallClock(t, timeZone);
  const date = now !== undefined && t - now > END_DATED_MS ? `${iso(wall).slice(0, 10)} ` : '';
  return `${LABELS[weekday(Math.floor(wall / DAY))]} ${date}${iso(wall).slice(11, 16)}`;
}

// A nap occurrence's end as the page and the JSON say it: { at, local, timeZone }, at and local null when it is only the
// horizon (endKnown), so nothing shows a date the nap will not end on.
export function napEndOf({ end, endKnown }, timeZone, now) {
  if (endKnown === false) return { at: null, local: null, timeZone };
  return { at: iso(end), local: localTime(end, timeZone, { now }), timeZone };
}

// The x-dormeto-nap-until header: the page's probe knows a nap by its presence, so a nap with no end known has one too.
export const napEndHeader = (napEnd) => napEnd.at ?? 'unknown';

const isDayList = (days) => Array.isArray(days) && !!days.length && new Set(days).size === days.length && days.every((d) => DAYS.includes(d));

function monthlyProblems({ day, nth, weekday: named }, prefix) {
  if (absent(day) === absent(nth) || (!absent(day) && !absent(named))) return [`${prefix}: monthly takes day, or nth with weekday`];
  if (!absent(day)) return Number.isInteger(day) && day >= 1 && day <= 31 ? [] : [`${prefix}.day: a whole number from 1 to 31`];
  return [
    ...(NTHS.includes(nth) ? [] : [`${prefix}.nth: 1, 2, 3, 4, or -1 for the last`]),
    ...(DAYS.includes(named) ? [] : [`${prefix}.weekday: one of ${DAYS.join(', ')}`]),
  ];
}

function repeatProblems(w, field) {
  const prefix = `${field}.repeat`;
  const { repeat } = w;
  if (!isObject(repeat)) return [`${prefix}: an object with a pattern`];
  const { pattern, interval, days, minutes } = repeat;
  const fields = unknownFields(repeat, REPEAT_KNOWN, `${prefix}.`);
  if (!PATTERNS.includes(pattern)) return [`${prefix}.pattern: ${PATTERNS.slice(0, -1).join(', ')} or ${PATTERNS.at(-1)}`, ...fields];
  const problems = Object.keys(repeat).filter((k) => REPEAT_KNOWN.includes(k) && !REPEAT_FIELDS[pattern].includes(k) && !absent(repeat[k]))
    .map((k) => `${prefix}.${k}: not with the ${pattern} pattern`);
  if (pattern === 'cron') {
    const { problem } = parseCron(repeat.cron);
    if (problem) problems.push(`${prefix}.cron: ${problem}`);
    if (!(Number.isInteger(minutes) && minutes % 5 === 0 && minutes >= 5 && minutes <= CRON_MINUTES_MAX)) problems.push(`${prefix}.minutes: a multiple of 5 from 5 to ${CRON_MINUTES_MAX}`);
    return [...problems, ...fields];
  }
  if (!absent(interval) && !(Number.isInteger(interval) && interval >= 1 && interval <= INTERVAL_MAX)) problems.push(`${prefix}.interval: a whole number from 1 to ${INTERVAL_MAX}`);
  else if (interval > 1 && absent(w.from)) problems.push(`${field}.from: required when repeat.interval is above 1, it anchors the count`);
  if (pattern === 'weekly' && !isDayList(days)) problems.push(`${prefix}.days: one or more of ${DAYS.join(', ')}, each once`);
  if (pattern === 'monthly') problems.push(...monthlyProblems(repeat, prefix));
  return [...problems, ...fields];
}

function windowProblems(w, field) {
  if (!isObject(w)) return [`${field}: an object with kind, days, start and end`];
  const problems = [];
  if (w.kind !== 'awake' && w.kind !== 'nap') problems.push(`${field}.kind: awake or nap`);
  if (!absent(w.repeat)) {
    if (!absent(w.days)) problems.push(`${field}.days: days or repeat, never both`);
    problems.push(...repeatProblems(w, field));
  } else if (!isDayList(w.days)) {
    problems.push(`${field}.days: one or more of ${DAYS.join(', ')}, each once`);
  }
  if (w.repeat?.pattern === 'cron') {
    if (!absent(w.start)) problems.push(`${field}.start: not with the cron pattern, repeat.minutes says how long`);
    if (!absent(w.end)) problems.push(`${field}.end: not with the cron pattern, repeat.minutes says how long`);
  } else {
    if (minutesOf(w.start) === null) problems.push(`${field}.start: HH:MM, minutes a multiple of 5`);
    if (minutesOf(w.end) === null) problems.push(`${field}.end: HH:MM, minutes a multiple of 5`);
  }
  if (!absent(w.wake)) {
    if (w.kind === 'awake') problems.push(`${field}.wake: nap windows only`);
    else if (!WAKES.includes(w.wake)) problems.push(`${field}.wake: never or header`);
  }
  if (!absent(w.exceptions) && !Array.isArray(w.exceptions)) problems.push(`${field}.exceptions: a list`);
  else if (w.exceptions?.length > EXCEPTIONS_MAX) problems.push(`${field}.exceptions: at most ${EXCEPTIONS_MAX}`);
  else (w.exceptions ?? []).forEach((d, i) => !isDate(d) && problems.push(`${field}.exceptions[${i}]: a date YYYY-MM-DD`));
  if (!absent(w.from) && !isDate(w.from)) problems.push(`${field}.from: a date YYYY-MM-DD`);
  if (!absent(w.until) && !isDate(w.until)) problems.push(`${field}.until: a date YYYY-MM-DD`);
  else if (!absent(w.until) && isDate(w.from) && w.until < w.from) problems.push(`${field}.until: not before from`);
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

const isWeekly = (w) => absent(w.from) && absent(w.until) && absent(w.repeat) && !w.exceptions?.length;
const wallTime = (m) => `${dateOf(Math.floor(m / 1440))} ${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;

// The first span where two prepared windows' occurrences overlap, in wall time, over the 400 days from the later of today
// and their from dates, as "2027-03-15 08:00–12:00", or null. An exception date has no occurrence. A window's occurrences
// all last the same, so its latest start is the one that reaches furthest, and an overlap begins at a start.
function firstOverlap(a, b, today, exceptions) {
  const first = Math.max(today, a.from ?? today, b.from ?? today);
  let [latestA, latestB] = [-Infinity, -Infinity];
  for (let day = first - Math.max(lookbackOf(a), lookbackOf(b)); day < first + OVERLAP_DAYS; day++) {
    if (exceptions.has(dateOf(day))) continue;
    const [startsA, startsB] = [startsOn(a, day), startsOn(b, day)];
    for (let i = 0, j = 0; i < startsA.length || j < startsB.length;) {
      if (j >= startsB.length || startsA[i] <= startsB[j]) latestA = day * 1440 + startsA[i++];
      else latestB = day * 1440 + startsB[j++];
      const from = Math.max(latestA, latestB, first * 1440);
      const to = Math.min(latestA + a.length, latestB + b.length);
      if (from < to) return `${wallTime(from)}–${Math.floor(to / 1440) === Math.floor(from / 1440) ? wallTime(to).slice(11) : wallTime(to)}`;
    }
  }
  return null;
}

// An awake window and a nap window may not overlap: anywhere in the week between two plain weekly windows, in the next 400
// days as soon as either has a from, an until, a repeat or dates of its own without it. Two of the same kind may.
function overlapProblems(windows, { timeZone, exceptions, now }) {
  const valid = windows.map((w, i) => ({ w, i })).filter(({ w }) => !windowProblems(w, '').length)
    .map(({ w, i }) => ({ w, i, prepared: prepareWindow(w, i) }));
  const today = localDay(now, canonicalZone(timeZone) ?? 'UTC');
  const excepted = new Set(Array.isArray(exceptions) ? exceptions : []);
  const problems = [];
  for (const b of valid) {
    for (const a of valid.filter((v) => v.i < b.i && v.w.kind !== b.w.kind)) {
      const span = isWeekly(a.w) && isWeekly(b.w) ? overlap(a.w, b.w) : firstOverlap(a.prepared, b.prepared, today, excepted);
      if (span) problems.push(`windows[${b.i}]: the ${b.w.kind} window overlaps the ${a.w.kind} window windows[${a.i}] (${span})`);
    }
  }
  return problems;
}

// Whether a prepared window has a valid occurrence (its pattern, its range, its own dates and the schedule's) that ends after
// `cutoff`: one to come counts, and so does one that ended since. A window without an end date always has one to come: a
// pattern that never matches is refused when saved.
function endsAfter(plan, w, cutoff) {
  if (w.until === null) return true;
  const first = localDay(cutoff, plan.timeZone) - lookbackOf(w);
  for (let day = Math.max(first, w.from ?? first); day <= w.until; day++) {
    if (plan.exceptions.has(dateOf(day))) continue;
    for (const minutes of startsOn(w, day)) {
      const end = instantOf(plan, day, minutes + w.length);
      if (end > cutoff && end > instantOf(plan, day, minutes)) return true;
    }
  }
  return false;
}

// The schedule without what has ended (the user, 2026-11-02: "expired windows are the ones having no valid occurrence since 1y
// and none in the future"): a window none of whose valid occurrences ends within the last `days` days or later, and the dates
// without a window older than `days` days in the schedule's zone, the schedule's and each window's. Null when nothing goes, or
// for 0 days; else { schedule, windows, dates }, what was removed, the schedule null when nothing is left (no window, no
// maximum nap).
export function withoutEnded(s, t, days = ENDED_DAYS_DEFAULT) {
  const zone = isObject(s) && canonicalZone(s.timeZone);
  if (!days || !zone || !Array.isArray(s.windows)) return null;
  const before = dateOf(localDay(t, zone) - days);
  const plan = s.windows.length ? prepare({ ...s, timeZone: zone }) : null;
  const cutoff = t - days * DAY;
  const old = (date) => typeof date === 'string' && date < before;
  let dates = 0;
  const kept = (list) => {
    const left = list.filter((date) => !old(date));
    dates += list.length - left.length;
    return left;
  };
  const windows = s.windows.filter((w, i) => endsAfter(plan, plan.windows[i], cutoff)).map((w) => {
    if (!Array.isArray(w.exceptions)) return w;
    const { exceptions, ...rest } = w;
    const left = kept(exceptions);
    return left.length ? { ...rest, exceptions: left } : rest;
  });
  const exceptions = Array.isArray(s.exceptions) ? kept(s.exceptions) : s.exceptions;
  const removed = s.windows.length - windows.length;
  if (!removed && !dates) return null;
  if (!windows.length && absent(s.maxNapDays)) return { schedule: null, windows: removed, dates };
  const { exceptions: _, ...rest } = s;
  return { schedule: { ...rest, windows, ...(exceptions?.length ? { exceptions } : {}) }, windows: removed, dates };
}

// Why the schedule is refused, each problem naming its field; empty when it is valid. `now` is where the overlap check of
// recurring windows starts.
export function scheduleProblems(s, { now = Date.now() } = {}) {
  if (!isObject(s)) return ['schedule: an object'];
  const { timeZone, windows, exceptions, maxNapDays, joinMinutes } = s;
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
    ]), ...overlapProblems(listed, { timeZone, exceptions, now }));
  }
  if (!absent(exceptions) && !Array.isArray(exceptions)) problems.push('exceptions: a list');
  else if (exceptions?.length > EXCEPTIONS_MAX) problems.push(`exceptions: at most ${EXCEPTIONS_MAX}`);
  else (exceptions ?? []).forEach((d, i) => !isDate(d) && problems.push(`exceptions[${i}]: a date YYYY-MM-DD`));
  if (!absent(maxNapDays) && !(Number.isInteger(maxNapDays) && maxNapDays >= 1 && maxNapDays <= NAP_DAYS_MAX)) {
    problems.push(`maxNapDays: a whole number from 1 to ${NAP_DAYS_MAX}`);
  }
  if (!absent(joinMinutes) && !isJoinMinutes(joinMinutes)) problems.push(`joinMinutes: a whole number from 0 to ${JOIN_MINUTES_MAX}, a multiple of 5`);
  return [...problems, ...unknownFields(s, FIELDS, '')];
}
