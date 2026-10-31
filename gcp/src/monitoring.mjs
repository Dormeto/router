// Cloud Monitoring: the load balancer's request count (G0, spec section 12 result 6): the metric
// `loadbalancing.googleapis.com/https/request_count`, labelled by `url_map_name` and `backend_target_name` (the
// backend service). The counts are estimates, and the first point comes 72 to 125 s after the requests.
//
// By the load balancer's kind (M5, the coverage design's section 7): classic has the global one's metric and form; regional has
// a metric of its own, `backend_target_name` still the service's plain name, and the region in the filter, as a regional
// service's name is unique only there. A filter that matches nothing reads 0 and naps a busy workload.
const MONITORING = 'https://monitoring.googleapis.com/v3';
const METRIC = 'loadbalancing.googleapis.com/https/request_count';
const REGIONAL_METRIC = 'loadbalancing.googleapis.com/https/external/regional/request_count';

export const CALLS = {
  requestCount: ['monitoring.timeSeries.list'],
};

function filterOf(backendService, lb) {
  if (lb?.kind !== 'regional') return `metric.type = "${METRIC}" AND resource.labels.backend_target_name = "${backendService}"`;
  return `metric.type = "${REGIONAL_METRIC}" AND resource.labels.backend_target_name = "${backendService}" AND resource.labels.region = "${lb.region}"`;
}

export function createMonitoring({ google, project }) {
  // The requests the backend service's series count over [from, to] (ms), through any URL map: the sum of its points. `lb`:
  // the workload's load balancer, absent for a global one.
  async function requestCount({ backendService, lb, from, to }) {
    const filter = filterOf(backendService, lb);
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
