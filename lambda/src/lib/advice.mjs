// Recommendations shown on the admin dashboard: configurations that make naps or wakes slower or more expensive.

function warmPoolAdvice(group) {
  const pool = group.warmPool;
  if (!pool) {
    return 'add a warm pool in Stopped state with reuse on scale-in: a nap keeps the instances stopped in the pool and a '
      + 'wake restarts them instead of launching new ones (the application must start at boot: user data runs at the first '
      + 'boot only)';
  }
  if (pool.state === 'Running') return 'the warm pool keeps running instances, paid while the workload naps: use Stopped (or Hibernated)';
  if (!pool.reuseOnScaleIn) return 'naps terminate the instances instead of returning them to the warm pool: enable reuse on scale-in';
  return null;
}

// [{ backend, message }] for the managed backends.
export function recommendations(backends) {
  const out = [];
  for (const backend of backends) {
    if (backend.kind !== 'asg') continue;
    const message = warmPoolAdvice(backend);
    if (message) out.push({ backend: backend.name, message });
  }
  return out;
}
