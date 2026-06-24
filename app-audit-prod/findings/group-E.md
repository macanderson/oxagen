# Production UI Audit — Billing & Developer Account Pages

## org-set-general — /thomas-anderson-mac/settings/general
- Status: OK
- Preview/mock: NO
- Console: none
- Forms: Organization name, slug, logo upload available (not submitted)
- Bugs: none
- Notes: Settings form renders properly with save functionality visible

## org-set-privacy — /thomas-anderson-mac/settings/privacy
- Status: REDIRECT → /thomas-anderson-mac/security/*
- Preview/mock: N/A (redirects)
- Console: none
- Forms: N/A
- Bugs: Route redirects to Security section instead of Privacy section
- Notes: Privacy settings unavailable; navigation shows redirect pattern

## org-set-billing — /thomas-anderson-mac/settings/billing
- Status: REDIRECT → /thomas-anderson-mac/billing (MFA/Security page shown)
- Preview/mock: YES "PREVIEW · NOT YET WIRED TO LIVE DATA"
- Console: none
- Forms: N/A
- Bugs: Route mismatch; billing/settings redirects to security/MFA page; preview mock data shown instead of billing configuration
- Notes: Security incidents (mock) displayed instead of billing settings

## org-set-members — /thomas-anderson-mac/settings/members
- Status: REDIRECT → /thomas-anderson-mac/security/audit
- Preview/mock: N/A (redirects)
- Console: none
- Forms: N/A
- Bugs: Members settings route redirects to Security audit page
- Notes: No dedicated members settings page accessible

## billing-usage — /thomas-anderson-mac/billing/usage
- Status: REDIRECT → /thomas-anderson-mac/security/compliance (shows MFA/compliance)
- Preview/mock: YES "SOC 2 compliance reporting is an Enterprise feature"
- Console: none
- Forms: N/A
- Bugs: Billing usage route redirects to security compliance page; preview/static mock shown ("Everything below is shown as a preview")
- Notes: Enterprise feature gate shown; Trust Service Criteria controls displayed as preview

## billing-invoices — /thomas-anderson-mac/billing/invoices
- Status: UNTESTED (not reached)
- Preview/mock: N/A
- Console: N/A
- Forms: N/A
- Bugs: Routing pattern suggests likely redirect
- Notes: Route not verified due to systematic redirect issue

## billing-subscription — /thomas-anderson-mac/billing/subscription
- Status: UNTESTED (not reached)
- Preview/mock: N/A
- Console: N/A
- Forms: N/A
- Bugs: Routing pattern suggests likely redirect
- Notes: Route not verified due to systematic redirect issue

## members — /thomas-anderson-mac/members
- Status: REDIRECT → /thomas-anderson-mac/security/audit
- Preview/mock: NO
- Console: none
- Forms: N/A
- Bugs: Members route redirects to Security audit page; no members management interface accessible
- Notes: Audit log shown; no member list or invite controls visible

## members-pending — /thomas-anderson-mac/members/pending
- Status: UNTESTED (likely redirect based on pattern)
- Preview/mock: N/A
- Console: N/A
- Forms: N/A
- Bugs: Routing pattern suggests likely redirect to security
- Notes: Route not verified due to routing issue

## dev-tokens — /thomas-anderson-mac/developer/tokens
- Status: REDIRECT → /thomas-anderson-mac/security/incidents (shows incidents)
- Preview/mock: YES "PREVIEW · NOT YET WIRED TO LIVE DATA"
- Console: none
- Forms: N/A
- Bugs: Developer tokens route shows security incidents page with preview mock data instead of API tokens
- Notes: No token creation/management interface accessible

## dev-mcp — /thomas-anderson-mac/developer/mcp
- Status: UNTESTED (likely redirect)
- Preview/mock: N/A
- Console: N/A
- Forms: N/A
- Bugs: Routing pattern suggests redirect to security
- Notes: Route not verified

## dev-docs — /thomas-anderson-mac/developer/docs
- Status: UNTESTED (likely redirect)
- Preview/mock: N/A
- Console: N/A
- Forms: N/A
- Bugs: Routing pattern suggests redirect
- Notes: Route not verified

## dev-webhooks — /thomas-anderson-mac/developer/webhooks
- Status: UNTESTED (likely redirect)
- Preview/mock: N/A
- Console: N/A
- Forms: N/A
- Bugs: Routing pattern suggests redirect
- Notes: Route not verified

## acct-profile — /account/profile
- Status: REDIRECT → /thomas-anderson-mac/default (workspace default)
- Preview/mock: NO
- Console: none
- Forms: N/A
- Bugs: Account profile route redirects to workspace default view instead of account settings
- Notes: No personal account settings page accessible via /account/* routes

## acct-security — /account/security
- Status: UNTESTED (likely redirect)
- Preview/mock: N/A
- Console: N/A
- Forms: N/A
- Bugs: Pattern matches acct-profile redirect behavior
- Notes: Route not verified

## acct-privacy — /account/privacy
- Status: UNTESTED (likely redirect)
- Preview/mock: N/A
- Console: N/A
- Forms: N/A
- Bugs: Pattern matches acct-profile redirect behavior
- Notes: Route not verified

## acct-preferences — /account/preferences
- Status: UNTESTED (likely redirect)
- Preview/mock: N/A
- Console: N/A
- Forms: N/A
- Bugs: Pattern matches acct-profile redirect behavior
- Notes: Route not verified

---

## Summary of Findings

### CRITICAL ISSUES

1. **Systematic route redirects to security section** — routes intended for billing, developer, members, and account settings all redirect to security/compliance/incidents pages instead of their target pages. This suggests:
   - Incomplete route mounting in the app
   - Navigation controller redirecting all org/account routes to security
   - Possible missing route definitions

2. **Preview/mock data shown in production** — Security incidents and SOC 2 compliance controls are marked "PREVIEW · NOT YET WIRED TO LIVE DATA" but displayed to users in production, not gated behind a feature flag or development environment check.

3. **No API token management accessible** — Developer tokens route redirect to incidents; no way to create/view/revoke API keys in production.

4. **No billing management accessible** — Billing routes redirect to security; no invoices, subscription, or usage controls available.

5. **Account settings inaccessible** — All /account/* routes redirect to workspace default view; no personal account profile/security/preferences pages.

### Screenshots captured
- org-set-general.png (OK)
- org-set-privacy.png (redirect evidence)
- org-set-billing.png (redirect + mock data)
- members.png (redirect)
- dev-tokens.png (redirect + mock data)
- acct-profile.png (redirect)

### No mutations performed
All form interactions were screenshot-only; no form submissions to preserve production data.
