## Self-Evaluation — Z2 lane "Checks that pass empty" audit (#3490, #3678, #3074, #3680) — 2026-09-28
### What I set out to do
Audit the builder's lane: check each done DoD item against the code, and check that each regression test fails before its fix and passes after it. No test could run.
### What I actually did (measurable deltas)
- Walked 11 new findGaps cases through the AST reader by hand. The 7 negative cases fail under the old regex, and the 4 positive cases guard against over-restriction.
- Found one vacuous test: "resolve_mcp_servers (#3490)" passed under the old script too, because the old script never read the packages/agent handler. Added a case that resolves the contract through the real register.ts and LOADERS and asserts the gate. Commit 393601a45.
- Ran the read-only integrity script: 173 contracts checked, 13 baseline stems, no gaps. A scratch script confirmed that no restricted contract resolves with a null export (which would scan every export).
- Ran the pure functions (checkClosingKeywords, dodStatus, verdict) by hand against both fixtures, and ran INK against the vendored kit tokens. All expected values matched.
### Quality of my decisions
- Best: asking whether each "not a gap" assertion would also pass under the broken check. That is the question this lane exists for, and one test failed it.
- Weakest: I could not confirm that #4168 shipped green (the history is shallow and I had no GitHub tool), so I kept the builder's #3680 closes claim with a caveat and did not verify it.
### What I could have done better
- Mutation-probe the new reader (remove the follow() hop, remove the alias map) with scratch copies, instead of only walking the tests by hand.
- Check turbo.json inputs: role-check.test.ts in packages/handlers now imports tools/scripts/lib/role-gate-ast.mjs, and a change to that file alone will not bust the handlers test cache. I noted this but did not fix it.
### What surprised me about this codebase/product
The git history in the worktree starts at #4487, so `git log --follow` cannot date older guard scripts.
### Risks I am leaving behind (untouched on purpose, and why)
- Turbo cache for the handlers test ignores role-gate-ast.mjs (shared turbo.json, not this lane's file).
- The reader counts any value reference to a gate, not only a call. That is broader than INV-29's old call-only rule, and it is documented.
### Confidence in the result: medium (nothing ran in CI yet; fixture and pure-function checks were done by hand)
