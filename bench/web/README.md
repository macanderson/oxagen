# @oxagen/bench-web

The **Oxagen SWE-bench dashboard** — a web page that reports how Oxagen and
other AI coding agents actually perform on
[SWE-bench](https://github.com/SWE-bench/SWE-bench): real GitHub issues, real
repos, real hidden tests. There is no simulator here and no invented score.

## Launch

```bash
pnpm eval:app        # from the repo root → http://localhost:3200
# equivalently:
pnpm bench
pnpm --filter @oxagen/bench-web dev
```

It is intentionally **excluded from `pnpm dev`** so it never adds a fifth
persistent server to the main local stack — run it on demand with `pnpm eval:app`.

The launcher (`scripts/dev.mjs`) is resilient to a busy port: it prefers 3200,
but if 3200 is already serving this dashboard it just prints the live URL and
exits 0, and if 3200 is held by something else it starts on the next free port
and announces it. So `pnpm eval:app` never hard-crashes with `EADDRINUSE`.
Override the preferred port with `PORT=<n> pnpm eval:app`; for the raw,
fixed-3200 behaviour use `pnpm --filter @oxagen/bench-web dev:next`.

## The provenance policy — read this before adding a number

Every figure rendered on this page must be one of:

- **MEASURED** — loaded from a real `oxagen.eval.v1` result file produced by
  our own harness run. It carries model, dataset, run date, git SHA, and a
  reproduce command (`src/lib/types.ts`'s `Provenance` union, `kind:
  "measured"`).
- **REFERENCE** — a figure from a cited primary source with a publication date
  and URL (`src/lib/sources.ts`). We never hardcode a competitor leaderboard
  ranking — those numbers are volatile and we can't keep them honest — we link
  out to the live official board instead
  ([swebench.com](https://www.swebench.com)).
- **SAMPLE** — clearly and loudly labeled illustrative data, never used in a
  headline or summary claim. Rows render with an amber "Sample" badge and the
  dashboard shows a banner warning when the only data present is sample data.

If you're ever about to write a specific percentage, ask: does it have a
measured result file behind it, or a cited dated URL? If neither, don't write
it.

## The data model

The harness emits JSON documents matching the `oxagen.eval.v1` schema (see
`src/lib/types.ts` for the exact shape). They land in `src/results-data/` and
are wired through `src/results-data/index.ts`, which validates every file with
`parseEvalRun` (`src/lib/eval-schema.ts`) — a malformed file fails the build
loudly rather than silently dropping data.

**There are no measured Oxagen runs committed yet** — a real SWE-bench
Verified run needs Docker plus model API keys and takes hours. Today
`src/results-data/` holds exactly one file,
`sample.swe-bench-verified.eval.json`, which is explicitly tagged
`labels.provenance: "sample"` and carries `notes: "SAMPLE DATA — illustrative
only, not a real benchmark run"`.

To populate a real result: run the harness (`pnpm bench:swe:compare`), drop the
emitted `*.eval.json` file into `src/results-data/`, and add it to the array in
`src/results-data/index.ts`. `loadEvalRuns` will reject it at import time if it
doesn't match the schema.

## What's on the page

- **Trust banner** — states the honesty policy plainly; escalates to a loud
  warning if every row is sample data.
- **Resolved-rate chart + results table** — one row per real eval run, ranked
  by resolved rate, each expandable to show its reproduce command and git SHA.
  Rows sharing the same dataset + model are flagged as a "Controlled"
  head-to-head.
- **What the benchmark actually does** — a step-by-step walkthrough of a real
  task: issue → agent patch → hidden tests in Docker → pass/fail.
- **Fairness & methodology** — the rules for an apples-to-apples comparison and
  the caveats we're not allowed to omit (self-reported runs, dataset quality
  audits, pass@1, etc).
- **Third-party verified results** — links to the live official leaderboards
  instead of a hardcoded snapshot, plus the dated primary-source citations.
- **Sources** — the full bibliography.

## Layout

| Path | Purpose |
| --- | --- |
| `src/lib/` | Pure, unit-tested schema validation + aggregation + sources + formatters |
| `src/results-data/` | Committed `oxagen.eval.v1` result files + the loader that validates them |
| `src/components/` | Client React view layer (dashboard sections) |
| `src/app/` | Next.js App Router shell |

## Scripts

```bash
pnpm --filter @oxagen/bench-web dev           # dev server (port 3200)
pnpm --filter @oxagen/bench-web build         # production build
pnpm --filter @oxagen/bench-web typecheck     # tsc --noEmit
pnpm --filter @oxagen/bench-web lint          # eslint (zero warnings)
pnpm --filter @oxagen/bench-web test:unit     # vitest (src/lib/**)
pnpm --filter @oxagen/bench-web test:coverage # vitest + coverage (>=90% on src/lib/**)
```
