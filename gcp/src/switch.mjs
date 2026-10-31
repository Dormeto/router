// The swap of regional and classic load balancers (vision docs/specs/2026-10-30-google-cloud-coverage-design.md, section 7).
// SWAP_WAIT, by the load balancer's kind: a map's change reaching the load balancer. Regional: G0's worst 89 s, M3 35 s;
// classic: M2's worst 226 s and 10 %.
export const SWAP_WAIT_MS = { regional: 100_000, classic: 250_000 };
