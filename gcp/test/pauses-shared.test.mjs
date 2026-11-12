// Both routers' pauses (lambda/src/lib/pauses.mjs) on the Firestore store over its fake, through the adapter the Google Cloud
// controller builds: the contract lambda/test/pauses-shared.test.mjs runs on the DynamoDB store's.
import { pausesContract } from '../../lambda/test/pauses-contract.mjs';
import { pauseStore } from '../src/controller-core.mjs';
import { createFirestoreStore } from '../src/firestore.mjs';
import { fakeFirestore } from './firestore-fake.mjs';

pausesContract('the Firestore store', () => {
  const firestore = fakeFirestore();
  const store = createFirestoreStore({ google: { request: firestore.request }, project: 'p', database: 'dmtr-europe-west1' });
  return {
    store: pauseStore(store),
    workloads: async (ids) => {
      for (const workloadId of ids) await store.putConfig(workloadId, { workloadId, urlMap: 'lb', backendService: workloadId });
    },
  };
});
