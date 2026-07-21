## Self-Evaluation — Enterprise Agent IAM Phase 1 Plan — 2026-07-21

### What I set out to do

Turn the approved enterprise IAM/RBAC design into a repository-native, executable Phase 1 implementation plan without changing production code. The plan needed to establish the identity and policy foundation for human, agent, and service principals while preserving the approved Phase 2-5 boundaries for durable delegation, graph enforcement, the editable Permissions UI, access reviews, and signed evidence.

### What I actually did (measurable deltas)

- Expanded the implementation plan to 15 ordered, independently commit-ready TDD tasks covering the authorization model, resolver, capability metadata, schema/migrations, hierarchical tenant scope, transactional evidence, principal lifecycle, role versions, approvals, kernel cutover, ClickHouse projection, read models, management contracts, API/MCP parity, and guarded pre-launch reset.
- Added exact file inventories, interfaces, failing-test expectations, focused commands, pass criteria, and commit boundaries for every task.
- Clarified the approved specification around unconditional principal identity, Phase 1 singleton runtime authority, the tenant-bootstrap exception, system-role eligibility/migration, complete-input authorization hashes, and policy-version serialization.
- Corrected eight review findings plus the follow-up issues: a stale-policy admission race, incomplete agent/API-key writer coverage, approval-hash redaction collision, bootstrap scope impossibility, partial principal uniqueness, untrusted principal chains, incomplete role migration, unsafe database-target output, missing system-policy bootstrap, and a non-running app test path.
- Kept production code and migrations untouched; validation was documentation/path/command oriented.

### Quality of my decisions

- Best: I preserved one non-bypassable IAM spine while making the rollout implementable in buildable stages. The policy-version row now coordinates both mutations and admission, and the plan distinguishes complete authorization-binding hashes from redacted audit-display hashes.
- Best: I narrowed Phase 1 runtime authority to a server-resolved singleton rather than inventing an untrusted delegation chain before `RunSpecV2`, while still freezing chain intersection in the pure resolver and simulator.
- Weakest: The first complete draft missed several existing direct writers and assumed the old IAM seeder could satisfy new-organization bootstrap. Those omissions would have left either migration failures or a security bypass without the independent code review.

### What I could have done better

- I should have run the repository-wide `schema.agents`, `schema.apiKeys`, and creator-based API-key reader sweep before writing Task 7, not after the first review. Doing that earlier would have produced a complete lifecycle cutover inventory on the first pass.
- I should have modeled policy mutation and runtime admission around the same lock/CAS primitive from the outset. Treating decision persistence as a separate audit step briefly left a revoke-versus-allow race in the plan.
- I should have checked each proposed test path against the owning Vitest include configuration while drafting commands. The root-level app instrumentation test would otherwise have passed with no test collected.

### What surprised me about this codebase/product

Oxagen already has multiple security-sensitive bootstrap and credential seams outside the obvious capability handlers: duplicated onboarding organization creation, built-in workspace agent seeding, public CLI PKCE token exchange, creator-based org/workspace readers, and privacy projections. The enterprise IAM cutover is therefore less about adding tables than proving that every identity writer and authority reader converges on one lifecycle service and one kernel decision path.

### Risks I am leaving behind (untouched on purpose, and why)

- The 15 tasks are intentionally not implemented in this documentation turn; schema resets, RLS changes, and kernel cutover need the plan's test-first, staged execution and review checkpoints.
- Property-level IAM remains out of scope because it would require authorization before predicate evaluation, ranking, embeddings, citations, exports, replay, and logs—not a UI-only field filter.
- Persisted multi-principal delegation and durable run snapshots remain Phase 2 work. Shipping an ad hoc chain in Phase 1 would create a caller-controlled authority path.
- Graph/context and tool enforcement remain Phases 3 and 3B, and the editable Permissions UI remains Phase 4. Phase 1 stores and resolves grants but deliberately does not claim those downstream enforcement or UI surfaces.
- Performance thresholds in the plan are acceptance targets for the documented local fixture, not measured results; implementation must capture evidence before making performance claims.

### Confidence in the result: high + evidence

High. The final documents pass whitespace, placeholder, task-count, and planned-path validation; a code-review agent completed two severity-ranked passes and confirmed the original security blockers were substantively addressed before the final precision fixes. Confidence applies to plan coherence and repository alignment, not to unimplemented runtime behavior.
