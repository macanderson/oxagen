# @oxagen/bench-web

The **Oxagen Benchmark Suite** — a web dashboard that compares AI code agents
(Oxagen CLI, Claude Code, GitHub Copilot, Google Gemini) across 12 evaluations
in 4 categories (Speed, Efficiency, Accuracy, Quality).

## Launch

```bash
pnpm eval:app        # from the repo root → http://localhost:3200
# equivalently:
pnpm bench
pnpm --filter @oxagen/bench-web dev
```

It is intentionally **excluded from `pnpm dev`** so it never adds a fifth
persistent server to the main local stack — run it on demand with `pnpm eval:app`.

## How it works

The benchmark is a **deterministic simulation**, not a live agent race. Each
agent has a published performance profile (relative speed, token efficiency,
baseline accuracy — see `src/lib/data.ts`) and each evaluation has a baseline
cost. Given a seed, `runBenchmark()` (`src/lib/benchmark.ts`) derives a full set
of per-task results reproducibly — no API keys, agents, or network calls. This
keeps the dashboard self-contained and offline-friendly while staying honest
about being a model.

- **Setup** — pick agents, evaluations, and difficulty.
- **Running** — progressive reveal of each task with a streaming log.
- **Results** — composite score, pass rate, speed/token charts, a comparative
  table, and a failure-mode breakdown.

## Layout

| Path | Purpose |
| --- | --- |
| `src/lib/` | Pure, unit-tested simulation engine + data + formatters |
| `src/components/` | Client React view layer (dashboard + tabs + charts) |
| `src/app/` | Next.js App Router shell |

## Scripts

```bash
pnpm --filter @oxagen/bench-web dev           # dev server (port 3200)
pnpm --filter @oxagen/bench-web build         # production build
pnpm --filter @oxagen/bench-web typecheck     # tsc --noEmit
pnpm --filter @oxagen/bench-web lint          # eslint (zero warnings)
pnpm --filter @oxagen/bench-web test:unit     # vitest (engine)
pnpm --filter @oxagen/bench-web test:coverage # vitest + coverage
```
