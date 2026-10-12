// JSON log lines. With metrics, the events that Dormeto counts are written as CloudWatch embedded metric format (EMF)
// documents instead: the same line carries the metric, extracted by CloudWatch without any API call. EMF lines must be
// pure JSON, hence the raw stdout writer (console.log adds the Lambda prefix).
const METRIC_EVENTS = { WakeIgnored: 'IgnoredRequests', WakeDeferred: 'DeferredRequests', WakeRequested: 'Wakes', PendingWake: 'Wakes' };

export function createLogger({
  metrics = null,
  out = (line) => console.log(line),
  raw = (line) => process.stdout.write(`${line}\n`),
  now = Date.now,
} = {}) {
  const write = (level) => (event, fields = {}) => {
    const entry = { level, event, ...fields };
    const metric = metrics && fields.workloadId ? METRIC_EVENTS[event] : undefined;
    if (!metric) {
      out(JSON.stringify(entry));
      return;
    }
    raw(JSON.stringify({
      ...entry,
      Router: metrics.router,
      WorkloadId: fields.workloadId,
      [metric]: 1,
      _aws: {
        Timestamp: now(),
        CloudWatchMetrics: [{ Namespace: 'Dormeto', Dimensions: [['Router', 'WorkloadId']], Metrics: [{ Name: metric, Unit: 'Count' }] }],
      },
    }));
  };
  return { info: write('info'), warn: write('warn'), error: write('error') };
}

export const logger = createLogger();
