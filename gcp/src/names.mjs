// What names a workload (spec section 3): its ID, and the header its waker backend service adds to each request.
export const WORKLOAD_ID = /^[a-z]([a-z0-9-]{0,38}[a-z0-9])?$/;
export const WORKLOAD_HEADER = 'x-dormeto-workload';
