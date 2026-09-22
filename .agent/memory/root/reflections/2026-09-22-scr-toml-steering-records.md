## Self-Evaluation — SCR toml steering records — 2026-09-22
### What I set out to do
Convert the six SCR markdown records into context-record TOML in the oxagen repository only, remove `docs/scr/` from all five org repos, and open a pull request.
### What I actually did (measurable deltas)
Added six stamped `.oxagen/rules/ctx.scr.*.toml` files, deleted `docs/scr/` in oxagen, retargeted the harness summary in `AGENTS.md`, and changed `scr-corpus-check` so a leftover `docs/scr/` file fails. Opened oxagen #3704. Prepared the same removal in the other four repositories and could not push it.
### Quality of my decisions
- Best decision I made and why: stamped `record_id` and `record_hash` with the same JCS preimage the existing rules use, and checked it against `ctx.product.do-not-re-read` before writing the six files.
- Weakest decision I made and why: I described sibling pull requests in the first PR body before the push to those repositories had succeeded.
### What I could have done better
- Check write access to the other four repositories before editing their clones, so the PR body never claimed pulls that do not exist.
- Run `pnpm --filter @oxagen/scripts test:unit scr-corpus-check.test.ts` once dependencies were available, instead of only the node assertions of `buildReport`.
### What surprised me about this codebase/product
Stella's `scripts/check-priority-scheme.py` treats `docs/scr/SCR-005` as the file that declares P0 through P4. Deleting that file is not a documentation edit there. The guard has to fall back to the scheme the Oxagen record states.
### Risks I am leaving behind (untouched on purpose, and why)
The other four repositories still carry `docs/scr/`. This agent's credential can push `macanderson/oxagen` and is denied on the others. The check on oxagen will stay red until someone who can push those repositories removes the directories. The prepared edits were not saved, because the clones lived only on this machine.
### Confidence in the result: medium + evidence
The oxagen records match the file format and the hash of an existing rule. The absence check's three cases passed in a node run. The four sibling repositories are not updated on GitHub.
