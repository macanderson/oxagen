## Self-evaluation: Tacho WAL string limit: 2026-09-19
### What I set out to do
Diagnose repeated daemon tick failures and interrupted model response logs.
### What I actually did
Found a 550,853,544-byte local body file and whole-file UTF-8 reads in the WAL. Replaced WAL scans with incremental decoding and retention rewrites with incremental temporary-file writes. Passed 15 WAL tests and scanned the oversized live file read-only in 1.18 seconds.
### Quality of my decisions
- Best decision: inspect file sizes without printing recorded prompts or deleting evidence.
- Weakest decision: the first UTF-8 regression assertion ignored the field containing the boundary character. The test audit caught it before commit.
### What I could have done better
- Use non-login shells immediately in isolated worktrees. The login shell reset the requested working directory.
- Assert decoded boundary content from the first version of the test.
### What surprised me about this codebase
Body retention and shipment both decoded entire session files, despite per-body capture limits.
### Risks I am leaving behind
The daemon still needs an updated build. The read loop remains synchronous and can block during large scans. A single oversized record still needs memory proportional to its length. Proxy aborted logs require separate attribution because client cancellation can also trigger them.
### Confidence in the result
High for removing whole-file string allocation, supported by focused tests and a scan of the incident file. Runtime recovery and CI remain unverified.
