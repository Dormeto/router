// Configurable no-wake rules: requests answered with the waiter page without waking the workload. A rule matches when
// all its present conditions match. Router defaults come from the waker environment, workload rules from the config.
import { BlockList, isIP } from 'node:net';
import { clientIp, header, headerValues } from './http.mjs';

const CONDITIONS = ['sourceIps', 'pathPrefixes', 'pathPattern', 'userAgentPattern', 'headers'];

const present = (value) => value !== null && value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0);

// Only the conditions that are set: Terraform sends every attribute, unset ones as null or [].
const setFields = (object) => Object.fromEntries(Object.entries(object ?? {}).filter(([, v]) => present(v)));
export const conditionsOf = (rule) => Object.fromEntries(CONDITIONS.filter((k) => present(rule?.[k]))
  .map((k) => [k, k === 'headers' ? rule.headers.map(setFields) : rule[k]]));

function blockList(entries) {
  const list = new BlockList();
  for (const entry of entries) {
    const [address, bits] = String(entry).split('/');
    const family = isIP(address);
    if (!family) throw new Error(`sourceIps: invalid address ${entry}`);
    const type = family === 6 ? 'ipv6' : 'ipv4';
    if (bits === undefined) {
      list.addAddress(address, type);
      continue;
    }
    const prefix = Number(bits);
    if (!/^\d+$/.test(bits) || prefix > (family === 6 ? 128 : 32)) throw new Error(`sourceIps: invalid range ${entry}`);
    list.addSubnet(address, prefix, type);
  }
  return list;
}

function regex(name, source, flags = '') {
  try {
    return new RegExp(source, flags);
  } catch (err) {
    throw new Error(`${name}: ${err.message}`);
  }
}

// One predicate per condition; throws on an invalid rule.
function compileRule(rule) {
  const conditions = conditionsOf(rule);
  if (!Object.keys(conditions).length) throw new Error('no condition');
  const tests = [];
  if (conditions.sourceIps) {
    const list = blockList(conditions.sourceIps);
    tests.push((event) => {
      const ip = clientIp(event);
      const family = isIP(ip);
      return family > 0 && list.check(ip, family === 6 ? 'ipv6' : 'ipv4');
    });
  }
  if (conditions.pathPrefixes) tests.push((event) => conditions.pathPrefixes.some((p) => (event.path ?? '').startsWith(p)));
  if (conditions.pathPattern) {
    const pattern = regex('pathPattern', conditions.pathPattern);
    tests.push((event) => pattern.test(event.path ?? ''));
  }
  if (conditions.userAgentPattern) {
    const pattern = regex('userAgentPattern', conditions.userAgentPattern, 'i');
    tests.push((event) => pattern.test(header(event, 'user-agent') ?? ''));
  }
  for (const h of conditions.headers ?? []) {
    if (!h?.name || present(h.value) === present(h.pattern)) throw new Error('headers: each header needs a name and either value or pattern');
    const pattern = present(h.pattern) ? regex(`headers ${h.name}`, h.pattern) : null;
    tests.push((event) => headerValues(event, h.name).some((v) => (pattern ? pattern.test(v) : v === h.value)));
  }
  return (event) => tests.every((t) => t(event));
}

// Valid rules as { name, level, matches(event) }; invalid ones are reported and skipped (more wakes, never fewer).
export function compileRules(rules, { level = 'workload', onInvalid = () => {} } = {}) {
  const compiled = [];
  for (const rule of rules ?? []) {
    try {
      compiled.push({ name: rule.name, level, matches: compileRule(rule) });
    } catch (err) {
      onInvalid(rule, err.message);
    }
  }
  return compiled;
}

// For the dashboard: [{ level, rules }] → [{ name, level, conditions, invalid? }].
export function describeRules(groups) {
  return groups.flatMap(({ level, rules }) => (rules ?? []).map((rule) => {
    const described = { name: rule.name, level, conditions: conditionsOf(rule) };
    try {
      compileRule(rule);
    } catch (err) {
      described.invalid = err.message;
    }
    return described;
  }));
}

// Router defaults from the waker environment (JSON list); unreadable JSON means no defaults.
export function parseRules(text, onError = () => {}) {
  if (!text) return [];
  try {
    const rules = JSON.parse(text);
    if (Array.isArray(rules)) return rules;
    onError('not a JSON list');
  } catch (err) {
    onError(err.message);
  }
  return [];
}
