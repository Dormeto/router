export async function requestSum(cloudwatch, cfg, startMs, endMs) {
  const out = await cloudwatch.getMetricData({
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
  });
  return (out.MetricDataResults ?? []).flatMap((r) => r.Values ?? []).reduce((sum, v) => sum + v, 0);
}
