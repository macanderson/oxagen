# @oxagen/steering-assembler

The one function where everything that could steer an agent competes for
Oxagen's slice of its context (ADR-093, ADR-144).

## Boundary

- **Owns:** ranking steering candidates by force and recency, fitting them to
  a token budget, and the manifest that names every candidate as `included`
  or `cut` with its reason.
- **Does not own:** reading context records or steer commands from a store,
  or building the policy bundle
  ([`@oxagen/handlers`](../handlers/README.md),
  `packages/handlers/src/lib/tacho-steering.ts`); sealing the manifest into a
  run's chain ([`@oxagen/tacho`](../tacho/README.md) on the host,
  [`@oxagen/run-ledger`](../run-ledger/README.md) for the frame kind); counting
  delivered manifests ([`@oxagen/telemetry`](../telemetry/README.md),
  `src/steering-deliveries.ts`).
- **Depends on:** No `@oxagen/*` runtime dependencies. It imports
  `budgetTokens` from `@contextgraphprotocol/typescript-sdk` for the token
  unit and `node:crypto` for digests.
- **Used by:** `@oxagen/handlers` (`src/lib/tacho-steering.ts`,
  `assembleWorkspaceSteering`).

## Seams

| Seam | Kind | Source | Wired by |
|---|---|---|---|
| `assembleSteering(run, budgetTokens)` | export | `packages/steering-assembler/src/assemble.ts` | `packages/handlers/src/lib/tacho-steering.ts` |
| `SteeringCandidate`, `SteeringManifest` types | port | `packages/steering-assembler/src/assemble.ts` | `packages/handlers/src/lib/tacho-steering.ts` maps context records to candidates |
| `STEERING_MANIFEST_SCHEMA` (`oxagen.steering.manifest/1`) | boundary | `packages/steering-assembler/src/assemble.ts` | Copied, not imported, as the same constant in `packages/tacho/src/wire.ts` |

## Entry points

- `.` → `src/index.ts`: `assembleSteering`, `compareCandidates`, the force and
  kind vocabularies, `STEERING_HEADER`, `STEERING_MANIFEST_SCHEMA`, and the
  types.

## Rules

- The same candidate set assembles the same text in any input order, because
  the text is part of the policy bundle etag (ADR-093).
- A candidate that does not fit is skipped and the walk continues, and every
  cut is named in the manifest (ADR-093).
- The package takes no `@oxagen/*` runtime dependency and does no I/O
  (ADR-144).
- `STEERING_MANIFEST_SCHEMA` here and in `packages/tacho/src/wire.ts` must stay
  equal. No test holds the two together, so change both in one commit.

## Tests

```bash
pnpm --filter @oxagen/steering-assembler test:unit src/assemble.test.ts
```

Never put `--` before the filename. The tests live beside the source in
`src/assemble.test.ts`.

## How it works

```ts
import {
  assembleSteering,
  PREFIX_BUDGET_TOKENS,
} from "@oxagen/steering-assembler";

const { text, manifest } = assembleSteering(
  { orgId, workspaceId, runId, candidates },
  PREFIX_BUDGET_TOKENS,
);
```

`PREFIX_BUDGET_TOKENS` is 2,000 budget tokens, at most 8,000 characters. One
bundle serves every harness on a host, so the prefix fits the smallest limit
any harness documents for hook text: 10,000 characters in Claude Code, and
about 2,500 tokens in Codex. Past that limit the agent reads a file path and
a preview, not the records. `HARNESS_CONTEXT_MAX_CHARS` lists each limit and
its source.

`candidates` are context records, operator steer commands and, later, skill
descriptions, each with an id, a kind, a force (`must`, `should`, `may`,
`info`), a body and the instant it took effect. The assembler ranks them by
tier and then by recency, fits them to the budget by skipping what does not
fit, and returns the text the agent reads.

The manifest lists every candidate in rank order with `included` or `cut` and
the reason for a cut: `tier` (this injection point does not deliver that
force), `superseded` (a newer version of the same lineage won) or `budget`
(no room left). It is sealed into the run record as a `steering.manifest`
frame, so the Run page, the run export and the Steering page can show which
records a run saw and which never reached it.

Budget tokens are the Context Graph Protocol's unit, `ceil(utf8_bytes / 4)`,
so a host that caps the text in characters is safe at `chars / 4`.

## Why this package exists

Before it, `compileSteering` in `@oxagen/handlers` compiled `must` and
`should` records into the bundle and said only how many it left out.
`@oxagen/context-provider` held the only token budgeter in the tree and
`@oxagen/engram` a second memory system, and no application imported either.
The 2026-09-18 steering review found "no assembler, no budget, no manifest".
This package is the assembler; those two packages are gone.
