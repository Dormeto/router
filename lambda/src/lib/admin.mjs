import { createHash, timingSafeEqual } from 'node:crypto';
import { STATES } from './state.mjs';
import { currentTarget } from './route.mjs';
import { instanceStates } from './instances.mjs';
import { backendKey, backendStatuses, resolveBackends } from './backends.mjs';
import { lastRequestAt } from './metrics.mjs';
import { response } from './http.mjs';
import { renderDashboard } from './dashboard-page.mjs';

export const ADMIN_PREFIX = '/_dormeto/';
const CHECK_PERIOD_MS = 5 * 60_000;
const ACTIONS = new Set(['nap', 'wake']);
const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
};

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

export function napEstimate({ cfg, run, lastRequest, now }) {
  if (run.state !== STATES.AWAKE) return null;
  const eligibleAt = Math.max(run.awakeSince ?? 0, lastRequest ?? 0) + cfg.idleMinutes * 60_000;
  return { eligibleAt, latestAt: eligibleAt + CHECK_PERIOD_MS, inSeconds: Math.max(0, Math.ceil((eligibleAt - now) / 1000)) };
}

const iso = (ms) => (typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : null);

export function createAdmin({ ec2, elbv2, cloudwatch, autoscaling, invokeController, now = Date.now, log }) {
  const clients = { ec2, elbv2, autoscaling };
  async function status(workloadId, cfg, run) {
    const t = now();
    const resolved = await resolveBackends(clients, cfg);
    const instanceIds = resolved.backends.filter((b) => b.kind === 'instance').map((b) => b.id);
    const [statuses, instances, health, rules, lastRequest] = await Promise.all([
      resolved.backends.length ? backendStatuses(clients, resolved.backends) : {},
      instanceIds.length ? instanceStates(ec2, instanceIds) : {},
      elbv2.describeTargetHealth({ TargetGroupArn: cfg.appTargetGroupArn }),
      elbv2.describeRules({ RuleArns: [cfg.ruleArn] }),
      lastRequestAt(cloudwatch, cfg, t - cfg.idleMinutes * 60_000, t),
    ]);
    const nap = napEstimate({ cfg, run, lastRequest, now: t });
    return {
      workloadId,
      state: run.state,
      updatedAt: iso(run.updatedAt),
      awakeSince: iso(run.awakeSince),
      wakeStartedAt: iso(run.wakeStartedAt),
      failedAt: iso(run.failedAt),
      wakeCount: run.wakeCount ?? 0,
      holders: run.holders ?? 0,
      pendingWake: run.pendingWake === true,
      lastRequestAt: iso(lastRequest),
      nap: nap && { eligibleAt: iso(nap.eligibleAt), latestAt: iso(nap.latestAt), inSeconds: nap.inSeconds },
      route: currentTarget(rules.Rules?.[0]?.Actions ?? [], cfg),
      discovery: resolved.mode,
      instances: instanceIds.map((id) => ({ id, state: instances[id] ?? 'unknown' })),
      backends: resolved.backends.map((b) => (b.kind === 'asg'
        ? { kind: 'asg', id: b.name, status: statuses[backendKey(b)], min: b.min, max: b.max, desired: b.desired, warmPool: b.warmPool }
        : { kind: 'instance', id: b.id, status: statuses[backendKey(b)] })),
      ignoredTargets: resolved.ignored,
      targets: (health.TargetHealthDescriptions ?? []).map((d) => ({ id: d.Target?.Id, state: d.TargetHealth?.State })),
      settings: {
        waitSeconds: cfg.waitSeconds,
        idleMinutes: cfg.idleMinutes,
        drainSeconds: cfg.drainSeconds,
        wakeTimeoutSeconds: cfg.wakeTimeoutSeconds,
        maxHolders: cfg.maxHolders,
      },
    };
  }

  const notAllowed = (allow) => response(405, { ...SECURITY_HEADERS, allow, 'content-type': 'text/plain' }, 'Method not allowed');

  return async function handle({ event, workloadId, cfg, run, base, route, forceWake }) {
    const method = event.httpMethod;
    const read = method === 'GET' || method === 'HEAD';
    if (route === '') {
      if (!read) return notAllowed('GET, HEAD');
      if (method === 'HEAD') return response(200, { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8' });
      const action = event.multiValueQueryStringParameters?.action?.[0];
      const body = renderDashboard({ status: await status(workloadId, cfg, run), base, action: ACTIONS.has(action) ? action : undefined });
      return response(200, { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8' }, body);
    }
    if (route === 'status.json') {
      if (!read) return notAllowed('GET, HEAD');
      if (method === 'HEAD') return response(200, { ...SECURITY_HEADERS, 'content-type': 'application/json' });
      return response(200, { ...SECURITY_HEADERS, 'content-type': 'application/json' }, JSON.stringify(await status(workloadId, cfg, run)));
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
