## Self-Evaluation — TOML artifacts and lifecycle driver design — 2026-07-21

### What I set out to do

Design a TOML-only agent, skill, and command format; a foreign-platform conversion engine; and deterministic lifecycle capability execution.

### What I actually did (measurable deltas)

- Wrote and amended one 975-line repository design specification.
- Produced three implementation plans totaling 552 lines across 19 test-first tasks.
- Split delivery into canonical cutover, import engine, and lifecycle driver tracks.
- Added principal re-resolution, lifecycle eligibility, finalization/outbox, exact mapping, recursion, and canonical hashing requirements during architectural review.

### Quality of my decisions

- Best decision I made and why: separating `before_finalize` from `after_turn` removed an impossible state where post-terminal work could block terminalization, while preserving a durable guarantee through an outbox.
- Weakest decision I made and why: the first approved draft treated database projections too casually and assumed a principal-correct durable runner that does not exist in RunSpec V1. I should have checked those seams before presenting the initial lifecycle design.

### What I could have done better

- Inspect the durable run principal shape and capability surface types before drafting the first lifecycle TOML example.
- Decompose the three delivery tracks earlier instead of letting the first specification grow before formalizing dependencies.

### What surprised me about this codebase/product

The kernel already distinguishes a runner execution context from public capability surfaces, but durable RunSpec V1 intentionally omits the enqueuing principal. That makes lifecycle authorization primarily an identity-propagation problem, not merely a hook dispatcher problem.

### Risks I am leaving behind (untouched on purpose, and why)

- No production code has changed; dependency suitability, database migration details, and exact adapter dialect coverage remain implementation work.
- The current branch contains unrelated untracked files that were deliberately not inspected, staged, or modified.
- The plan selects pinned TOML/JCS libraries based on current primary package documentation; dependency review still belongs in the implementation PR.

### Confidence in the result: high

The design was checked against the live kernel, capability surfaces, durable runner, CLI loaders, skill APIs, and repository conventions; the implementation remains unstarted and therefore unverified.
