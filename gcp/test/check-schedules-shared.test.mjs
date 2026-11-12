// Both routers' schedules as the check applies them (lambda/src/lib/check-schedules.mjs) on the Firestore store over its fake: the
// contract lambda/test/check-schedules-shared.test.mjs runs on the DynamoDB store's.
import { checkSchedulesContract } from '../../lambda/test/check-schedules-contract.mjs';
import { STATES } from '../../lambda/src/lib/state.mjs';
import { createFirestoreStore } from '../src/firestore.mjs';
import { fakeFirestore } from './firestore-fake.mjs';

checkSchedulesContract('the Firestore store', async ({ run, schedule, now }) => {
  const firestore = fakeFirestore();
  const store = createFirestoreStore({ google: { request: firestore.request }, project: 'p', database: 'dmtr-europe-west1', now });
  await store.putConfig('demo', { workloadId: 'demo', urlMap: 'lb', backendService: 'demo' });
  if (run) {
    // Onboarded awake, then as the run says.
    await store.initRun('demo', run.awakeSince ?? 0);
    const { state, ...fields } = run;
    await store.transition('demo', { cond: { state: STATES.AWAKE }, set: { ...fields, state } });
  }
  if (schedule) await store.putSchedule('demo', schedule);
  return store;
});
