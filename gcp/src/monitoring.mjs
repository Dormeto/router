// Cloud Monitoring: the load balancer's request count (G0, spec section 12 result 6): the metric
// `loadbalancing.googleapis.com/https/request_count`, labelled by `url_map_name` and `backend_target_name` (the
// backend service). The counts are estimates, and the first point comes 72 to 125 s after the requests.
const MONITORING = 'https://monitoring.googleapis.com/v3';
const METRIC = 'loadbalancing.googleapis.com/https/request_count';

export const CALLS = {
  requestCount: ['monitoring.timeSeries.list'],
};

export function createMonitoring({ google, project }) {
  // The requests the backend service's series count over [from, to] (ms): the sum of its points.
  async function requestCount({ urlMap, backendService, from, to }) {
    const filter = `metric.type = "${METRIC}" AND resource.labels.url_map_name = "${urlMap}" AND resource.labels.backend_target_name = "${backendService}"`;
    let total = 0;
    let page = '';
    do {
      const query = new URLSearchParams({
        filter,
        'interval.startTime': new Date(from).toISOString(),
        'interval.endTime': new Date(to).toISOString(),
        ...(page ? { pageToken: page } : {}),
      });
      const answer = await google.request('GET', `${MONITORING}/projects/${project}/timeSeries?${query}`);
      for (const series of answer.timeSeries ?? []) {
        for (const { value } of series.points ?? []) total += Number(value.int64Value ?? value.doubleValue ?? 0);
      }
      page = answer.nextPageToken ?? '';
    } while (page);
    return total;
  }

  return { requestCount };
}
