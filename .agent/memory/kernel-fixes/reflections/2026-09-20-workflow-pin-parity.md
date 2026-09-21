## Self-evaluation: workflow pin parity, 2026-09-20
### What I set out to do
Implement the maintainer's resolved-file comparison and coordinated update policy.
### What I actually did
Used the existing blob-resolution path for both workflow checks. Added same-file and changed-file regressions and recorded the ADR amendment.
### Quality of my decisions
- Best decision: reuse the close-guard comparison already in this script.
- Weakest decision: assumed every caller had Dependabot configured before reading their default branches.
### What I could have done better
- Inventory caller configuration before preparing the coordinated change.
- Read the latest decision comment before interpreting the older issue proposal.
### What surprised me about this codebase
Only Stella currently configures Dependabot. The other callers need an explicit actions entry to carry the exclusion.
### Risks I am leaving behind
The next scheduled Dependabot update and post-merge parity run are future evidence. Pinned workflow steps still fetch checker logic from main as the ADR records.
### Confidence in the result: medium
Independent test-engineer review found no blocking gaps. Tests remain for CI under the shared local test limit.
