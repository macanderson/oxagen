## Self-Evaluation: stale squash audit, 2026-09-19

### What I set out to do
Reconstruct #3485's historical merge audit and verify the documented failure mechanism.

### What I actually did
Fetched 161 retained PR heads, reconstructed 442 baselines, retained 588 raw file signals, and obtained independent dispositions for 87. Corrected the known incident to an integration-resolution loss. Added reproducible tooling and isolated Git fixtures.

### Quality of my decisions
- Best decision: inspect the preserved integration parents before accepting the ADR's squash explanation.
- Weakest decision: begin with exact-line signals without planning a disposition budget. Formatting produced hundreds of rows.

### What I could have done better
- Define independent review partitions before collecting the candidate corpus.
- Retain a frozen endpoint and raw artifacts at the start of the original audit, which would have made its counts reproducible.

### What surprised me
The offending branch already contained the fix commit. An up-to-date requirement alone would not establish that its resolution preserved the fix.

### Risks left behind
501 raw records lack independent dispositions. The first-parent collector is deliberately bounded and does not claim full semantic coverage.

### Confidence
High in the incident correction and reproducible candidate counts. Limited in any broader no-regression claim, which this report does not make.
