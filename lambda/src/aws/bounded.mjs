// Every AWS call of the router is bounded: connected within 3 seconds, answered within 10 seconds of silence, else a
// TimeoutError that the SDK retries on a new connection. The SDK's default is no timeout: on 2026-10-09 a scheduled check
// waited 15 minutes for an answer that never came, and its lease skipped the next three checks. socketTimeout fails a
// silent request in every SDK version; requestTimeout does too in older ones, and in recent ones only with
// throwOnRequestTimeout (a warning otherwise). Both end with the answer's headers: a long download is not cut.
export const BOUNDED = { connectionTimeout: 3_000, requestTimeout: 10_000, socketTimeout: 10_000, throwOnRequestTimeout: true };
