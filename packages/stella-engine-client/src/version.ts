/**
 * The `stella-serve` release this client was written and verified against.
 *
 * The wire types under `src/generated/` were copied from the Stella
 * repository at this version, and the smoke test drove a real binary of it.
 * A newer server may add frames and fields; a client built here keeps
 * reading them (unknown tags pass through) but claims nothing about them.
 * Bump this in the same change that refreshes the generated types.
 */
export const STELLA_SERVE_PINNED_VERSION = "0.9.411";
