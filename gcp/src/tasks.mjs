// Cloud Tasks: the router's asynchronous actions (a nap, a wake, a check) are tasks that call the controller with an
// OIDC token of the router's service account; Cloud Run checks it (invoker IAM) and the controller's audience is its
// URL. Ruling 27: the dispatch deadline is the controller's timeout, 900 s.
const TASKS = 'https://cloudtasks.googleapis.com/v2';
const DISPATCH_DEADLINE = '900s';

export const CALLS = {
  enqueue: ['cloudtasks.tasks.create'],
};

export function createTasks({ google, project, region, queue, serviceAccount }) {
  // `url`: the controller's endpoint; `body`: the JSON it receives. Returns the created task.
  const enqueue = ({ url, body }) => google.request('POST', `${TASKS}/projects/${project}/locations/${region}/queues/${queue}/tasks`, {
    task: {
      dispatchDeadline: DISPATCH_DEADLINE,
      httpRequest: {
        httpMethod: 'POST',
        url,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify(body)).toString('base64'),
        oidcToken: { serviceAccountEmail: serviceAccount, audience: new URL(url).origin },
      },
    },
  });

  return { enqueue };
}
