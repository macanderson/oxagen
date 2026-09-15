# context.pr.merge

**Name:** `merge_context_pr`
**Domain:** context
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** high (requires approval on the agent surface)
**Billing:** `noBillingGate: true`
**Mutates:** yes
**Roles:** by governance mode, checked by the handler (INV-29) — see below

## Intent

Merge is the publication ([ADR-061](../adr/ADR-061-steering-governance-mode-thresholds-and-the-reflector.md); MC spec §10.3 steps 3–4). Refused until every check passed. Refused unless the caller is a reviewer the governance mode allows, read from `.oxagen/rules/governance.toml` on the production branch at merge time:

| mode | who merges |
| --- | --- |
| `solo` | any workspace member (org Owner/Admin, workspace Owner/Member), the author included |
| `team` | an org Owner or Admin, or a workspace Owner, other than the author |
| `regulated` | an org Owner or Admin other than the author; recorded on the ledger row as the accountable approver |

The PR is merged on GitHub first (squash; GitHub's own branch protection applies). Only a merge GitHub confirmed publishes the record: the registry row (`agent.context_records`) gains the classification and the merge commit, a new immutable version holds the file as merged, the promotion event is appended to the hash-chained ledger (`agent.context_promotions`, `action = promote`, `policy_version = governance:<mode>`), the proposal moves to `merged`, and `steering.published` is emitted to the audit log.

The workspace's steering version is the ledger length; a merge bumps it by one. Delivery into the signed policy bundle and into context frames (spec §10.4) reads that version and is outside this lane.

## Input

`{ proposalId: prp_… }`

## Output

| Field | Type | Notes |
| --- | --- | --- |
| `proposalId` | `string` | |
| `status` | `"merged"` | |
| `record` | `{ id (ctr_…), lineageId, version, path }` | The published record and the version this merge created |
| `mergedCommit` | `string` | GitHub's merge commit |
| `promotionEvent` | `{ id (ctp_…), seq, chainDigest }` | The ledger entry |
| `bundleVersion` | `{ before, after }` | The ledger length before and after |

## Errors

| code | reason | meaning |
| --- | --- | --- |
| `not_found` | `proposal_not_found` | |
| `conflict` | `already_merged` / `checks_not_passed` / `pr_not_recorded` / `governance_unreadable` / `record_file_missing` | |
| `conflict` | `github_refused` | GitHub refused the merge (a required review, a moved head); nothing is published. |
| `forbidden` | `no_principal` / `org_role_required` / `separation_of_duties` | The governance mode's reviewer rule. |
