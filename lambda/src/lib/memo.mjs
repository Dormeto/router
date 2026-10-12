// Share one in-flight or successful async result; a failure is not cached, so the next call retries.
export function memoizeAsync(factory) {
  let pending;
  return () => (pending ??= factory().catch((err) => {
    pending = undefined;
    throw err;
  }));
}
