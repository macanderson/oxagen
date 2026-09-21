## Self-evaluation: pricing read gaps, 2026-09-20

### What I set out to do
Audit remaining #3281 and #3323 findings against main.

### What I actually did
Removed the 5000-model observation cap before the price comparison. Made CLI cancellation retries report the response fallback state. Added a 5001-model regression and both no-op fallback outcomes.

### Quality of my decisions
- Best: followed the SQL instead of accepting comments that described the report as uncapped.
- Weakest: initially read the combined issue history in one oversized tool result, which hid some current findings.

### What I could have done better
- Extract outstanding DoD rows before reading the folded issue histories.
- Audit each claimed fix against its actual query before reporting it as landed.

### What surprised me
A cap described as a safety limit retained the same missing-model defect as the smaller cap it replaced.

### Risks left behind
The observation query now returns every model in its bounded time window. Query failure stays visible rather than returning a partial comparison. Scheduled rates and atomic card submission remain separate work on #3323.

### Confidence
Medium. Independent coverage audit passed. CI must run the added witnesses; no additional local tests ran.
