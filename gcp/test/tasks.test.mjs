import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTasks, CALLS } from '../src/tasks.mjs';

test('enqueue: a POST task for the controller, with an OIDC token of the router\'s service account (ruling 27: 1800 s)', async () => {
  const calls = [];
  const google = { request: async (method, url, body) => { calls.push({ method, url, body }); return { name: 'projects/p/locations/europe-west1/queues/dmtr-europe-west1/tasks/1' }; } };
  const tasks = createTasks({
    google, project: 'p', region: 'europe-west1', queue: 'dmtr-europe-west1',
    serviceAccount: 'dmtr-europe-west1@p.iam.gserviceaccount.com',
  });
  const task = await tasks.enqueue({ url: 'https://dmtr-europe-west1-controller-123.europe-west1.run.app/v1/tasks', body: { action: 'wake', workloadId: 'app' } });
  assert.equal(task.name.endsWith('/tasks/1'), true);
  assert.deepEqual(calls, [{
    method: 'POST',
    url: 'https://cloudtasks.googleapis.com/v2/projects/p/locations/europe-west1/queues/dmtr-europe-west1/tasks',
    body: {
      task: {
        dispatchDeadline: '1800s',
        httpRequest: {
          httpMethod: 'POST',
          url: 'https://dmtr-europe-west1-controller-123.europe-west1.run.app/v1/tasks',
          headers: { 'content-type': 'application/json' },
          body: Buffer.from(JSON.stringify({ action: 'wake', workloadId: 'app' })).toString('base64'),
          oidcToken: {
            serviceAccountEmail: 'dmtr-europe-west1@p.iam.gserviceaccount.com',
            audience: 'https://dmtr-europe-west1-controller-123.europe-west1.run.app',
          },
        },
      },
    },
  }]);
});

test('CALLS', () => {
  assert.deepEqual(CALLS, { enqueue: ['cloudtasks.tasks.create'] });
});
