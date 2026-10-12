import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recommendations } from '../src/lib/advice.mjs';

const group = (warmPool) => ({ kind: 'asg', name: 'asg-demo', min: 1, max: 2, desired: 1, instances: [], warmPool, wakeDesired: null });
const SUITABLE = { state: 'Stopped', minSize: 0, maxPrepared: null, reuseOnScaleIn: true, size: 1 };

test('a group without a warm pool gets the warm pool recommendation', () => {
  const [advice] = recommendations([group(null)]);
  assert.equal(advice.backend, 'asg-demo');
  assert.match(advice.message, /add a warm pool in Stopped state with reuse on scale-in/);
  assert.match(advice.message, /start at boot/);
});

test('a running warm pool and a pool without reuse on scale-in are flagged', () => {
  assert.match(recommendations([group({ ...SUITABLE, state: 'Running' })])[0].message, /use Stopped/);
  assert.match(recommendations([group({ ...SUITABLE, reuseOnScaleIn: false })])[0].message, /terminate the instances/);
});

test('a suitable warm pool, hibernated pools and other backends get no recommendation', () => {
  assert.deepEqual(recommendations([group(SUITABLE), group({ ...SUITABLE, state: 'Hibernated' }), { kind: 'ecs', id: 'x' }, { kind: 'instance', id: 'i-1' }]), []);
});
