const MINUTE_MS = 60_000;

function requestQuery(cfg, startMs, endMs, others) {
  return {
    StartTime: new Date(startMs),
    EndTime: new Date(endMs),
    MetricDataQueries: [cfg.appTargetGroupDimension, ...others].map((targetGroup, i) => ({
      Id: i ? `requests${i}` : 'requests',
      ReturnData: true,
      MetricStat: {
        Metric: {
          Namespace: 'AWS/ApplicationELB',
          MetricName: 'RequestCount',
          Dimensions: [
            { Name: 'LoadBalancer', Value: cfg.loadBalancerDimension },
            { Name: 'TargetGroup', Value: targetGroup },
          ],
        },
        Period: 60,
        Stat: 'Sum',
      },
    })),
  };
}

// End of the last one-minute period with at least one request, or null. others: the dimensions of other target groups
// the workload's requests may take (a grouped Ingress: Dormeto's own, while its rule is before the customer's).
export async function lastRequestAt(cloudwatch, cfg, startMs, endMs, others = []) {
  const out = await cloudwatch.getMetricData(requestQuery(cfg, startMs, endMs, others));
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
