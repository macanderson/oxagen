---
# Authentication Surfaces

- **Route:** `/login`, `/signup`, `/forgot-password`, `/reset-password`, `/two-factor`, `/verify`
- **Nav location:** none (unauthenticated shell over `HeroBackdrop`; no sidebar/tabs — these are pre-scope routes)
- **Priority:** P1
- **Disposition vs today:** Keep

## Purpose
This is the unauthenticated front door: email+password sign-in/sign-up, account-recovery, second-factor challenge, and email-verification landing, all sharing one visual shell. It is the single entry point that establishes a Better Auth session before any org/workspace scope exists, and it is the natural home for future enterprise BYOK/SSO sign-in options.

## Primary user & jobs-to-be-done
- **Primary user:** Prospective or returning user without an active session.
- **JTBD:**
  - Sign in with email+password or an OAuth provider and land in my workspace.
  - Create a new account and get routed into onboarding.
  - Recover a forgotten password without leaking whether an email is registered.
  - Complete a second-factor challenge when my account has TOTP MFA enabled.
  - Understand that a verification email was sent and what to do next.

## Functionality
One shell, six route variants:

| Route | Component | Behavior |
|---|---|---|
| `/login` | `LoginForm` (mode=signin) | Email+password + OAuth buttons; redirects to `/` dispatcher on success |
| `/signup` | `LoginForm` (mode=signup) | Same form, signup mode; creates Better Auth user, redirects toward onboarding |
| `/forgot-password` | `ForgotPasswordForm` + `actions.ts` (`requestResetAction`) | Anti-enumeration: always shows the same "check your email" success state regardless of whether the address exists |
| `/reset-password` | `ResetPasswordForm` + `actions.ts` | Reads `?token=` query param; submits new password; invalid/expired token shows inline error |
| `/two-factor` | `TwoFactorForm` | Public route relying on a short-lived 2FA cookie set after primary auth; listed in `proxy.ts` `PUBLIC_PATHS`; submits TOTP or backup code |
| `/verify` | static page | "Check your email" notice, no interactivity |

Primary action on each: single submit button. Secondary: links between login/signup/forgot-password. No filters or in-page tabs.

## Capabilities invoked
None — all flows run through Better Auth's own session/credential/2FA plumbing, not `invoke()`-based contracts.

**Contract gap:** organization-level SSO enforcement (forcing a workspace's members through an IdP) is not built. No `org.sso.*` contract exists today; flag for a future ticket rather than building ad hoc.

## Data sources
- **Postgres**, via Better Auth's own Drizzle adapter tables (`user`, `session`, `account`, `rateLimits` — note plural, per Gotchas). No direct app-level queries in these routes.
- No Neo4j, ClickHouse, or Blob access.

## States
- **Empty:** N/A (forms, not lists).
- **Loading:** Submit buttons show a pending/disabled state during the server action round-trip.
- **Error:** Inline field-level and form-level error text (invalid credentials, expired/invalid reset token, invalid 2FA code); forgot-password never reveals account existence.

## Existing implementation
- **Today:** all under `apps/app/src/app/(auth)/*`. Complete. Reuse the shared `(auth)/layout.tsx` shell and `LoginForm` component as-is; no rebuild needed for 2.0.

## Vision alignment
Identity is the first link in the accountability chain (identity → knowledge scope → permitted action → …); keeping auth simple, BYOK-neutral, and MFA-capable protects that chain's root of trust. P1 because nothing else in the product functions without it.
