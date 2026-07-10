// Ambient jest-dom matcher types for vitest. The runtime side-effect import
// lives in vitest.setup.ts; this declaration file carries the TYPE
// augmentation so per-file typechecks that never load vitest.setup.ts — the
// pre-commit staged hook's temp config only adds `**/*.d.ts` — still see
// `toBeInTheDocument`/`toHaveClass` on vitest's Assertion.
import "@testing-library/jest-dom/vitest";
