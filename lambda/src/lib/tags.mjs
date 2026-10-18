// Workload tags (tags design, section 3): Dormeto's own labels, key and value, never AWS tags. The same rules as the
// workload module's validations and the manager's API: at most 50, a key of 1 to 128 characters, a value of at most
// 256, in the characters AWS allows; keys are case-sensitive; the prefix `dormeto:` is reserved, in any case.
export const TAGS_MAX = 50;
export const KEY_MAX = 128;
export const VALUE_MAX = 256;
const ALLOWED = /^[\p{L}\p{Z}\p{N}_.:/=+\-@]*$/u;

// Lengths count characters (code points), as Terraform's length() does, not UTF-16 units.
const length = (s) => [...s].length;

// Why the tags are refused (naming the tag), or null.
export function tagsProblem(tags) {
  if (!tags || typeof tags !== 'object' || Array.isArray(tags)) return 'tags: an object of key and value strings';
  const entries = Object.entries(tags);
  if (entries.length > TAGS_MAX) return `tags: at most ${TAGS_MAX}`;
  for (const [key, value] of entries) {
    if (length(key) < 1 || length(key) > KEY_MAX) return `tag "${key}": key of 1 to ${KEY_MAX} characters`;
    if (typeof value !== 'string') return `tag "${key}": value must be a string`;
    if (length(value) > VALUE_MAX) return `tag "${key}": value of at most ${VALUE_MAX} characters`;
    if (!ALLOWED.test(key)) return `tag "${key}": key characters: letters, digits, spaces and _ . : / = + - @`;
    if (!ALLOWED.test(value)) return `tag "${key}": value characters: letters, digits, spaces and _ . : / = + - @`;
    if (key.toLowerCase().startsWith('dormeto:')) return `tag "${key}": the dormeto: prefix is reserved`;
  }
  return null;
}
