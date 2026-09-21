## Self-evaluation: legacy backfill email, 2026-09-20

### What I set out to do
Stop the remaining legacy telemetry backfill from writing readable email addresses for #3072.

### What I actually did
Removed the environment-derived address and the output field. Added a real-parser regression that compares two transcripts with different email metadata and checks preserved token counts.

### Quality of my decisions
- Best: separated producer retirement from historical store deletion, so this fix does not depend on destructive migration approval.
- Weakest: initially treated the legacy backfill as status evidence instead of fixing its remaining write immediately.

### What I could have done better
- Search operational scripts alongside runtime producers in the first pass.
- Verify actual historical SQL before repeating issue claims about table names and TTLs.

### What surprised me
The legacy migration filename names a table it never created. The later session table already has a two-year TTL.

### Risks left behind
Historical readable addresses remain until forward migrations erase the retired columns and replace the legacy table sort key. Concrete drafts are recorded separately and were not applied.

### Confidence
Medium. Independent review and git hooks check this source change. CI must execute the new regression because this batch already used its one local test allowance.
