// A burst of wakes in one account-region (scale design §6): each wake switches its rules in its own controller invocation
// (its own SDK client), against the ELB bucket of mutating calls (20, 3 a second) shared with the customer's tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setRoute } from '../src/lib/route.mjs';
import { withSdkRetries } from './crowded-fake.mjs';
import { simClock } from './sim-clock.mjs';

const tg = (kind, i) => `arn:aws:elasticloadbalancing:eu-west-3:111122223333:targetgroup/w${i}${kind}/${i.toString(16).padStart(16, '0')}`;

function account({ clock, burst = 20, rate = 3, latencyMs = 50 }) {
  const bucket = { tokens: burst, at: clock.now() };
  const stats = { calls: 0, throttled: 0 };
  return {
    stats,
    async modifyRule() {
      stats.calls += 1;
      await clock.sleep(latencyMs);
      bucket.tokens = Math.min(burst, bucket.tokens + ((clock.now() - bucket.at) / 1000) * rate);
      bucket.at = clock.now();
      if (bucket.tokens < 1) {
        stats.throttled += 1;
        throw Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
      }
      bucket.tokens -= 1;
      return {};
    },
  };
}

test('200 wakes within 30 seconds in one account-region all switch their rules: a throttled switch waits its turn instead of failing the wake', async () => {
  const clock = simClock();
  const elb = account({ clock });
  const wakes = Array.from({ length: 200 }, (_, i) => i);
  const outcomes = await clock.until(Promise.all(wakes.map(async (i) => {
    await clock.sleep(Math.floor((i * 30_000) / wakes.length));
    const cfg = { workloadId: `w${i}`, appTargetGroupArn: tg('', i), wakerTargetGroupArn: tg('-waker', i) };
    const rule = { RuleArn: `rule-${i}`, Actions: [{ Type: 'forward', ForwardConfig: { TargetGroups: [{ TargetGroupArn: cfg.appTargetGroupArn, Weight: 0 }, { TargetGroupArn: cfg.wakerTargetGroupArn, Weight: 1 }] } }] };
    // Each wake runs in its own invocation: its own client and retries.
    const { client } = withSdkRetries(elb, { now: clock.now, sleep: clock.sleep });
    const started = clock.now();
    try {
      await setRoute(client, cfg, 'app', { found: { instrumented: [rule], issues: [] }, sleep: clock.sleep, now: clock.now, until: started + 180_000 });
      return { ok: true, ms: clock.now() - started };
    } catch (err) {
      return { ok: false, error: err.name };
    }
  })));
  assert.ok(elb.stats.throttled > 0, 'the bucket never ran dry');
  assert.deepEqual(outcomes.filter((o) => !o.ok), []);
  // The burst drains at the bucket's rate: the last switch within a few minutes.
  assert.ok(Math.max(...outcomes.map((o) => o.ms)) <= 180_000);
});

test('a route switch still throttled when its time is up fails, as before', async () => {
  const clock = simClock();
  const elb = { async modifyRule() { await clock.sleep(50); throw Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' }); } };
  const cfg = { workloadId: 'w', appTargetGroupArn: tg('', 1), wakerTargetGroupArn: tg('-waker', 1) };
  const rule = { RuleArn: 'rule', Actions: [{ Type: 'forward', ForwardConfig: { TargetGroups: [{ TargetGroupArn: cfg.appTargetGroupArn, Weight: 0 }, { TargetGroupArn: cfg.wakerTargetGroupArn, Weight: 1 }] } }] };
  const started = clock.now();
  await assert.rejects(clock.until(setRoute(elb, cfg, 'app', { found: { instrumented: [rule], issues: [] }, sleep: clock.sleep, now: clock.now, until: started + 60_000 })), { name: 'ThrottlingException' });
  // Tried again until the next wait would pass its time, never after.
  assert.ok(clock.now() - started >= 50_000 && clock.now() - started <= 60_000, `${(clock.now() - started) / 1000} s`);
});
