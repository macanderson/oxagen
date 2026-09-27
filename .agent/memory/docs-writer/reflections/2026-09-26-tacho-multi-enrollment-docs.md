## Self-Evaluation — tacho multi-enrollment docs (#4371, ADR-202) — 2026-09-26

### What I set out to do

Write the documentation half of #4371: ADR-202 and its README entry, the tacho
spec's slot rules, the published docs for `unenroll --harness/--all`,
`reassign --harness`, and `status --json` `enrollments`, the tacho package
README, and a clean `check:prose`.

### What I actually did (measurable deltas)

- New ADR-202, with five decisions, two known gaps, and five rejected alternatives. Added one entry to `docs/adr/README.md`.
- Tacho spec: added §5.8 "Enrollment slots", fixed the stale capability name and token prefix in §5.1 and §5.2, rewrote the §5.7 opener, and added acceptance criterion 26.
- `apps/docs` `wrap-an-agent.mdx`: added a "Two agents on one machine" section with four subsections, and corrected the Limits sentence that said enrollment is per machine.
- `apps/docs` `commands.mdx`: rewrote the token-on-an-enrolled-machine rules.
- `packages/tacho/README.md`: added a "More than one agent" subsection.
- Desktop spec: corrected the Uninstall bullet and three panel-table cells, then regenerated `spec.html`. The diff is limited to those cells plus the render date.
- Tested the jq sample by hand against three synthetic status documents: one enrollment, two enrollments, and a retired plus an unreadable slot.
- `check:prose` is clean on three runs, the last two through `node tools/scripts/check-prose.mjs`.
- After the advisor's review: restored the token rule for a held harness plus a new one in `commands.mdx`, fixed the harness-addition wording in `wrap-an-agent.mdx`, and traced `reassign` to `create_tacho_enrollment`. That handler mints a host row with no agent and a hostname-derived key, so a reassigned token-enrolled agent loses its registration and mandate. The docs, the README, and ADR-202's known gaps now say so.
- `readlink -f` on the primary checkout's `@oxagen/tacho` and `@oxagen/oxagen` links still points at `/Users/macanderson/Projects/oxagen/packages/`, so the stray install did not relink them.

### Quality of my decisions

- Best: I read `apps/cli/src/program.ts` before I wrote any `oxagen tacho unenroll` example. The wrapper forwards neither `--harness` nor `--all`, so every example uses `tacho` directly, and the defect goes to the parent instead of into published docs as a command that fails.
- Weakest: I ran `pnpm check:prose` in a worktree with no `node_modules`. pnpm installed, and `prepare` ran `lefthook install`, which put live hooks back into the shared `.git/hooks` against the standing rule. I renamed them to `*.disabled` within the minute. A shared lesson (line 161) already warned about pnpm's pre-script install, and I did not re-read it before the run.

### What I could have done better

1. Re-read the shared lessons after compaction, before the first `pnpm` command. The warning was already there, and `node tools/scripts/check-prose.mjs` does the same check with no install.
2. List every entry point to a command (tacho CLI, `oxagen tacho`, `oxagen agent unenroll`, desktop sidecar) at the start. I found that `oxagen tacho unenroll` drops the new flags only while writing the README, after the ADR and spec were done. The ADR's known-gaps list could have carried it from the start.
3. Audit the desktop UI strings against the new refusals sooner. `app.tsx` tells a user to run a bare `tacho unenroll` when `host.json` is unreadable, and the Uninstall confirmation names only the first agent's harnesses. I found both late and reported them instead of catching them at the planning stage.

### What surprised me about this codebase/product

- The desktop spec's panel table had drifted well beyond this change. The Wrapped agents panel is now "AI apps on this machine", and the "Unenroll… (two-step)" control is gone.
- `slotPaths` moves pid, log, and launcher paths that nothing reads from a slot. The daemon and the service use the root's copies.

### Risks I am leaving behind (untouched on purpose, and why)

- `oxagen tacho unenroll` and `oxagen agent unenroll` without an agent have no `--harness`/`--all`. That is `.ts` I was told not to touch. The README says so. If the parent fixes it, delete that sentence.
- The rest of the desktop spec's panel table is unaudited. Rewriting it needs a full pass over `app.tsx`, which is outside this task.
- Every rendered output in the docs was worked out from source. This branch's tacho was not run.

### Confidence in the result: medium-high

Every claim traces to a line in `enroll.ts`, `unenroll.ts`, `reassign.ts`,
`status.ts`, `main.ts`, `slots.ts`, `hook-process.ts`, or the desktop's
`commands.ts` and `app.tsx`. The jq sample was run against three shapes. No
binary from this branch was run.
