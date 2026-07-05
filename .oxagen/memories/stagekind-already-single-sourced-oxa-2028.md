---
name: stagekind-already-single-sourced-oxa-2028
type: observation
domain: cli
severity: P3
linear: OXA-2028
date: 2026-07-04
---

**Symptom:** Ticket OXA-2028 asked to single-source `StageKind` (canonical enum
hand-copied in `packages/agent-engine` and `apps/cli/src/agent/trace.ts`, plus
4 `Record<StageKind, ...>` render maps that could silently drift), citing a
concrete visible bug: the CLI allegedly could not render the engine's
"memory" stage.

**Investigation:** By the time this ticket was picked up in an isolated
worktree cut from `origin/main`, `git diff origin/main` was already empty for
every file matching `StageKind` — the fix had already landed on `main` via two
prior commits from a different parallel session, same day:
- `77b34576` — "fix(cli): re-export StageKind from @oxagen/agent-engine
  instead of hand-copying it"
- `f2b5980a` (PR #570, "reliability: circuit breakers, Inngest idempotency,
  StageKind drift, loud memory-recall") — the commit that actually merged it
  into `main`.

That fix:
1. Made `packages/agent-engine/src/trace/types.ts` the sole definition of
   `StageKind` (`evaluate | plan | enhance | route | execute | judge | revise
   | complete`).
2. Changed `apps/cli/src/agent/trace.ts` to
   `import type { StageKind } from "@oxagen/agent-engine"; export type { StageKind };`
   instead of hand-copying the union.
3. Exported all 4 `Record<StageKind, ...>` maps (`STAGE_GLYPH`, `STAGE_COLOR`,
   `STAGE_LABEL` in `apps/cli/src/repl/components.tsx`, `PHASE_LABEL` in
   `apps/cli/src/agent/trace-format.ts`) so exhaustiveness could be tested —
   TypeScript's structural checking on an object literal typed as
   `Record<StageKind, X>` already refuses to compile if a member is missing,
   so no `satisfies` gymnastics were needed once the type was singular.
4. Added `apps/cli/src/agent/__tests__/stage-kind-exhaustive.test.ts` (source
   guard against a hand-copied union reappearing + PHASE_LABEL exhaustiveness)
   and extended `apps/cli/src/repl/__tests__/components.test.tsx` with the
   same guard for the three Ink-facing maps plus a `StageBadge` render smoke
   test across every known stage.
5. **Important finding documented in that commit's message:** the "memory"
   stage the ticket describes as visibly broken does not exist as a
   `StageKind` member at all — "memory" only appears as a value of the
   unrelated `EnhancementTrace.source` field (`"none" | "code-graph" |
   "memory" | "code-graph+memory"`), which is a different type. The enum
   values themselves were never actually out of sync; the duplication (zero
   compiler enforcement of parity) was the real defect, and that's what got
   fixed. There was nothing further to "fix" for a phantom memory stage.

**Guard:** re-ran the existing regression suite narrowly in this worktree
after a fresh `pnpm i --no-frozen-lockfile` (worktree node_modules were
dangling per the known worktree-cleanup gotcha):
`apps/cli` → `vitest run src/agent/__tests__/stage-kind-exhaustive.test.ts
src/repl/__tests__/components.test.tsx` → 2 files, 51 tests, all green.
`tsc --noEmit` on `packages/agent-engine` is clean. `tsc --noEmit` on
`apps/cli` has 13 pre-existing, unrelated errors in `src/tui/banner.tsx`
(duplicate function implementations, missing `cols` — from the banner v2
work, PR #588) that predate and are unrelated to this ticket; out of scope
for OXA-2028.

**Watch-outs:** when 10 parallel agents are dispatched against the same
ticket backlog, a ticket can already be resolved on `main` before your
worktree is even cut if another session picked it up first (or if it was
folded into a broader PR like #570's "reliability" grab-bag). Always check
`git diff origin/main` for the files the ticket names before writing new
code — reproducing an already-shipped fix wastes a full worker and risks
introducing a second, slightly different implementation that conflicts on
merge.
