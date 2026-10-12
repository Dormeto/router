// Why a wake failed (vision docs/specs/2026-10-08-failures-notifications-design.md, R7a): a kind the manager, the waiting
// page and the reactions act on, from the AWS error of a start or the text of an Auto Scaling activity or ECS event.
export const KINDS = ['capacity', 'quota', 'permission', 'configuration', 'unhealthy', 'throttled', 'timeout', 'cluster', 'unknown'];
const MESSAGE_MAX = 300;

// Error names first (the SDK's exception name, or its Code): exact or by pattern.
const BY_NAME = [
  [/^Insufficient(Instance|Host|DBInstance|DBCluster|Reserved)?Capacity/i, 'capacity'],
  [/^(Throttling|Throttled|RequestLimitExceeded|TooManyRequests|RateExceeded|SlowDown)/i, 'throttled'],
  [/LimitExceeded$|^(VcpuLimitExceeded|InstanceLimitExceeded|ServiceQuotaExceeded)/i, 'quota'],
  [/^(UnauthorizedOperation|AccessDenied|.*NotAuthorized|AuthFailure|InvalidClientTokenId)/i, 'permission'],
  [/^(InvalidParameter|InvalidLaunchTemplate|Unsupported|IncorrectInstanceState|InvalidDBInstanceState|InvalidDBClusterState|InvalidInstanceID|ValidationError|InvalidRequest|ClientException)/i, 'configuration'],
];

// Texts of Auto Scaling activities, ECS service events and AWS messages without a telling name.
const BY_TEXT = [
  [/\b(vcpu limit|limit of \d+|quota|limitexceeded)\b/i, 'quota'],
  [/sufficient .*capacity|no capacity|capacity is unavailable|insufficient.*capacity|unable to place a task|no container instance met/i, 'capacity'],
  [/not authorized|unauthorized|access denied|accessdenied/i, 'permission'],
  [/launch template|does not exist|not found|invalid|not supported|unsupported|image id/i, 'configuration'],
  [/timeout|timed out|not available yet/i, 'timeout'],
];

// A cluster's API (lib/k8s.mjs): rights refused, throttled, unreachable or failing (cluster: no answer, or a server error),
// else a request the cluster refuses.
function kubernetesKind({ status }) {
  if (status === 401 || status === 403) return 'permission';
  if (status === 429) return 'throttled';
  if (!status || status >= 500) return 'cluster';
  return 'configuration';
}

export function classifyText(text) {
  return BY_TEXT.find(([pattern]) => pattern.test(text ?? ''))?.[1] ?? 'unknown';
}

const cut = (text) => (text.length > MESSAGE_MAX ? text.slice(0, MESSAGE_MAX) : text);

// { kind, message }: an error of the SDK (its name), or one of the router's own (its text).
export function classify(error) {
  const name = error?.name && error.name !== 'Error' ? error.name : (error?.Code ?? error?.code ?? '');
  const message = String(error?.message ?? error ?? '');
  if (error?.kind && KINDS.includes(error.kind)) return { kind: error.kind, message: cut(message) };
  if (error?.name === 'KubernetesError') return { kind: kubernetesKind(error), message: cut(message) };
  const byName = typeof name === 'string' && name ? BY_NAME.find(([pattern]) => pattern.test(name))?.[1] : undefined;
  const kind = byName ?? classifyText(message);
  return { kind, message: cut(kind === 'unknown' && name ? `${name}: ${message}` : message) };
}

// What a transition to FAILED adds (R7a): the failure on the run (until a successful wake), one more consecutive failure,
// and the failure in the state change event, its time ISO as the change's. step: wake or nap; backend: the one that
// failed, when known.
export function failedSpec(error, { step, backend = error?.backend, wakeId, at }) {
  const { kind, message } = classify(error);
  const failure = { kind, step, ...(backend ? { backend } : {}), message, at };
  const event = { ...(wakeId ? { wakeId } : {}), failure: { ...failure, at: new Date(at).toISOString() } };
  return { set: { failure: JSON.stringify(failure) }, increment: ['consecutiveFailures'], event };
}

// An error of the router's own, of a given kind.
export const failureError = (kind, message) => Object.assign(new Error(message), { kind });

// Between failed wakes (R7a): failedRetrySeconds after the first failure, doubled after each next one, at most 30 minutes.
const RETRY_MAX_MS = 30 * 60_000;
export const retryDelayMs = (cfg, run) => Math.min((cfg.failedRetrySeconds ?? 60) * 1000 * 2 ** (Math.max(1, run?.consecutiveFailures ?? 1) - 1), RETRY_MAX_MS);

// When a request may retry a failed wake (ms), or null when the workload has not failed. A failed workload back to
// ASLEEP (released after its idle window, or found stopped at a check) keeps its failure until a successful wake, and
// backs off as well: otherwise a waiting page left open would start it again at once, every time.
export const nextAttemptAt = (cfg, run) => (run?.state === 'FAILED' || (run?.state === 'ASLEEP' && run.failure)
  ? (run.failedAt ?? 0) + retryDelayMs(cfg, run) : null);

// The kind of the run's last failure, or null.
export function failureKind(run) {
  try {
    return run?.failure ? JSON.parse(run.failure).kind ?? null : null;
  } catch {
    return null;
  }
}
