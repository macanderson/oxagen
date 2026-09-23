## Self-Evaluation — context-graph-protocol PR #198 (actions/checkout 5 to 7 plus scaffold pin guard) — 2026-09-22
### What I set out to do
Review head c96483e adversarially. By then the Dependabot bump also carried a hand-written guard, `.github/scripts/check-scaffold-action-pins.py`, and both scaffold template bumps.
### What I actually did (measurable deltas)
- Verified the v7.0.1 SHA pin (lightweight tag on 3d3c42e, node24 runtime) and both template bumps.
- Probed the guard's regex with 9 pin shapes. Quoted values, prose after `#`, and subpath actions all match nothing and pass silently.
- Found open PR #194 adding a divergent copy of the same script at the same path, and open PR #197 that turns main red once this guard lands, since the `main` ruleset has no required status checks.
- Posted review 5286269978 with 3 P2 findings and 1 P3.
### Quality of my decisions
- Best: listing every open sibling Dependabot PR and diffing their file lists. That surfaced both cross-PR defects, which reading this diff alone could not show.
- Weakest: I sized the #197 red-main finding at P2. It will break main for every PR, but the guard is doing its designed job and one commit fixes it. A P1 case exists, and I did not get a second opinion because the advisor was rate-limited.
### What I could have done better
- Check the ruleset for `required_status_checks` first on any PR that adds a CI gate. Whether stale green siblings can merge past a new gate depends on it.
- Run the guard itself against a temporary copy of the tree with a template set to v5, to prove its red path, instead of reasoning about it from the regex.
### What surprised me about this codebase/product
Two fixer agents independently wrote the same guard, at the same path, for two sibling Dependabot PRs within an hour. The fleet has no lock on "the fix for residue X".
### Risks I am leaving behind (untouched on purpose, and why)
Neither guard copy has a self-test that proves it fails red. I did not raise that as a finding because the repo's other offline guards do not have one either.
### Confidence in the result: high
The regex behaviour was probed in Python. The sibling PR heads, rulesets and file contents were read through the API.
