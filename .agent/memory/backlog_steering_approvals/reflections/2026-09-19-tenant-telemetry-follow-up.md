## Self-evaluation: Tenant and telemetry follow-up, 2026-09-19

### What I set out to do

Fix the remaining tenant attribution, ClickHouse breaker, and security-event retention defects in a fresh worktree.

### What I actually did

Added client-level breaker leases, four tenancy corrections, a partition restoration migration, and a daily maintenance adapter. The one local test file passes 8 cases. Added database and kernel regressions for CI.

### Quality of my decisions

The strongest decision was withholding direct child grants. Copying them would let later parent-policy changes leave stale child access. The weakest decision was drafting the migration before completing the ownership and default-privilege inventory, which required revising its grants.

### What I could have done better

- Read the migration role and default grants before writing the security helper.
- Check the existing kernel empty-scope expectation before adding the new error code.
- Separate repository-root commands from package-local Atlas commands. One mixed invocation wrote no ADR because its working directory was wrong.

### What surprised me

The audit table already had the composite key needed for partitioning, while its Atlas baseline and scheduled job disagreed about the table kind.

### Risks left behind

The migration and database fixtures still need CI and reviewed deployment. Separate system credentials, the bypass baseline, billing durability, and the other umbrella rows remain outside this bounded change.

### Confidence

Medium. The focused breaker cases pass, and independent review checks the source. Database migration behavior needs the CI services before this change can be called ready to merge.
