// A Google Cloud HTTP workload's row (the `list` action), status (the `status` action) and REST Workload (GET /v1/workloads/<id>, the
// CLI's) are byte-equal to what the router answered before standalone workloads (plan 5, R31): fixtures/http-rows.json was written from
// the code at router 7c54517, before R31 changed rows.mjs, actions.mjs and onboarding.mjs. DMT_WRITE_FIXTURE=1 writes it again (only at
// such a base).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createActions } from '../src/actions.mjs';
import { createControllerApi } from '../src/controller.mjs';
import { INPUT, setup } from './world.mjs';

const FIXTURE = new URL('./fixtures/http-rows.json', import.meta.url);

const request = (method, url, body = '') => {
  const stream = (async function* chunks() { if (body) yield Buffer.from(body); }());
  return Object.assign(stream, { method, url, headers: {} });
};

async function answers() {
  const t = setup();
  const { store, core, onboarding, config, clock, log } = t;
  Object.assign(config, { version: '0.41.0', build: 'b7' });
  Object.assign(store, {
    manager: null,
    getManagerSettings: async () => structuredClone(store.manager),
    getStats: async (id, days) => ({ days, since: '2023-11-08', today: { ignored: {}, deferred: {}, wakes: {} }, total: { ignored: { bot: 2 }, deferred: {}, wakes: { manager: 1 } } }),
  });
  const router = { name: `dmtr-${config.region}`, version: config.version, build: config.build, project: config.project, region: config.region };
  const actions = createActions({ controller: core, onboarding, store, router, now: clock.now, log });
  const handler = createControllerApi({ core, onboarding, config, actions });
  const call = async (method, path, body) => JSON.parse((await handler(request(method, path, body === undefined ? '' : JSON.stringify(body)))).body);
  const onboarded = await call('POST', '/v1/workloads', { ...INPUT, name: 'Demo', tags: { team: 'shop' }, settings: { idleMinutes: 30 } });
  return {
    onboarded,
    show: await call('GET', '/v1/workloads/demo'),
    list: await call('POST', '/v1/actions', { action: 'list' }),
    status: await call('POST', '/v1/actions', { action: 'status', workloadId: 'demo' }),
  };
}

test('a Google Cloud HTTP workload\'s REST Workload, row and status are byte-equal to the router\'s before standalone workloads', async () => {
  const text = `${JSON.stringify(await answers(), null, 2)}\n`;
  if (process.env.DMT_WRITE_FIXTURE === '1') writeFileSync(FIXTURE, text);
  assert.equal(text, readFileSync(FIXTURE, 'utf8'));
});
