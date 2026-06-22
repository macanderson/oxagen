# ADR-015 — Graph-edge-driven git hooks (Vitest import-graph) + Biome formatting

- **Status:** Superseded in part (see Update 2026-06-21 below)
- **Date:** 2026-06-21
- **Supersedes:** the test-selection strategy in `lefthook.yml` (`pre-push.test-unit`) and the Prettier/ESLint formatting step in `pre-commit`.

## Update 2026-06-21 — no test runner in git hooks at all

The import-graph pre-push test runner this ADR introduced (`pre-push.test-related`,
`vitest --changed origin/main`) has been **removed entirely**. Decision: keep *all*
test execution — unit and e2e — in CI, never in a git hook. CI already runs both on
every `pull_request` and on `push` to `main` (`.github/workflows/pipeline.yml`,
`test` + `e2e` jobs, affected-only via `--filter=...[<base>]`), so the hook copy was
redundant feedback that still cost local CPU and remained a herd vector. Even an
import-graph-scoped Vitest run can fan out when a low-level module changes; the only
way to guarantee `git push` never spawns a test herd is to run no tests on push.

Two consequences for `lefthook.yml`:

- **pre-push** keeps only the two fast, non-test integrity checks (`check:contracts`,
  `env:check`). No `vitest`, no `playwright`, no build.
- **pre-commit `typecheck`** no longer shells to whole-repo `pnpm typecheck`. It now
  runs `tools/scripts/typecheck-staged.mjs {staged_files}`, which groups the staged
  files by their owning package `tsconfig.json` and type-checks **only those files**
  (plus their import closure) via a transient per-package config that extends the real
  one. `eslint --fix {staged_files}` was already staged-files-only. The authoritative
  affected-package typecheck stays in CI (`turbo run typecheck --filter=...[origin/main]`).

The Biome formatting decision (§2–§4 below) is unaffected and still pending its phased
rollout. The sections below are retained as the original rationale for the now-removed
import-graph test selection.

## Context

### The herd problem
`lefthook.yml`'s pre-push gate runs:

```yaml
test-unit:
  run: pnpm turbo run test:unit --filter='...[origin/main]'
```

The `...` prefix expands the filter to **every changed package _and all of its dependents_**. A change to a low-level package (`@oxagen/ai`, `@oxagen/oxagen`, `@oxagen/database`) therefore fans out to dozens of suites. This tree is worked by **multiple parallel Claude sessions plus an automated optimizer**, and the pre-push hook fires on every push. When several agents push near-simultaneously, the runs stack into overlapping Vitest herds that pin all 8 cores — observed load **50–72** — and can take the machine down. The entire "never push; Mac serializes pushes" operating rule in `CLAUDE.md` exists to route around this single failure mode.

Pre-commit additionally shells out to whole-repo `pnpm typecheck` (glob-gated) and `eslint --fix` (which also applies Prettier formatting).

### What the request asks for
> "Refactor the commit/push lefthooks so that only nodes the workspace knowledge graph has determined are related (THIS_FILE ↔ THAT_FILE) run — with a representation of the graph edges. Clean source with the best 2026 auto-formatter."

### Reality check on "the knowledge graph"
The repo **does** have a Neo4j knowledge graph (`packages/ontology`, `packages/agent/src/runtime/knowledge-graph.ts`, `packages/handlers/src/graph.cypher.ts`) — but it models **organization & agent knowledge/memory** (entities, embeddings, lineage), **not source files**. There is no file↔file relatedness graph today, and building one in Neo4j just to gate hooks would be over-engineering.

However, a file-relatedness graph with exactly the edges described **already exists implicitly**: the **module import graph**. `A imports B` is an edge; the set of tests "related" to a changed file is the set of test modules whose import chain reaches it. **Vitest traverses this graph natively**:

- `vitest related <files…>` — run only tests that (transitively) import the given files.
- `vitest --changed [ref]` — derive the changed file set from a git diff, then do the same.

`vitest.workspace.ts` already exists at the repo root, so a single root invocation spans all projects.

## Decision

1. **Pre-push test selection → Vitest import-graph (`--changed`).** Replace the `turbo … --filter='...[origin/main]'` fan-out with:

   ```bash
   pnpm vitest related --run --changed origin/main
   ```

   Only test files whose import edges reach a changed file execute. This is the literal "run the nodes the graph relates to the change" behavior, backed by the module graph rather than the coarse package-dependency closure.

2. **Formatting → Biome v2 replaces Prettier.** Pre-commit runs `biome format --write` (and `biome check --write` for the lint rules Biome owns) on **staged files only**, then re-stages. Biome is the GA, widely-adopted, Rust-based single tool — ~25× faster than Prettier and far faster than a Node ESLint pass.

3. **Keep a _lean_ ESLint for architectural rules Biome can't express.** The repo's custom `no-restricted-imports` rules — the `@oxagen/ui/components/*` re-export boundary (`eslint.next.mjs`), the tenancy-seam raw-`db()` ban (`eslint.tenancy-seams.mjs`), and the `@oxagen/ai`-only LLM-import rule — stay in ESLint, run on staged files only. **Biome owns formatting + common correctness; ESLint owns the bespoke boundaries.** This is the one place Biome is _not_ a drop-in, and pretending otherwise would silently drop enforcement of those boundaries.

4. **Edge representation (Phase 3, optional).** To satisfy "see a representation of the graph edges," add a `pnpm graph:edges` script using `dependency-cruiser` that emits a file-node / import-edge graph (SVG + JSON) to a gitignored `docs/CODEMAPS/import-graph/` path. This is documentation/visualization, decoupled from the hook hot path.

## The graph, concretely

```
nodes:  stream-event-types.ts   chat.stream.ts   use-tool-stream.ts
edges:  chat.stream.ts      --imports-->  stream-event-types.ts
        use-tool-stream.ts  --imports-->  stream-event-types.ts

change: stream-event-types.ts
        → related test nodes (reachable via reversed edges):
          chat.stream.test.ts, use-tool-stream.test.ts
        → everything else is NOT run locally (CI still runs the full set)
```

`vitest --changed origin/main` computes exactly this reverse-reachability set per push.

## Proposed `lefthook.yml`

```yaml
pre-commit:
  parallel: true
  commands:
    atlas-validate:        # unchanged
      glob: "packages/database/atlas/migrations/**"
      run: cd packages/database && atlas migrate validate --dir "file://atlas/migrations"

    # Format + Biome-owned lint on staged files, auto-fix, re-stage.
    format:
      glob: "*.{ts,tsx,js,jsx,mjs,mts,cts,json,jsonc}"
      exclude: ["docs/**", ".agents/**", ".claude/**"]
      run: pnpm exec biome check --write --no-errors-on-unmatched {staged_files}
      stage_fixed: true

    # Bespoke architectural boundaries Biome can't express, staged files only.
    lint-boundaries:
      glob: "*.{ts,tsx,js,jsx,mjs,mts,cts}"
      exclude: ["docs/**", ".agents/**", ".claude/**"]
      run: pnpm exec eslint --fix --no-warn-ignored {staged_files}
      stage_fixed: true

    typecheck:             # unchanged (whole-repo, glob-gated)
      glob: "*.{ts,tsx,js,jsx,mjs,mts,cts}"
      exclude: ["docs/**", ".agents/**", ".claude/**", "scripts/**"]
      run: pnpm typecheck

pre-push:
  parallel: true
  commands:
    contracts:             # unchanged — still the hard parity check
      glob: "*.{ts,tsx,js,jsx,mjs,mts,cts}"
      exclude: ["docs/**", ".agents/**", ".claude/**", "scripts/**"]
      run: pnpm check:contracts

    env-check:             # unchanged
      glob: "*.{ts,tsx,js,jsx,mjs,mts,cts}"
      exclude: ["docs/**", ".agents/**", ".claude/**", "scripts/**"]
      run: pnpm env:check

    # Import-graph-scoped tests: only suites whose edges reach the change.
    test-related:
      glob: "*.{ts,tsx,js,jsx,mjs,mts,cts}"
      exclude: ["docs/**", ".agents/**", ".claude/**", "scripts/**"]
      run: pnpm vitest related --run --changed origin/main
```

## Rollout (phased, each its own commit/PR)

- **Phase 0 — adopt Biome (no hook change yet).** Add `@biomejs/biome` to root devDeps; `biome migrate prettier` to seed `biome.json` from `.prettierrc.json`; one-shot `biome format --write .` as an **isolated formatting-only commit** (so it never pollutes a logic review). Coordinate timing with parallel sessions — everyone rebases through one large format commit once.
- **Phase 1 — pre-commit swap.** Replace the eslint-as-formatter step with the `format` + `lint-boundaries` split above.
- **Phase 2 — pre-push swap.** Replace `test-unit` with `test-related`. Keep `contracts` + `env:check`.
- **Phase 3 — edge viz (optional).** `pnpm graph:edges` via dependency-cruiser.

**CI is unchanged and remains the authoritative gate** (`turbo run build test:unit --filter='...[origin/main]'`). Hooks become fast, local, import-graph-scoped feedback; correctness backstop stays in CI.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| **Import graph misses non-import couplings** — JSON fixtures, env-schema changes, generated contracts, string-keyed handler registries (`@oxagen/handlers/register`), DI, dynamic `import()` — their dependents are linked by no static edge, so their tests are skipped **locally**. | CI still runs the full `...[origin/main]` fan-out (authoritative). Pre-push keeps `check:contracts` + `env:check`. Treat hooks as fast feedback, not the gate. Document the registry/contract exceptions. |
| **Biome ≠ ESLint rule parity** | Keep the bespoke `no-restricted-imports`/tenancy-seam rules in ESLint (`lint-boundaries`). Biome owns formatting + standard rules only. |
| **One-shot format sweep churns history** | Land as a single isolated commit; announce so parallel sessions rebase through it once; add it to `.git-blame-ignore-revs`. |
| **Shared-hook blast radius** — every session picks up new hooks on pull; a broken pre-push blocks everyone. | ADR-first (this doc) + phased rollout; validate `vitest --changed` locally on several change shapes before swapping Phase 2. |

## Alternatives considered

- **Keep `...[origin/main]`, cap concurrency (`turbo --concurrency=2`).** Reduces peak load but still runs irrelevant suites and gives slower feedback. Treats the symptom, not the over-selection.
- **Build a real file-relationship graph in Neo4j.** Over-engineering — the module import graph already is that graph, and Vitest queries it for free. The Neo4j graph stays scoped to org/agent knowledge (its infra-boundary per `CLAUDE.md`).
- **Oxc (`oxlint` + `oxfmt`) instead of Biome.** Newer and more viral, but the `oxfmt` formatter is still maturing; not yet safe for a monorepo-wide format authority. Revisit when GA.

## Consequences

- Pushes stop fanning out to unrelated suites → the dominant herd source is removed; the strict no-push serialization in `CLAUDE.md` can relax once Phase 2 proves out.
- A single fast 2026 formatter (Biome) owns style; ESLint shrinks to architectural-boundary enforcement.
- Local hooks and CI diverge by design: hooks are import-graph-scoped fast feedback, CI is the exhaustive gate. This must be stated wherever the gate is documented so no one mistakes a green hook for a green CI.
