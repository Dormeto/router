// Cloud Monitoring: the load balancer's request count (G0, spec section 12 result 6): the metric
// `loadbalancing.googleapis.com/https/request_count`, labelled by `url_map_name` and `backend_target_name` (the
// backend service). The counts are estimates, and the first point comes 72 to 125 s after the requests.
//
// By the load balancer's kind (M5, the coverage design's section 7): classic has the global one's metric and form; regional has
// a metric of its own, `backend_target_name` still the service's plain name, and the region in the filter, as a regional
// service's name is unique only there. A filter that matches nothing reads 0 and naps a busy workload. Both internal kinds count in
// `https/internal/request_count` (vision docs/specs/2026-11-08-google-cloud-router-features-design.md, section 7), with the regional
// one's labels: the regional one in its region; the cross-region one without, as its service is global and its points' region is
// where the proxy ran (to measure, M3): a filter on the router's region would miss the requests of other regions' clients.
import { aKind } from './switch.mjs';

const MONITORING = 'https://monitoring.googleapis.com/v3';
// By kind: the metric, and whether the region names the service too. A kind not named here (classic), or none, counts as the global one.
const METRICS = {
  global: { metric: 'loadbalancing.googleapis.com/https/request_count', inRegion: false },
  regional: { metric: 'loadbalancing.googleapis.com/https/external/regional/request_count', inRegion: true },
  internal: { metric: 'loadbalancing.googleapis.com/https/internal/request_count', inRegion: true },
  'cross-region-internal': { metric: 'loadbalancing.googleapis.com/https/internal/request_count', inRegion: false },
};

export const CALLS = {
  requestCount: ['monitoring.timeSeries.list'],
};

function filterOf(backendService, lb) {
  const { metric, inRegion } = METRICS[Object.hasOwn(METRICS, lb?.kind) ? lb.kind : 'global'];
  const filter = `metric.type = "${metric}" AND resource.labels.backend_target_name = "${backendService}"`;
  if (!inRegion) return filter;
  if (!lb.region) throw new Error(`backend service ${backendService}: ${aKind(lb.kind)} load balancer with no region reads no request count`);
  return `${filter} AND resource.labels.region = "${lb.region}"`;
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
