## Cut values and hover card coverage audit
PR #4758, issues #4692 and #4674, 2026-09-29.
### What I set out to do
Find, for each behavior commit b6bc8ddcb4 changed, the test that fails when the change is reverted. Add tests where none would fail. Check the PR body's Verification claims against the tests. Nothing could run.
### What I actually did (measurable deltas)
- Mapped 22 behaviors to covering tests: six data-truncate sites, the cut rule in cell-overflow, the operator close timer, nine action groups, the CSS rules and the SSO wrap.
- Tightened 3 tests that passed with the change reverted or aliased: the tool argument (presence only), the diff digest (a sha256 regex the pull request's own digest also matched), and the tool name (any descendant with the mark).
- Added 1 cell-overflow test and 1 assertion for a mark equal to the shown text, which is cut only when it overflows.
- Added 2 operator tests for the focus fix the lead made mid-audit: focus drops a pending close, and focus held after the pointer leaves keeps the card open until blur.
- Found 2 Verification claims that did not hold as written, and one P3 in the seal label.
### Quality of my decisions
- Best: asserting the fixture's digest instead of the digest's shape. The shape regex matched two digests in the same card.
- Weakest: I asserted the tool argument's mark equals the shown line, which pins a wart (the card can never show more than the row) rather than the intent in #4692. I documented it in the test comment and the report instead of changing source.
### What I could have done better
- Read transcript-rows.ts callArg before the view. It shows at once that the mark holds the cut line, which reframes two of the six sites.
### What surprised me about this codebase/product
The transcript's "whole value" is already shortened twice before the mark sees it: tool-detail.ts cuts paths to two segments, and closedLine collapses whitespace and caps at 320.
### Risks I am leaving behind (untouched on purpose, and why)
- The seal label at transcript-view.tsx:1193 compares a raw label against its closedLine text, so a label with a newline counts as cut and takes a tab stop. Source was out of scope for this lane.
- The cardRef branch of the operator's close guard cannot be reached, because nothing in the card takes focus.
### Confidence in the result: medium (tests follow existing patterns, none has run in CI)
