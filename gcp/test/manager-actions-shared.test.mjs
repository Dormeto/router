// Both routers' answers to the manager (lambda/src/lib/manager-actions.mjs) and the wakes they ask (asked-wake.mjs) on the Firestore
// store over its fake: the contract lambda/test/manager-actions-shared.test.mjs runs on the DynamoDB store's.
import { managerActionsContract } from '../../lambda/test/manager-actions-contract.mjs';
import { STATES } from '../../lambda/src/lib/state.mjs';
import { createFirestoreStore } from '../src/firestore.mjs';
import { fakeFirestore } from './firestore-fake.mjs';

managerActionsContract('the Firestore store', async ({ run, now }) => {
  const firestore = fakeFirestore();
  const store = createFirestoreStore({ google: { request: firestore.request }, project: 'p', database: 'dmtr-europe-west1', now });
  await store.putConfig('demo', { workloadId: 'demo', urlMap: 'lb', backendService: 'demo' });
  if (run) {
    // Onboarded awake, then as the run says.
    await store.initRun('demo', run.awakeSince ?? 0);
    const { state, ...fields } = run;
    await store.transition('demo', { cond: { state: STATES.AWAKE }, set: { ...fields, state } });
  }
  return { store, offboard: () => store.deleteWorkload('demo') };
});
