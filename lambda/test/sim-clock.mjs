// Simulated time for concurrent work: sleep(ms) waits on a virtual timer; until(promise) runs the work, jumping to the
// next timer whenever every task waits. Calls in parallel overlap in time as they would on AWS.
export function simClock(start = Date.UTC(2026, 9, 5, 12)) {
  let t = start;
  let seq = 0;
  const timers = [];
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  return {
    now: () => t,
    sleep: (ms) => new Promise((resolve) => { timers.push({ at: t + Math.max(0, ms), seq: seq++, resolve }); }),
    advance(ms) { t += ms; },
    async until(promise) {
      let done = false;
      let value;
      let error;
      promise.then((v) => { done = true; value = v; }, (e) => { done = true; error = e; });
      while (!done) {
        await tick();
        if (done) break;
        if (!timers.length) {
          await tick();
          if (!done && !timers.length) throw new Error('simulation stuck: nothing to wait for');
          continue;
        }
        timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
        const next = timers.shift();
        t = Math.max(t, next.at);
        next.resolve();
      }
      if (error) throw error;
      return value;
    },
  };
}
