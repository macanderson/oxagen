---
# Org Settings

- **Route:** `/{orgSlug}/settings` (tabs: General · Privacy)
- **Nav location:** org → Settings
- **Priority:** P2
- **Disposition vs today:** Keep (collapse legacy Billing/Members redirect shims)

## Purpose
Settings holds the org's basic profile (name, slug, avatar) and its GDPR data-rights controls (export, erase). It's the smallest and least wedge-specific page in the Governance/Billing/Developer set, but it's still where trust-relevant actions like data erasure live, so it deserves the same rigor as anything else touching identity or compliance.

## Primary user & jobs-to-be-done
- **Primary user:** Org owner/admin
- **JTBD:**
  - Update the org's display name, slug, or avatar.
  - Understand what changing the slug does to existing links (slug-history handling).
  - Export the org's data for GDPR compliance.
  - Erase the org's data under GDPR, with appropriately stricter gating than export.

## Functionality
- **General tab:** org profile form — name, slug (with uniqueness check), avatar upload. Slug changes write transactionally to an org-slug-history table so old links don't silently 404.
- **Privacy tab:** GDPR export action (initiate export job, poll status, download link when ready) and GDPR erase action (stricter confirmation flow, distinct role gate). Status polling includes a cross-org ownership check to prevent one org polling another's job by guessing an ID.
- Legacy `settings/billing` and `settings/members` routes are permanent redirect shims to `/billing` and `/members` respectively — collapse/delete these once nav links are updated to point directly at the new locations.

## Capabilities invoked
- `org.settings.read` (`get_org_settings`) — load current profile.
- `org.settings.write` (`update_org_settings`) — save profile changes (name/slug/avatar).
- `privacy.data.export` (`export_data`) — GDPR export, gated `assertOrgMember`.
- `privacy.data.erase` (`erase_data`) — GDPR erase, gated `assertSecurityManager` (stricter than export).

## Data sources
Postgres (org profile table, org-slug-history table, export/erase job status).

## States
- **Empty:** n/a — org profile always exists once created.
- **Loading:** skeleton form fields on General; export/erase status shows a polling spinner until job completes.
- **Error:** slug-uniqueness conflict shows inline field error; erase-gate failure (wrong role) shows a clear permission-denied message rather than a generic error.

## Existing implementation
- **Today:** `settings/general` is COMPLETE (profile name/slug/avatar, slug-uniqueness + `orgSlugHistory` transactional write). `settings/privacy` is COMPLETE (export `assertOrgMember`, erase `assertSecurityManager` stricter, cross-org IDOR check on status polling). `settings/billing` and `settings/members` are legacy `permanentRedirect` shims to `/billing` and `/members` — collapse/delete once nav points directly at the new routes.
- **Note:** `org.settings.*` and `privacy.*` contracts are invoked from the app but omit `app` from `layers[]` — reverse-parity gaps worth declaring.

## Vision alignment
Governance/trust surface: GDPR erase/export is a concrete trust-moat commitment, and org profile identity underlies every other surface. P2 because it's necessary hygiene, not itself a wedge differentiator.
