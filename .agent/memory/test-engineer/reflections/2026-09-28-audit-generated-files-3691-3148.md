## Self-Evaluation — audit lane "Generated files" (#3691, #3148) — 2026-09-28
### What I set out to do
Check each DoD item the builder marked done against the diff. Confirm by reading that each regression test fails before the fix and passes after it. Look for untested changed behaviour and fix it.
### What I actually did (measurable deltas)
- Rebuilt both two-branch merge scenarios in Python with real `git merge` in the scratchpad. Under the new shape both merged clean and byte-equal to regenerating. Under the legacy shape both conflicted, and every conflict hunk sat on contentHash or tableCount, which is exactly what merge.test.ts asserts.
- Traced every expected string in drift.test.ts and capability-schema-docs.test.ts through canonicalJson and firstDifference by hand.
- Found one untested changed behaviour: archdocs `collectManifest` now derives tableCount and contentHash, with no test. Added 2 tests.
- Added 3 driftReport tests for branches in cli.ts: end-of-file display, a null store entry, and equal texts. The database package's branch floor is 90.
- Corrected #3148 to closes=false. Two DoD items need the integrator's regeneration and a live CI run, and the batch rule says to cite such an issue as Refs.
### Quality of my decisions
- Best: simulating the git merges instead of trusting the builder's claim. The whole #3691 proof rests on git's hunk adjacency, which is easy to get wrong by reading.
- Weakest: I could not re-read the issue comments on GitHub. No MCP tool was surfaced in this session, so I relied on the scout's verbatim DoD.
### What I could have done better
- Check coverage deltas per file against the package's current measured numbers, not only by branch counting. I had no coverage report to read.
- Grep the whole repo for readers of a removed field before the source review. I did it midway, and it was the step that found the collectManifest gap.
### What surprised me about this codebase/product
The archdocs site reads the storage manifest through its own local type copy in tools/scripts/lib/archdocs/collect.ts, so a change to the manifest's shape does not break typing there.
### Risks I am leaving behind (untouched on purpose, and why)
- The committed storage-manifest.json and docs/capabilities/schemas outputs still carry the old fields. The integrator owns regeneration under the batch rules.
- Earlier, the builder's accidental commit with hooks on ran lefthook's install into the shared .git. I left the hooks as they are and reported it.
### Confidence in the result: medium-high
Evidence: the git merge simulations reproduced the tests' claims, and I traced every expected string. Nothing has run in vitest yet. CI is the first run.
