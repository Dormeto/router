// What names a workload (spec section 3): its ID, and the header its waker backend service adds to each request. Under a swap
// (the coverage design's section 7), that service adds a second one, which tells the waker so.
export const WORKLOAD_ID = /^[a-z]([a-z0-9-]{0,38}[a-z0-9])?$/;
export const WORKLOAD_HEADER = 'x-dormeto-workload';
export const SWITCH_HEADER = 'x-dormeto-switch';
