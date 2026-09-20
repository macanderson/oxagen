## Self-evaluation: backlog consolidation, 2026-09-19
### What I set out to do
Find small related fixes, combine their tickets, and preserve the bug checks and source links.
### What I actually did
Prepared three replacement tickets for eight source reports: guidance publishing, workspace closure and keys, and Skills counts. Each replacement includes plain bug checks and every original completion check. Source tickets close as superseded, not completed, after a comment links the replacement.
### Quality of my decisions
- Best decision: checked the price-book guard on current main and excluded a proposed pair whose old bug may already be fixed.
- Weakest decision: the first candidate list relied on file overlap before reading all completion checks and source blocker labels.
### What I could have done better
- Compare existing blocker labels before preparing each replacement.
- Read targeted completion checks first to avoid large repeated issue-body output.
### What surprised me
A small old price-book report already has its requested guard on main, so grouping it would risk preserving stale work.
### Risks left behind
This pass reorganizes work and does not prove the remaining bugs still reproduce. The price-book report remains open for a separate verification pass. Original source reports retain review quotes and historical context.
### Confidence
High once the live issue and checklist verification completes. No code changes or test runs are part of this task.
