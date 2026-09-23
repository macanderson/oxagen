## Self-Evaluation — stella #6552 SCR-006 prose rewrite review, round 1 — 2026-09-22

### What I set out to do
Adversarial review of a docs-only PR that rewrites SCR-006 so stella's prose gate accepts it and registers the record in `docs/manifest.json`.

### What I actually did (measurable deltas)
- Verified the PR's gate claims read-only: old text grade 11.02, new 4.75, `check-prose.py --absolute` green; #6550's manifest hunk byte-identical; every CI bucket pass or skipping on a real run.
- Found that oxagen's ADR-137 (dated the same day) retired the `docs/scr` corpus and that the PR body's residue plan cites a function (`divergeAgentsSummary`) that no longer exists on oxagen `origin/main`.
- Found one rewritten sentence that contradicts stella's own compiled bullet and is false in stella (no label automation).
- Posted review 5285375650 with two P2 and two P3 comments.

### Quality of my decisions
- Best: reading oxagen's `origin/main:` rather than the local checkout for cross-repo claims. The local tree still carried the retired corpus check and would have led me to confirm the PR body's residue plan.
- Weakest: I initially leaned toward P1 for the ADR-137 conflict. The PR adds no new `docs/scr` file, so it trips no gate that `main` did not already trip; the advisor's P2 was right.

### What I could have done better
- I read stella's `docs/scr/README.md` (which still describes byte-identical replication) before checking whether oxagen still honoured it. Order the cross-repo source-of-truth check before trusting a repo-local README.
- I spent a batch grepping the stale local oxagen script for function names before fetching `origin/main`; one `git fetch` first would have saved a round.

### What surprised me about this codebase/product
Stella's grade ratchet drops sentences under three words, so two-word fragments neither help nor hurt the score; a rewrite that chops to fragments is gaming nothing and only hurts the reader.

### Risks I am leaving behind (untouched on purpose, and why)
- Stella still carries seven `docs/scr` files that oxagen's corpus check flags daily; deleting them is a maintainer-scoped change and #6548 asked for the red-main repair to land alone.
- The record title says "before its deploy" and the compiled bullet says "before or with"; pre-existing and moot once the file is deleted under ADR-137.

### Confidence in the result: high
Every claim in the posted comments traces to a command output in this session (blob SHAs, `rg` counts, grade probe, ADR text on `origin/main`).
