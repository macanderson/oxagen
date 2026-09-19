## Self-evaluation: repository docs cleanup, 2026-09-19

### What I set out to do
Remove stale and redundant tracked documentation, focusing on docs/, apps/docs, and the root agent instructions.

### What I actually did
Compared internal indexes and published instructions with current source. Removed 43 redundant internal documents and three obsolete published guides. Corrected the capability reference names and index. Consolidated CLAUDE.md and corrected contributor, review-template, and agent-definition guidance. Retained dated decisions and marked old app designs and decks historical.

### Quality of my decisions
- Best decision: divide the audit by owned paths, then review the combined changes against source and preserved-file checks.
- Weakest decision: the first root edit replaced punctuation mechanically and produced sentence fragments. I reverted punctuation-only changes and rewrote the affected sentences before committing.

### What I could have done better
- Inventory file counts and read targeted sections before loading large collections. Initial output truncation wasted time.
- Use explicit git -C paths for escalated worktree commands from the start. The first push did not publish the intended branch.

### What surprised me about this codebase/product
The capability filenames still use old dotted stems while registered names no longer accept them. The current collector already implements behavior the README called future work.

### Risks I am leaving behind
Historical specs retain their original proposals and snapshots under explicit historical notices. This task verifies source and documentation integrity; it does not prove every deployed service matches the checkout. CI owns builds and test suites.

### Confidence in the result
High for the corrected names, paths, declared surfaces, removed duplication, and documented source behavior. Full CI and deployment behavior require their separate evidence.
