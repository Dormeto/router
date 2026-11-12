// Both routers' check loop (lambda/src/lib/check-run.mjs) and levels reader (lambda/src/lib/settings-levels.mjs) on the Firestore store
// over its fake: the contract lambda/test/check-run-shared.test.mjs runs on the DynamoDB store's.
import { checkRunContract } from '../../lambda/test/check-run-contract.mjs';
import { createFirestoreStore } from '../src/firestore.mjs';
import { fakeFirestore } from './firestore-fake.mjs';

checkRunContract('the Firestore store', async ({ now }) => {
  const firestore = fakeFirestore();
  const store = createFirestoreStore({ google: { request: firestore.request }, project: 'p', database: 'dmtr-europe-west1', now });
  await store.putConfig('demo', { workloadId: 'demo', urlMap: 'lb', backendService: 'demo' });
  return {
    store,
    // Where the check stopped, in the check's summary it writes whole at its end (router/check), only when it stopped short.
    keep: (cursor) => store.putCheck({ checkedAt: now(), ...(cursor ? { cursor } : {}) }),
    offboard: (workloadId) => store.deleteWorkload(workloadId),
  };
});
