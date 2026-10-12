const MINUTE_MS = 60_000;

function requestQuery(cfg, startMs, endMs) {
  return {
    StartTime: new Date(startMs),
    EndTime: new Date(endMs),
    MetricDataQueries: [{
      Id: 'requests',
      ReturnData: true,
      MetricStat: {
        Metric: {
          Namespace: 'AWS/ApplicationELB',
          MetricName: 'RequestCount',
          Dimensions: [
            { Name: 'LoadBalancer', Value: cfg.loadBalancerDimension },
            { Name: 'TargetGroup', Value: cfg.appTargetGroupDimension },
          ],
        },
        Period: 60,
        Stat: 'Sum',
      },
    }],
  };
}

export async function requestSum(cloudwatch, cfg, startMs, endMs) {
  const out = await cloudwatch.getMetricData(requestQuery(cfg, startMs, endMs));
  return (out.MetricDataResults ?? []).flatMap((r) => r.Values ?? []).reduce((sum, v) => sum + v, 0);
}

// End of the last one-minute period with at least one request, or null.
export async function lastRequestAt(cloudwatch, cfg, startMs, endMs) {
  const out = await cloudwatch.getMetricData(requestQuery(cfg, startMs, endMs));
  let last = null;
  for (const result of out.MetricDataResults ?? []) {
    (result.Timestamps ?? []).forEach((timestamp, i) => {
      if ((result.Values?.[i] ?? 0) <= 0) return;
      const end = new Date(timestamp).getTime() + MINUTE_MS;
      if (last === null || end > last) last = end;
    });
  }
  return last;
}
