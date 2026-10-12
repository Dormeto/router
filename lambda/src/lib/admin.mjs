import { createHash, timingSafeEqual } from 'node:crypto';
import { createStatus, napEstimate } from './status.mjs';
import { response } from './http.mjs';
import { renderDashboard } from './dashboard-page.mjs';

export const ADMIN_PREFIX = '/_dormeto/';
const ACTIONS = new Set(['nap', 'wake']);
const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
};

export { napEstimate };

export const hashSecret = (secret) => createHash('sha256').update(secret).digest('hex');

export function parseAdminPath(path, cfg) {
  if (!cfg.admin?.enabled || !cfg.admin.secretHash || !path?.startsWith(ADMIN_PREFIX)) return null;
  const rest = path.slice(ADMIN_PREFIX.length);
  const slash = rest.indexOf('/');
  const secret = slash === -1 ? rest : rest.slice(0, slash);
  if (!secret) return null;
  const actual = Buffer.from(hashSecret(secret), 'hex');
  const expected = Buffer.from(cfg.admin.secretHash, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  return { base: `${ADMIN_PREFIX}${secret}`, route: slash === -1 ? '' : rest.slice(slash + 1) };
}

export function createAdmin({ ec2, elbv2, cloudwatch, autoscaling, ecs, tagging, appscaling, rds, kubernetesOf, invokeController, now = Date.now, log, version = {} }) {
  const status = createStatus({ ec2, elbv2, cloudwatch, autoscaling, ecs, tagging, appscaling, rds, kubernetesOf, now, version });
  const notAllowed = (allow) => response(405, { ...SECURITY_HEADERS, allow, 'content-type': 'text/plain' }, 'Method not allowed');

  return async function handle({ event, workloadId, cfg, run, base, route, forceWake, noWakeRules, wakeRules, loadStats, loadLists }) {
    const method = event.httpMethod;
    const read = method === 'GET' || method === 'HEAD';
    if (route === '') {
      if (!read) return notAllowed('GET, HEAD');
      if (method === 'HEAD') return response(200, { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8' });
      const action = event.multiValueQueryStringParameters?.action?.[0];
      const body = renderDashboard({ status: await status(workloadId, cfg, run, { noWakeRules, wakeRules, loadStats, loadLists }), base, action: ACTIONS.has(action) ? action : undefined });
      return response(200, { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8' }, body);
    }
    if (route === 'status.json') {
      if (!read) return notAllowed('GET, HEAD');
      if (method === 'HEAD') return response(200, { ...SECURITY_HEADERS, 'content-type': 'application/json' });
      return response(200, { ...SECURITY_HEADERS, 'content-type': 'application/json' }, JSON.stringify(await status(workloadId, cfg, run, { noWakeRules, wakeRules, loadStats, loadLists })));
    }
    if (ACTIONS.has(route)) {
      if (method !== 'POST') return notAllowed('POST');
      if (route === 'nap') await invokeController({ action: 'nap', workloadId });
      else await forceWake(run);
      log.info('AdminAction', { workloadId, action: route });
      return response(303, { ...SECURITY_HEADERS, location: `${base}/?action=${route}` });
    }
    return response(404, { ...SECURITY_HEADERS, 'content-type': 'text/plain' }, 'Not found');
  };
}
