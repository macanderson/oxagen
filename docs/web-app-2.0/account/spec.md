---
# Account Settings

- **Route:** `/account` (tabs: `/account/profile`, `/account/preferences`, `/account/security`, `/account/privacy`)
- **Nav location:** account scope sidebar → single "Account" section with four tabs
- **Priority:** P1 (Profile, Security) / P2 (Preferences, Privacy)
- **Disposition vs today:** Keep (recommend unifying chrome into one tabbed shell)

## Purpose
Account settings hold everything scoped to the individual user rather than any org/workspace — identity, personal preferences, credential security, and GDPR data rights. Today these live as four separate top-level pages under `/account/*`; this spec recommends consolidating them under one tabbed `Account Settings` shell so the user-scope/org-scope boundary reads clearly in the nav instead of being four disconnected routes.

## Primary user & jobs-to-be-done
- **Primary user:** Any authenticated user, regardless of org role.
- **JTBD:**
  - Update my name, avatar, timezone/language, and see/manage connected OAuth accounts.
  - Set my personal preferences without affecting anyone else in my org.
  - Enroll/manage TOTP MFA and see and revoke my own active sessions.
  - Export or permanently erase my personal data (GDPR Art. 17/20).

## Functionality
Four tabs under one `Account` shell:

| Tab | Contents | Primary actions |
|---|---|---|
| Profile | Email, display name, avatar, connected OAuth accounts, timezone/language | Save profile; set/unset password; unlink an OAuth account |
| Preferences | Theme/locale and other personal prefs, seeded from current values | Save preferences |
| Security | TOTP MFA enroll/verify/disable + backup codes; list of own active sessions | Enroll MFA; regenerate backup codes; revoke a specific other session |
| Privacy | GDPR data export and account erasure | Request export (polled to completion); request erasure (confirmation-gated, destructive) |

Security tab doubles as the redirect target when an org enforces MFA and the user hasn't enrolled yet.

## Capabilities invoked
- `user.preferences.read` (`get_user_preferences`) — seeds the Preferences form; also read directly (non-`invoke()`) on Profile as a documented IAM-bootstrap workaround, since `apps/app` does not bootstrap IAM.
- `user.preferences.write` (`update_user_preferences`) — saves Preferences tab changes.
- `privacy.data.export` (`export_data`, scope=user) — Privacy tab export request.
- `privacy.data.erase` (`erase_data`, scope=user) — Privacy tab erasure request.
- Better Auth `twoFactor` plugin (enroll/verify/disable/backup-codes) and Better Auth session-revoke — no Oxagen contract; native to Better Auth.

**Note (reverse parity):** `privacy.data.export`/`privacy.data.erase` have working UI but their contracts omit `"app"` from `layers[]`, so `check:manifest`'s reverse advisory flags them. Recommend adding `"app"` to both contracts to close the gap honestly rather than leaving it silently unflagged.

## Data sources
- **Postgres**, via `withSystemDb` (user-scoped, pre-tenant): `user`, preferences, session/account tables. Export/erase jobs may touch org-scoped tables transitively but are always IDOR-scoped to the caller's own user id.
- No Neo4j, ClickHouse, or Blob writes from these pages directly (export job may read across stores but that's the export handler's concern, not the page).

## States
- **Empty:** Preferences defaults to system defaults if unset; Security shows "MFA not enrolled" state.
- **Loading:** Export shows a polling progress state until the job completes.
- **Error:** Inline validation errors on Profile/Preferences forms; erasure requires explicit confirmation before firing.

## Existing implementation
- **Today:** `apps/app/src/app/account/profile/page.tsx`, `apps/app/src/app/account/preferences/page.tsx`, `apps/app/src/app/account/security/page.tsx`, `apps/app/src/app/account/privacy/page.tsx` — all complete and independently functional under `apps/app/src/app/account/layout.tsx`. 2.0 work is chrome consolidation (shared tab bar), not new capability wiring.

## Vision alignment
User-scoped identity, preferences, and MFA are the base of the accountability chain's "identity" link, and Privacy's export/erase capabilities are direct trust-moat proof points (vendor-neutral data rights). P1 for Profile/Security since they gate access; P2 for Preferences/Privacy as high-value but non-blocking.
