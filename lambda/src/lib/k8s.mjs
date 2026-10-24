// The Kubernetes API of an EKS cluster, without a Kubernetes library (vision docs/specs/2026-10-11-kubernetes-design.md,
// decision 6): plain HTTPS trusting the cluster's certificate authority, with an EKS token signed here by hand (lib
// modules take credentials as arguments and never import the AWS SDK); a private cluster through its proxy function in
// its VPC, with the same token (vision docs/specs/2026-10-24-private-eks-endpoints-design.md). Shared with the manager's
// discovery.
import { createHash, createHmac } from 'node:crypto';
import { STATUS_CODES } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { PROTOCOL } from './kube-proxy-core.mjs';
import { kubeProxyName } from './kube-proxy-name.mjs';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
// RFC 3986, as SigV4 wants: every byte but the unreserved characters (encodeURIComponent keeps !'()* too).
const encode = (value) => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const byKey = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);

// A SigV4 presigned URL (query string authentication). The URL keeps botocore's order (the query, then the
// authentication parameters); the signature covers them sorted, as SigV4 says.
export function presignUrl({ method = 'GET', host, path = '/', query = {}, headers = {}, region, service, credentials, now, expires, payloadHash = sha256('') }) {
  const amzDate = new Date(now).toISOString().replace(/[-:]|\.\d{3}/g, '');
  const scope = `${amzDate.slice(0, 8)}/${region}/${service}/aws4_request`;
  const signed = { host, ...Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value).trim()])) };
  const names = Object.keys(signed).sort();
  const params = Object.entries({
    ...query,
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${credentials.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': names.join(';'),
    ...(credentials.sessionToken ? { 'X-Amz-Security-Token': credentials.sessionToken } : {}),
  }).map(([name, value]) => [encode(name), encode(value)]);
  const canonicalQuery = [...params].sort(byKey).map(([name, value]) => `${name}=${value}`).join('&');
  const canonical = [method, path, canonicalQuery, names.map((name) => `${name}:${signed[name]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = [amzDate.slice(0, 8), region, service, 'aws4_request'].reduce(hmac, `AWS4${credentials.secretAccessKey}`);
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return `https://${host}${path}?${params.map(([name, value]) => `${name}=${value}`).join('&')}&X-Amz-Signature=${signature}`;
}

// The bearer token EKS accepts (what `aws eks get-token` prints): an STS GetCallerIdentity URL presigned for 60 seconds
// with the cluster's name signed; EKS takes it for 15 minutes from its date.
export function eksToken({ cluster, region, credentials, now = Date.now() }) {
  const url = presignUrl({
    host: `sts.${region}.amazonaws.com`, query: { Action: 'GetCallerIdentity', Version: '2011-06-15' },
    headers: { 'x-k8s-aws-id': cluster }, region, service: 'sts', credentials, now, expires: 60,
  });
  return `k8s-aws-v1.${Buffer.from(url).toString('base64url')}`;
}

// The AWS calls' bounds (aws/bounded.mjs): connected (TLS included) within 3 seconds, failed after 10 seconds of silence.
export const TIMEOUTS = { connect: 3_000, idle: 10_000 };

// status: the HTTP status, 0 when no answer came; reason: the API's (Forbidden, NotFound, Conflict…), the HTTP status's
// text, Timeout, or the network error's code.
export class KubernetesError extends Error {
  constructor(status, reason, message) {
    super(message);
    this.name = 'KubernetesError';
    this.status = status;
    this.reason = reason;
  }
}

const PATCH_TYPES = { merge: 'application/merge-patch+json', strategic: 'application/strategic-merge-patch+json', json: 'application/json-patch+json' };
// The managedFields entry of Dormeto's writes: what a GitOps tool shows as Dormeto's change.
const FIELD_MANAGER = 'dormeto';

const parse = (text) => {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
};

// The path of a request, without its query: what error messages name (never the query, which may hold selectors).
const pathOf = (path) => new URL(path, 'https://kubernetes.invalid').pathname;

// A Transport carries one request { method, path, query, headers, body? } (body: text) to the cluster and resolves its
// answer { status, contentType?, body } (body: text), or rejects with a KubernetesError of status 0 when no answer came.
// The direct one: HTTPS to the cluster's endpoint, trusting its certificate authority.
function httpsTransport({ endpoint, ca, cert, key, request, timeouts }) {
  return ({ method, path, query, headers, body }) => new Promise((resolve, reject) => {
    const url = new URL(path, endpoint);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    const where = `${method} ${url.pathname}`;
    const req = request(url, {
      method, ca, cert, key, timeout: timeouts.idle,
      headers: { ...headers, ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(body) }) },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', (err) => req.destroy(err));
      res.on('end', () => resolve({ status: res.statusCode, contentType: res.headers['content-type'], body: Buffer.concat(chunks).toString() }));
    });
    req.on('socket', (socket) => {
      if (socket.authorized) return; // a kept-alive connection, already verified
      const timer = setTimeout(() => req.destroy(new KubernetesError(0, 'Timeout', `${where}: no connection within ${timeouts.connect} ms`)), timeouts.connect);
      socket.once('secureConnect', () => clearTimeout(timer));
      socket.once('close', () => clearTimeout(timer));
    });
    req.on('timeout', () => req.destroy(new KubernetesError(0, 'Timeout', `${where}: no answer for ${timeouts.idle} ms`)));
    req.on('error', (err) => reject(err instanceof KubernetesError ? err : new KubernetesError(0, err.code ?? 'Network', `${where}: ${err.message}`)));
    req.end(body);
  });
}

// Through a proxy, lists are read in pages of 100 objects: a synchronous function's answer is at most 6 MB.
const PROXY_PAGE = '100';

// endpoint and ca (PEM) from clusterOf; token (EKS) or cert and key (a client certificate, kind); impersonate { user,
// groups } (the kind tests act as the dormeto:router group); transport: another way to the cluster than HTTPS from here
// (proxyTransport), whose answers are read as the direct ones.
export function createKubernetes({ endpoint, ca, token, cert, key, impersonate, request = httpsRequest, timeouts = TIMEOUTS, transport }) {
  const headers = {
    accept: 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(impersonate?.user ? { 'impersonate-user': impersonate.user } : {}),
    ...(impersonate?.groups?.length ? { 'impersonate-group': impersonate.groups } : {}),
  };
  const send = transport ?? httpsTransport({ endpoint, ca, cert, key, request, timeouts });

  const call = async (method, path, { query = {}, body, type = 'application/json' } = {}) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const answer = await send({
      method, path, query,
      headers: { ...headers, ...(payload === undefined ? {} : { 'content-type': type }) },
      ...(payload === undefined ? {} : { body: payload }),
    });
    const text = answer.body ?? '';
    const value = parse(text);
    if (answer.status >= 200 && answer.status < 300) return value;
    const where = `${method} ${pathOf(path)}`;
    const reason = STATUS_CODES[answer.status] ?? 'Unknown';
    throw value?.kind === 'Status'
      ? new KubernetesError(answer.status, value.reason || reason, value.message || `${where}: ${answer.status}`)
      : new KubernetesError(answer.status, reason, `${where}: ${answer.status} ${text.slice(0, 300)}`);
  };

  return {
    get: (path) => call('GET', path),
    // Every item, following the API's continue tokens.
    async list(path, query = {}) {
      const items = [];
      const paged = send.paged ? { ...query, limit: PROXY_PAGE } : query;
      let next;
      do {
        const page = await call('GET', path, { query: next ? { ...paged, continue: next } : paged });
        items.push(...(page?.items ?? []));
        next = page?.metadata?.continue;
      } while (next);
      return items;
    },
    patch: (path, body, type = 'merge') => (PATCH_TYPES[type]
      ? call('PATCH', path, { query: { fieldManager: FIELD_MANAGER }, body, type: PATCH_TYPES[type] })
      : Promise.reject(new Error(`unknown patch type ${type}`))),
    create: (path, body) => call('POST', path, { query: { fieldManager: FIELD_MANAGER }, body }),
    remove: (path) => call('DELETE', path),
    // What the caller may do in the namespace (the spec's section 4 check): RBAC's rules only, incomplete otherwise.
    rulesReview: async (namespace) => (await call('POST', '/apis/authorization.k8s.io/v1/selfsubjectrulesreviews', {
      body: { apiVersion: 'authorization.k8s.io/v1', kind: 'SelfSubjectRulesReview', spec: { namespace } },
    }))?.status,
    // Whether the caller may do one thing ({ namespace?, verb, group, resource, subresource? }), whatever authorizer
    // grants it (EKS access policies included).
    accessReview: async (resourceAttributes) => (await call('POST', '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews', {
      body: { apiVersion: 'authorization.k8s.io/v1', kind: 'SelfSubjectAccessReview', spec: { resourceAttributes } },
    }))?.status?.allowed === true,
  };
}

// A private cluster's proxy function (vision docs/specs/2026-10-24-private-eks-endpoints-design.md, sections 3, 8 and 9):
// the call travels in a synchronous invocation, with the caller's own token; what the proxy could not do, and what the
// invocation could not, become KubernetesErrors of status 0. invoke(functionName, payload) resolves the function's answer.
const FORWARDED = ['authorization', 'accept', 'content-type'];

const noProxy = (name) => `the cluster's endpoint is private and its proxy ${name ? `${name} ` : ''}is not set up: upgrade the router or set up its cluster access (Terraform: module kubernetes-proxy)`;
const INVOKE_FAILURES = {
  ResourceNotFoundException: ['NoProxy', noProxy],
  // Lambda deactivates a VPC function unused for 14 days; its next invocations fail while its interfaces come back.
  ResourceNotReadyException: ['ProxyNotReady', (name) => `the proxy ${name} is becoming active again (unused for 14 days): retry in a minute`],
  // After the SDK's retries.
  TooManyRequestsException: ['Throttled', (name) => `the proxy ${name} was throttled (the account's Lambda concurrency)`],
};

// version: the caller's router version, which the message of a proxy older than its caller names.
async function invokeProxy({ invoke, functionName, version }, payload, where) {
  let answer;
  try {
    answer = await invoke(functionName, payload);
  } catch (err) {
    const [reason, message] = INVOKE_FAILURES[err?.name] ?? [];
    if (reason) throw new KubernetesError(0, reason, message(functionName));
    throw new KubernetesError(0, err?.name && err.name !== 'Error' ? err.name : 'ProxyFailed',
      `${where}: the proxy ${functionName} failed: ${String(err?.message ?? err).slice(0, 300)}`);
  }
  if (answer === null || typeof answer !== 'object') throw new KubernetesError(0, 'ProxyFailed', `${where}: the proxy ${functionName} gave no answer`);
  if (answer.status === 0) {
    if (answer.reason === 'Refused' && String(answer.message ?? '').startsWith('unknown protocol')) {
      const router = version ? `router ${version}` : 'this router';
      throw new KubernetesError(0, 'Refused', `the proxy ${functionName} is older than ${router}: apply the module kubernetes-proxy of ${router}`);
    }
    throw new KubernetesError(0, answer.reason ?? 'ProxyFailed', answer.message ?? `${where}: ${answer.reason ?? 'failed'}`);
  }
  return answer;
}

// The Transport through a cluster's proxy (functionName), to the endpoint the caller read from EKS (the proxy refuses
// any other: Stale). Lists through it are paged.
export function proxyTransport({ invoke, functionName, endpoint, version }) {
  const transport = async ({ method, path, query = {}, headers = {}, body }) => {
    const answer = await invokeProxy({ invoke, functionName, version }, {
      v: PROTOCOL, endpoint, method, path, query,
      headers: Object.fromEntries(Object.entries(headers).filter(([name]) => FORWARDED.includes(name))),
      ...(body === undefined ? {} : { body }),
    }, `${method} ${pathOf(path)}`);
    if (typeof answer.status !== 'number') throw new KubernetesError(0, 'ProxyFailed', `${method} ${pathOf(path)}: the proxy ${functionName} gave no status`);
    return { status: answer.status, contentType: answer.contentType, body: typeof answer.body === 'string' ? answer.body : '' };
  };
  transport.paged = true;
  return transport;
}

// A proxy's version and cluster, without any connection to the cluster: the router's check keeps the function active with
// it (Lambda deactivates a VPC function unused for 14 days) and reports the proxy's version.
// endpoint: the one the caller read from EKS, which the proxy compares with its own (Stale); probe: it also opens a
// verified TLS connection to it (Timeout, Network or TLS), the check's use; without, no connection is made.
export async function pingProxy(invoke, functionName, { version, endpoint, probe } = {}) {
  const answer = await invokeProxy({ invoke, functionName, version }, {
    v: PROTOCOL, ping: true, ...(endpoint === undefined ? {} : { endpoint }), ...(probe === true ? { probe: true } : {}),
  }, 'ping');
  return { version: answer.version, cluster: answer.cluster };
}

// How a cluster's API is reached (vision docs/specs/2026-10-24-private-eks-endpoints-design.md, section 2), from its
// resourcesVpcConfig: a public endpoint open to every address directly (even with private access on: nothing changes for
// the clusters onboarded before the proxies), else through its proxy function in its VPC when private access is on, else
// not at all (our functions leave from AWS's shared addresses, which no allowlist can name).
export function reachOf(vpc = {}) {
  if (vpc.endpointPublicAccess === true && (vpc.publicAccessCidrs ?? []).includes('0.0.0.0/0')) return 'direct';
  return vpc.endpointPrivateAccess === true ? 'proxy' : 'none';
}

// Why a cluster is not reached at all (reachOf = none), and what to do: the spec's section 8, word for word.
export const UNREACHABLE = "the cluster's public endpoint is limited to some addresses and its private access is off: turn on private access, and Dormeto reaches it from inside its VPC";

// A cluster's endpoint, certificate authority, reach and authentication mode, read once per 15 minutes by each EKS client
// (a warm Lambda container keeps it); a failure is not kept.
export const CLUSTER_TTL_MS = 15 * 60_000;
const clusters = new WeakMap();

const viewOf = (cluster) => {
  const vpc = cluster.resourcesVpcConfig ?? {};
  return {
    endpoint: cluster.endpoint,
    ca: Buffer.from(cluster.certificateAuthority?.data ?? '', 'base64').toString(),
    publicAccess: vpc.endpointPublicAccess === true,
    publicCidrs: vpc.publicAccessCidrs ?? [],
    privateOnly: vpc.endpointPublicAccess !== true,
    privateAccess: vpc.endpointPrivateAccess === true,
    // A cluster without accessConfig predates access entries: aws-auth only.
    authMode: cluster.accessConfig?.authenticationMode ?? 'CONFIG_MAP',
    version: cluster.version,
  };
};

export function clusterOf(eks, name, now = Date.now()) {
  if (!clusters.has(eks)) clusters.set(eks, new Map());
  const byName = clusters.get(eks);
  const kept = byName.get(name);
  if (kept && now - kept.at < CLUSTER_TTL_MS) return kept.pending;
  const entry = { at: now, pending: eks.describeCluster({ name }).then(({ cluster }) => viewOf(cluster)) };
  byName.set(name, entry);
  entry.pending.catch(() => {
    if (byName.get(name) === entry) byName.delete(name);
  });
  return entry.pending;
}

// kubernetesOf(cluster): the client of a cluster by name, with a token signed now with the caller's credentials (eks:
// describeCluster and credentials(), aws/eks.mjs). EKS takes the token for 15 minutes: a client serves one operation.
// The client says how it reaches the cluster (via: direct or proxy, and the proxy's name), chosen from the cluster's view:
// a cluster whose endpoint access changes moves to the other way when its view is read again (CLUSTER_TTL_MS).
// lambda (invoke, aws/lambda.mjs) and proxyPrefix (the router's DMT_KUBE_PROXY_PREFIX, <name>-kube-) reach the proxies;
// without them a private cluster is NoProxy. version: the caller's router version, named when a proxy is older.
export function kubernetesConnector({ eks, region, now = Date.now, lambda, proxyPrefix, version }) {
  return async (cluster) => {
    const [view, credentials] = await Promise.all([clusterOf(eks, cluster, now()), eks.credentials()]);
    const reach = reachOf({ endpointPublicAccess: view.publicAccess, publicAccessCidrs: view.publicCidrs, endpointPrivateAccess: view.privateAccess });
    if (reach === 'none') throw new KubernetesError(0, 'Unreachable', UNREACHABLE);
    const token = eksToken({ cluster, region, credentials, now: now() });
    if (reach === 'direct') return Object.assign(createKubernetes({ endpoint: view.endpoint, ca: view.ca, token }), { via: 'direct' });
    const proxy = proxyPrefix ? kubeProxyName(proxyPrefix, cluster) : undefined;
    if (!proxy || !lambda) throw new KubernetesError(0, 'NoProxy', noProxy(proxy));
    const transport = proxyTransport({ invoke: (functionName, payload) => lambda.invoke(functionName, payload), functionName: proxy, endpoint: view.endpoint, version });
    return Object.assign(createKubernetes({ endpoint: view.endpoint, token, transport }), { via: 'proxy', proxy, endpoint: view.endpoint });
  };
}
