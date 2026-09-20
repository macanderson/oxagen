## Self-evaluation: knowledge backlog, 2026-09-19

### What I set out to do

Audit the remaining non-engram rows of #2974 on fresh main and fix the request, transaction, and connector failures.

### What I actually did

Added bounded GitHub retries and deadlines, tenant-filtered credential lookup, managed Neo4j transactions and the Calendar record-type correction. Peer review exposed repository-local identity collisions, so organization polling changes were removed for a dedicated compatibility fix. Added regressions and ran one test file with 7 passing tests.

### Quality of my decisions

The strongest decision was reading current source before trusting the backlog. Several urgent descriptions were already obsolete. The weakest was reading large source files in one tool result, which truncated relevant details and required narrower reads.

### What I could have done better

- Separate the initial source audit by issue row to avoid truncated output.
- Check the branch upstream before the first push. This checkout inherited upstream push behavior from main, so the explicit HEAD destination was needed to publish the branch.

### What surprised me

The OAuth account table is organization-scoped, so the backlog's requested workspace predicate does not exist on that table. The source-connection query supplies that boundary.

### Risks left behind

Live embedding capacity and resync remain unverified. Engram work remains deferred. Older performance and connector configuration rows are recorded in the audit artifact. CI must run the unexecuted tests.

### Confidence

Medium. The focused request tests pass. Independent audit and CI remain required before completion.
