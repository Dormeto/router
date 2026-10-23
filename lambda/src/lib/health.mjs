// Router health (router management): the idle check schedule, Lambda errors and throttles, failure queues, IP lists and
// failed workloads, as problems with a level.
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const ago = (ms) => (ms < 2 * HOUR_MS ? `${Math.round(ms / 60_000)} minutes ago` : `${Math.floor(ms / HOUR_MS)} hours ago`);
const CONCURRENCY_SHARE = 0.8;
const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Errors and throttles of the controller and the waker over 24 hours, and the waker's peak concurrency.
export async function lambdaMetrics(cloudwatch, functions, now) {
  const metric = (id, name, metricName, stat) => ({
    Id: id,
    ReturnData: true,
    MetricStat: { Metric: { Namespace: 'AWS/Lambda', MetricName: metricName, Dimensions: [{ Name: 'FunctionName', Value: name }] }, Period: 3600, Stat: stat },
  });
  const queries = [];
  for (const role of ['controller', 'waker']) {
    if (!functions[role]) continue;
    queries.push(metric(`${role}Errors`, functions[role], 'Errors', 'Sum'), metric(`${role}Throttles`, functions[role], 'Throttles', 'Sum'));
    if (role === 'waker') queries.push(metric('wakerConcurrency', functions.waker, 'ConcurrentExecutions', 'Maximum'));
  }
  if (!queries.length) return {};
  const out = await cloudwatch.getMetricData({ StartTime: new Date(now - DAY_MS), EndTime: new Date(now), MetricDataQueries: queries });
  const values = (id) => (out.MetricDataResults ?? []).filter((r) => r.Id === id).flatMap((r) => r.Values ?? []);
  const sum = (id) => values(id).reduce((total, v) => total + v, 0);
  const figures = {};
  if (functions.controller) figures.controller = { errors: sum('controllerErrors'), throttles: sum('controllerThrottles') };
  if (functions.waker) figures.waker = { errors: sum('wakerErrors'), throttles: sum('wakerThrottles'), peakConcurrency: Math.max(0, ...values('wakerConcurrency')) };
  return figures;
}

// Messages waiting in the failure queues: { check, controller } (the queues configured only).
export async function queueDepths(sqs, queues) {
  const depths = {};
  for (const [name, url] of Object.entries(queues ?? {})) {
    if (!url || !sqs) continue;
    const { Attributes = {} } = await sqs.getQueueAttributes({ QueueUrl: url, AttributeNames: ['ApproximateNumberOfMessages'] });
    depths[name] = Number(Attributes.ApproximateNumberOfMessages ?? 0);
  }
  return depths;
}

// The scheduled idle check is late after three periods of its schedule (five minutes when unknown), or when none ran.
export function checkLate(schedule, lastScheduledCheckAt, now) {
  if (!lastScheduledCheckAt) return true;
  const rate = /rate\((\d+) (minute|minutes|hour|hours)\)/.exec(schedule ?? '');
  const cron = /^cron\(0\/(\d+) \* \* \* \? \*\)$/.exec(schedule ?? '');
  const periodMs = rate ? Number(rate[1]) * (rate[2].startsWith('hour') ? HOUR_MS : 60_000) : cron ? Number(cron[1]) * 60_000 : 5 * 60_000;
  return now - lastScheduledCheckAt > 3 * periodMs;
}

const QUEUES = {
  check: 'check-failures queue: scheduled idle checks that could not invoke the controller',
  controller: 'controller-failures queue: naps or wakes that failed in their own invocation',
};

// { status: ok | warning | error, problems: [{ level, code, text }] }: only a late idle check is an error (no nap
// happens). The code is stable whatever the figures in the text: the manager's alarms open and resolve on it.
export function healthOf({ checkSchedule, lastScheduledCheckAt, now, lambda = {}, queues = {}, ipLists = [], catalogError = null, managerSettingsError = null, failed = 0, concurrency = null }) {
  const problems = [];
  const warn = (code, text) => problems.push({ level: 'warning', code, text });
  if (checkLate(checkSchedule, lastScheduledCheckAt, now)) {
    problems.push({
      level: 'error',
      code: 'check-late',
      text: lastScheduledCheckAt
        ? `idle check late: the last scheduled check ran ${ago(now - lastScheduledCheckAt)}, workloads do not nap on their own`
        : 'no scheduled idle check recorded: workloads do not nap on their own',
    });
  }
  if (queues.error) warn('queues-unreadable', `failure queues unreadable: ${queues.error}`);
  for (const [name, text] of Object.entries(QUEUES)) if (queues[name] > 0) warn(`queue-${name}`, `${count(queues[name], 'message')} in the ${text}`);
  if (lambda.error) warn('metrics-unreadable', `Lambda metrics unreadable: ${lambda.error}`);
  for (const role of ['controller', 'waker']) {
    const figures = lambda[role];
    if (figures?.errors > 0) warn(`${role}-errors`, `${role}: ${count(figures.errors, 'error')} in 24 hours`);
    if (figures?.throttles > 0) warn(`${role}-throttles`, `${role}: ${count(figures.throttles, 'throttle')} in 24 hours`);
  }
  for (const list of ipLists) {
    if (list.error) warn(`ip-list:${list.name}`, `IP list ${list.name}: ${list.error}`);
    else if (list.fetchedAt && now - Date.parse(list.fetchedAt) > 2 * (list.refreshHours ?? 24) * HOUR_MS) warn(`ip-list:${list.name}`, `IP list ${list.name}: last downloaded ${ago(now - Date.parse(list.fetchedAt))}`);
  }
  if (catalogError) warn('ip-lists-catalog', `IP lists catalog of the manager: ${catalogError}`);
  if (managerSettingsError) warn('manager-settings-unreadable', `manager settings unreadable: ${managerSettingsError}`);
  if (failed > 0) warn('failed-workloads', `${count(failed, 'failed workload')}`);
  // A region the account barely uses can be limited to 10 concurrent executions: held requests beyond it get errors. The
  // limit is shared by every function of the account: a warning once the router can need more than 80% of it.
  if (concurrency?.error) warn('concurrency-unreadable', `Lambda concurrency limit unreadable: ${concurrency.error}`);
  else if (concurrency && concurrency.needed > CONCURRENCY_SHARE * concurrency.limit) {
    warn('concurrency', `Lambda concurrency limit of the account in this region is ${concurrency.limit}: the router can need up to ${concurrency.needed} at once (its waker's 24-hour peak, plus its queued naps and wakes, drift repairs and the check), more than ${CONCURRENCY_SHARE * 100}% of it; requests beyond the limit get errors: request a higher quota`);
  }
  const status = problems.some((p) => p.level === 'error') ? 'error' : problems.length ? 'warning' : 'ok';
  return { status, problems };
}
