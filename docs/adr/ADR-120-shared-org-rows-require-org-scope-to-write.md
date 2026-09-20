# ADR-120: Shared organization rows require organization scope to write

Status: Accepted

Date: 2026-09-19

Refs #2972, absorbed #2822.

## Context

The `workspace_nullable` row-level security policy let a workspace call write `workspace_id = NULL`. An update could turn a workspace role assignment into an organization assignment. Its shared-row read predicate also applied to DELETE, allowing a workspace call to delete an organization row it could read.

ADR-086 established `withOrgDb` as the explicit organization seam. It clears the workspace setting and can write organization rows while its separate SELECT policy reads across workspaces. A workspace call should not gain the same write authority just because a column is nullable.

## Decision

For nullable workspace tables, INSERT and UPDATE require the current workspace to match the row. A null-workspace row requires a cleared workspace setting, as supplied by `withOrgDb`. The same predicate governs the old rows of UPDATE and DELETE.

A separate SELECT-only policy keeps organization rows visible to workspaces in that organization. Visibility grants no permission to mutate those rows. The organization fence remains on every policy. System operations retain their existing bypass; this change does not redesign database-role provisioning.

Generate a new migration for the ten nullable-workspace tables from the policy manifest. Preserve previous migrations. Verify the behavior as the real non-superuser application role: refuse promotion into organization scope, refuse organization-row insertion and deletion from a workspace, and permit writes within the selected workspace. Existing tests cover explicit organization writes, cross-organization isolation, shared reads, and the invalid organization-only workspace sentinel.

For authorized operations that create a workspace agent and its organization role assignment atomically, `withTransactionOrgScope` narrows only the role-assignment mutation to an empty workspace setting inside the existing transaction. It keeps the organization fence and bypass setting unchanged. A savepoint restores the previous workspace on failure; success restores it explicitly before workspace writes resume. This exception requires the caller’s existing authorization and does not permit writes to other workspaces.

## Consequences

A writer of organization-level rows must use the organization seam deliberately. A writer that relied on workspace scope to mutate those rows will now fail. The migration changes policies and does not rewrite table data. Production application remains a separate operational step after CI and review.
