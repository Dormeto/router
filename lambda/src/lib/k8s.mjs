// The Kubernetes API of an EKS cluster, without a Kubernetes library (vision docs/specs/2026-10-11-kubernetes-design.md,
// decision 6): plain HTTPS trusting the cluster's certificate authority, with an EKS token signed here by hand (lib
// modules take credentials as arguments and never import the AWS SDK). Shared with the manager's discovery.
import { createHash, createHmac } from 'node:crypto';
import { STATUS_CODES } from 'node:http';
import { request as httpsRequest } from 'node:https';

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

// endpoint and ca (PEM) from clusterOf; token (EKS) or cert and key (a client certificate, kind); impersonate { user,
// groups } (the kind tests act as the dormeto:router group).
export function createKubernetes({ endpoint, ca, token, cert, key, impersonate, request = httpsRequest, timeouts = TIMEOUTS }) {
  const headers = {
    accept: 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(impersonate?.user ? { 'impersonate-user': impersonate.user } : {}),
    ...(impersonate?.groups?.length ? { 'impersonate-group': impersonate.groups } : {}),
  };

  const call = (method, path, { query = {}, body, type = 'application/json' } = {}) => new Promise((resolve, reject) => {
    const url = new URL(path, endpoint);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const where = `${method} ${url.pathname}`;
    const req = request(url, {
      method, ca, cert, key, timeout: timeouts.idle,
      headers: { ...headers, ...(payload === undefined ? {} : { 'content-type': type, 'content-length': Buffer.byteLength(payload) }) },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', (err) => req.destroy(err));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        const value = parse(text);
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(value);
        const reason = STATUS_CODES[res.statusCode] ?? 'Unknown';
        reject(value?.kind === 'Status'
          ? new KubernetesError(res.statusCode, value.reason || reason, value.message || `${where}: ${res.statusCode}`)
          : new KubernetesError(res.statusCode, reason, `${where}: ${res.statusCode} ${text.slice(0, 300)}`));
      });
    });
    req.on('socket', (socket) => {
      if (socket.authorized) return; // a kept-alive connection, already verified
      const timer = setTimeout(() => req.destroy(new KubernetesError(0, 'Timeout', `${where}: no connection within ${timeouts.connect} ms`)), timeouts.connect);
      socket.once('secureConnect', () => clearTimeout(timer));
      socket.once('close', () => clearTimeout(timer));
    });
    req.on('timeout', () => req.destroy(new KubernetesError(0, 'Timeout', `${where}: no answer for ${timeouts.idle} ms`)));
    req.on('error', (err) => reject(err instanceof KubernetesError ? err : new KubernetesError(0, err.code ?? 'Network', `${where}: ${err.message}`)));
    req.end(payload);
  });

  return {
    get: (path) => call('GET', path),
    // Every item, following the API's continue tokens.
    async list(path, query = {}) {
      const items = [];
      let next;
      do {
        const page = await call('GET', path, { query: next ? { ...query, continue: next } : query });
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
    // What the caller may do in the namespace (the spec's section 4 check).
    rulesReview: async (namespace) => (await call('POST', '/apis/authorization.k8s.io/v1/selfsubjectrulesreviews', {
      body: { apiVersion: 'authorization.k8s.io/v1', kind: 'SelfSubjectRulesReview', spec: { namespace } },
    }))?.status,
  };
}

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
