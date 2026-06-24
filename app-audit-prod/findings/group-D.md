# Security & Access Pages Audit — Group D

## Summary
- **7 of 14 pages successfully audited** (7 access pages did not load due to Playwright session crash)
- **3 preview/mock pages found:** sec-compliance, sec-audit, sec-incidents
- **3 React #418 errors on access pages:** acc-sessions, acc-policies, acc-roles (minified error, real data loaded)
- **3 routing issues:** acc-sessions, acc-policies, acc-roles redirect to /default/ask instead of target routes

## Security Pages (7/7 complete)

## sec-mfa — /thomas-anderson-mac/security/mfa
- Status: REDIRECT → /thomas-anderson-mac/billing
- Preview/mock: NO
- Console: none
- Screenshot: sec-mfa.png
- Bugs: **HIGH** — Route redirects to Billing page instead of MFA security settings. Page shows billing usage, not MFA controls.
- Notes: Auth state may not have correct org/workspace access to security features.

## sec-compliance — /thomas-anderson-mac/security/compliance
- Status: OK
- Preview/mock: YES "preview"
- Console: none
- Screenshot: sec-compliance.png
- Content: SOC 2 Type II compliance checklist with multi-item framework (8 sections). Text contains "SOC 2 Type II", "audit", "report", "controls", "attestation".
- Bugs: **MEDIUM** — Page contains "preview" text; unclear if checklist is live or static demo data.

## sec-trust — /thomas-anderson-mac/security/trust
- Status: OK
- Preview/mock: NO
- Console: none
- Screenshot: sec-trust.png
- Bugs: None observed.

## sec-audit — /thomas-anderson-mac/security/audit
- Status: OK (with error)
- Preview/mock: YES "preview"
- Console: **1 ERROR** — React #418 (minified error, likely missing prop or invalid element)
- Screenshot: sec-audit.png
- Content: Audit log with real event data. Lists auth_sign_in, auth_sign_up, billing_plan_changed, etc. with timestamps and user info.
- Bugs: **HIGH** — React #418 minified error; page shows "Audit log export is an Enterprise feature" banner. Page renders but has console exception.

## sec-sso — /thomas-anderson-mac/security/sso
- Status: OK
- Preview/mock: NO
- Console: none
- Screenshot: sec-sso.png
- Bugs: None observed.

## sec-incidents — /thomas-anderson-mac/security/incidents
- Status: OK (with badge)
- Preview/mock: YES "PREVIEW"
- Console: none
- Screenshot: sec-incidents.png
- Content: Security incident list with status badges (e.g., "recent incidents"), colored labels. Shows multi-line incident descriptions.
- Bugs: **MEDIUM** — Page displays "PREVIEW" badge/label; unclear if incidents are live or sample data.

## sec-scim — /thomas-anderson-mac/security/scim
- Status: OK
- Preview/mock: NO
- Console: none
- Screenshot: sec-scim.png
- Bugs: None observed.

## Access Pages (4/7 audited; 3 did not load due to session crash)

## acc-sessions — /thomas-anderson-mac/access/sessions
- Status: REDIRECT → /thomas-anderson-mac/default/ask
- Preview/mock: NO
- Console: **1 ERROR** — React #418
- Screenshot: acc-sessions.png
- Content: Page redirects to Ask/chat interface instead of displaying session management.
- Bugs: **HIGH** — Route does not exist or is not mounted. User navigated to chat/ask instead of access/sessions. React #418 error indicates render failure.

## acc-policies — /thomas-anderson-mac/access/policies
- Status: REDIRECT → /thomas-anderson-mac/default/ask
- Preview/mock: NO
- Console: **1 ERROR** — React #418
- Screenshot: acc-policies.png
- Content: Page redirects to Ask/chat interface instead of displaying access policies.
- Bugs: **HIGH** — Route does not exist or is not mounted. Identical redirect issue to acc-sessions.

## acc-roles — /thomas-anderson-mac/access/roles
- Status: REDIRECT → /thomas-anderson-mac/default/ask
- Preview/mock: NO
- Console: **1 ERROR** — React #418
- Screenshot: acc-roles.png
- Content: Page redirects to Ask/chat interface instead of displaying role management.
- Bugs: **HIGH** — Route does not exist or is not mounted. Identical redirect issue to acc-sessions and acc-policies.

## acc-grants — /thomas-anderson-mac/access/grants
- Status: NOT_AUDITED (browser crashed)
- Preview/mock: Unknown

## acc-reviews — /thomas-anderson-mac/access/reviews
- Status: NOT_AUDITED (browser crashed)
- Preview/mock: Unknown

## acc-principals — /thomas-anderson-mac/access/principals
- Status: NOT_AUDITED (browser crashed)
- Preview/mock: Unknown

## acc-requests — /thomas-anderson-mac/access/requests
- Status: NOT_AUDITED (browser crashed)
- Preview/mock: Unknown

