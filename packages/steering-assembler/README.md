# @oxagen/steering-assembler

The one function where everything that could steer an agent competes for
Oxagen's slice of its context (ADR-093, ADR-142).

```ts
import { assembleSteering } from "@oxagen/steering-assembler";

const { text, manifest } = assembleSteering(
  { orgId, workspaceId, runId, candidates },
  4096,
);
```

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
