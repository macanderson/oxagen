---
# Onboarding — Org & Workspace Creation

- **Route:** `/new-organization`, `/{orgSlug}/new-workspace`
- **Nav location:** onboarding shell (no persistent nav; standalone flow between auth and first workspace)
- **Priority:** P1
- **Disposition vs today:** Keep

## Purpose
This is the bootstrap seam that turns a bare authenticated user into a fully-scoped tenant: creating an organization (and its default workspace) on first login, or adding an additional workspace inside an org the user already administers. It seeds everything the metering/billing loop and IAM system depend on — owner membership, default credits, agent/skill seeds — so every later capability call has a valid org+workspace scope to bind against.

## Primary user & jobs-to-be-done
- **Primary user:** New user with no org (first-run), or an existing org owner/admin adding a workspace.
- **JTBD:**
  - Create my organization and get a working default workspace without manual setup steps.
  - Add a second workspace to my org for a new team/project without re-doing org-level setup.
  - Be blocked from picking a slug that collides with a reserved or existing name.

## Functionality
Two single-form pages, no tabs:

| Route | Form fields | Server-side checks | Result |
|---|---|---|---|
| `/new-organization` | Org name, org slug | Session required; slug uniqueness | Transactionally creates org + default workspace + owner membership; bootstraps org IAM; seeds default agents, skills, environment, and starting credits |
| `/{orgSlug}/new-workspace` | Workspace name, workspace slug | Re-checks caller is owner/admin of `{orgSlug}`; blocks reserved slugs (e.g. `new-workspace`, `settings`); slug uniqueness within org | Transactional workspace create; bootstraps workspace-level IAM/environment |

Primary action: "Create organization" / "Create workspace" submit. Secondary: none (no skip/cancel — org creation is mandatory for a scoped session). Validation errors render inline under the offending field.

## Capabilities invoked
- `org.create` (`create_org`) — validates and creates the organization; runs at the pre-scope bootstrap seam via a contract-validated direct handler, not plain `invoke()` (no tenant scope exists yet).
- `workspace.create` (`create_workspace`) — validates and creates the workspace; same direct-handler pattern, re-validated against org membership.

## Data sources
- **Postgres**: `organizations`, `workspaces`, `orgUsers` writes; IAM role/permission bootstrap rows; starting credit/entitlement rows.
- Downstream of creation, seeded agents/skills may touch **Neo4j** (agent/skill graph nodes) via their own seed jobs — not queried directly by these pages.
- No ClickHouse or Blob access from these pages.

## States
- **Empty:** N/A (creation forms).
- **Loading:** Submit button disabled with spinner during transactional create.
- **Error:** Inline slug-collision / reserved-slug / validation errors; permission-denied banner if a non-owner/admin reaches `/{orgSlug}/new-workspace` directly.

## Existing implementation
- **Today:** `apps/app/src/app/(onboarding)/new-organization/page.tsx` + `actions.ts` — complete. `apps/app/src/app/[orgSlug]/new-workspace/page.tsx` + `actions.ts` — complete. Both reusable as-is.

## Vision alignment
Org/workspace creation is where BYOK and starting-credit seeding first enter the metering→billing loop — every unit billed later traces back to the tenant scope created here. P1: no capability, contract, or bill can exist without it.
