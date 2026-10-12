// Workload names (vision onboarding design, section 7): for people only, never in a resource name, tag, key or URL.
// Trimmed, at most 64 characters, no control characters; duplicates are accepted.
export const NAME_MAX = 64;

// { name, problem }: the trimmed name ('' when absent) and why it is refused, or null.
export function checkName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (name.length > NAME_MAX) return { name, problem: `name: at most ${NAME_MAX} characters` };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return { name, problem: 'name: no control characters' };
  return { name, problem: null };
}
