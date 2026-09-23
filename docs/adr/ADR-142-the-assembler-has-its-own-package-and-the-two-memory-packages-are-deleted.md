# ADR-142: The assembler has its own package, and the two memory packages are deleted

Status: Accepted

Date: 2026-09-22

Related: ADR-091, ADR-093, ADR-097, `docs/audits/2026-09-18-steering-graph-gateway-review.md`,
roadmap decision D22, `packages/steering-assembler/`,
`packages/handlers/src/lib/tacho-steering.ts`, `packages/tacho/src/wire.ts`,
`packages/tacho/src/collector/steering-manifest.ts`

## Context

ADR-093 decided that one function, `assembleSteering(run, budget)`, is where
everything that could steer an agent competes for Oxagen's slice of its
context, and that it returns a manifest of what it included and what it cut,
recorded as a `steering.manifest` frame. The 2026-09-18 review that the ADR
came from found no such place: `compileSteering` in `packages/handlers`
printed `must` and `should` records and said only how many it left out, the
only token budgeter in the tree was `packWithinBudget` in
`packages/context-provider`, and no application imported that package or
`packages/engram`, the second memory system beside it.

ADR-093 §7 named `packages/context-provider` as the assembler's home and left
`packages/engram` to be deleted or folded in. Three things argued against
building there:

- The package existed to serve Context Graph Protocol frames over stdio from
  an engram store. Its provider, its stdio loop, its frame renderer and its
  test store all depended on engram. The assembler needs none of them, and a
  package whose name and README describe a stdio provider is the wrong
  address for the one function every steering surface calls.
- `packages/engram` carried DuckDB, `tiktoken` and `@anthropic-ai/tokenizer`
  as dependencies, and `apps/app`'s build carried native-addon stubs to keep
  Turbopack out of them. None of that served a product surface.
- `packWithinBudget` is fourteen lines. The rule it encodes, walk best-first
  and skip what does not fit, is what is worth keeping, not the module.

## Decision

**`packages/steering-assembler` is the assembler's home.** It is a leaf: its
one dependency is `@contextgraphprotocol/typescript-sdk`, for `budgetTokens`,
the protocol's budget-token rule (`ceil(utf8_bytes / 4)`). `assembleSteering`
ranks every candidate by tier and then by recency, fits the ranked list to the
budget by skipping what does not fit, and returns the text with a manifest
naming every candidate as included or cut and why: `tier`, `superseded` or
`budget`. `packages/handlers/src/lib/tacho-steering.ts` is its only caller.

**`packages/engram` and `packages/context-provider` are deleted.** Every file
under both directories, `apps/app/native-addon-stub.js`, the `@oxagen/engram`
dependency in `tools/scripts/package.json`, the `blake3` and `duckdb`
externals and aliases in `apps/app/next.config.ts`, and the three
`Context provider` entries in the environment registry
(`OXAGEN_CONTEXT_ORG`, `OXAGEN_CONTEXT_WORKSPACE`, `ENGRAM_DUCKDB_PATH`). No
re-export shim is left: nothing imported either package, so nothing needs one.
This amends ADR-093 §7 by reference; the rest of ADR-093 stands.

**The manifest rides the bundle and the host seals it.** Only the host can
add a frame to a wrapped run, so the control plane signs the manifest into the
bundle as `context.manifest`, gated behind the `steering_manifest` bundle
feature the way every new bundle field is gated, and a host that advertises
the feature seals it at `SessionStart` as a `steering.manifest` frame, with
the steers it delivered beside the prefix appended as included `steer` items.
The host ranks nothing; it reports what it delivered. `@oxagen/tacho` carries
its own copy of the manifest schema (H7), and a test in `packages/handlers`
keeps the assembler's output parsing under it.

**Ranking within a tier is by recency, not by slug.** ADR-091 ordered records
by slug. The assembler orders them by the instant their pinned version took
effect, newest first, with the slug as the tiebreak. The text a workspace's
hosts receive therefore changes once, and every etag moves once.

## Consequences

- The audit's finding stands closed: the assembler is
  `packages/steering-assembler/src/assemble.ts`, the budget is
  `CONTEXT_SYSTEM_BUDGET_TOKENS` in `tacho-steering.ts`, and the manifest is
  `context.manifest` on the bundle and the `steering.manifest` frame in the
  chain.
- A `may` or `info` record now appears in the manifest, cut for its tier, so
  the record shows it reached no session. Before, such a record was invisible.
- The Steering page can count, per run, what was included and what was cut,
  by reading the frames.
- `tiktoken`, `@anthropic-ai/tokenizer` and DuckDB leave the dependency
  graph. Token budgets are the protocol's byte rule, which is what the bundle
  cap is measured against.
- The volatile selection at `UserPromptSubmit` and the in-app agent's use of
  the same assembler remain Phase 1 work under ADR-093. The `steer` kind is
  typed and ranked by the assembler today and produced by the host's delivery
  report, not by a server-side adapter, because the server has no run context
  at bundle time.

## Alternatives considered

**Build inside `packages/context-provider` and delete `packages/engram`.**
Rejected: it keeps the stdio provider, the engram-shaped test store and the
CGP frame renderer alive with no caller, and it gives the one function every
steering surface calls a name that describes something else.

**Keep the real tokenizers.** Rejected: the bundle cap is in characters and
the protocol's budget token is bytes over four, so a vendor tokenizer would
give a number nothing checks against. If a surface ever needs a vendor count,
it can compute one from the candidate bodies; the assembler's unit stays the
protocol's.

**Let the server write the frame.** Rejected: the chain is the host's, sealed
in sequence, and a server-inserted event would break every verification.
