// The router's one image, two Cloud Run services: DMT_ROLE picks the entry point, loaded on its own.
import { createServer } from 'node:http';
import { response } from '../../lambda/src/lib/http.mjs';
import { logger } from '../../lambda/src/lib/log.mjs';

const ROLES = { waker: './waker.mjs', controller: './controller.mjs' };
const SEVERITIES = { info: 'INFO', warn: 'WARNING', error: 'ERROR' };

// Cloud Logging reads a JSON line's `severity`; the shared logger, AWS's too, writes `level`.
export const withSeverity = (log) => Object.fromEntries(Object.entries(SEVERITIES).map(
  ([level, severity]) => [level, (event, fields = {}) => log[level](event, { severity, ...fields })],
));

// handler(request) → the shared `response()`. The request is the `node:http` one: a body the role did not read is dropped.
export function serve(handler, { port, log }) {
  const server = createServer(async (request, res) => {
    let answer;
    try {
      answer = await handler(request);
    } catch (err) {
      log.error('RequestFailed', { method: request.method, path: request.url.split('?')[0], error: err.message });
      answer = response(500, { 'cache-control': 'no-store', 'content-type': 'application/json' }, JSON.stringify({ error: 'internal error', reason: 'see the logs' }));
    }
    request.resume();
    res.writeHead(answer.statusCode, answer.multiValueHeaders);
    res.end(answer.body);
  });
  return server.listen(port);
}

async function main({ DMT_ROLE: role, PORT: port = '8080' } = process.env) {
  const log = withSeverity(logger);
  if (!Object.hasOwn(ROLES, role ?? '')) {
    log.error('UnknownRole', { role, roles: Object.keys(ROLES) });
    process.exitCode = 1;
    return;
  }
  const { fromEnvironment } = await import(ROLES[role]);
  const server = serve(fromEnvironment(process.env, { log }), { port: Number(port), log });
  server.once('listening', () => log.info('Listening', { role, port: server.address().port }));
  process.once('SIGTERM', () => server.close());
}

if (import.meta.main) await main();
