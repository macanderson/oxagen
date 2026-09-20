## Self-evaluation: approved call resumption, 2026-09-19

### What I set out to do

Complete #3127's stored-call continuation under fresh authorization.

### What I actually did

Added encrypted stored arguments, conversation-scoped deduplication, a durable claim, a periodic worker, current admission checks, linked run evidence, and execution readback. Added 17 isolated worker regressions plus PostgreSQL, kernel, resolver, and component checks for CI.

### Quality of my decisions

The durable claim precedes dispatch. A crash cannot cause the worker to repeat the invocation. The weakest early design stopped at checking a preflight parse. The kernel now checks the exact final parsed value against the stored digest too.

### What I could have done better

I should have checked dedicated-plane discovery before the first commit. A shared system scan cannot discover rows on a dedicated tenant database.

I should have checked the encryption key format before the first test run. The fixture initially supplied hex to a base64 loader.

I should have distinguished in-app human contexts from delegated agent contexts before sketching mandate reconstruction. Preserving the existing effective principal avoids manufacturing authority.

### What surprised me

The in-app evidence run records the assistant identity while its capability calls retain the human requester's context.

### Risks left in scope

An external effect and a Postgres status update cannot share one transaction. An interrupted invocation is indeterminate and requires inspection. External MCP approvals keep their existing wait path. Production migration and full verification belong to CI and deployment review.

### Confidence

Medium. The isolated worker regressions pass. Real database and surface checks remain for CI.
