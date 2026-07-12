# Google OAuth Clients — Login vs. Data

**Status:** Draft
**Date:** 2026-07-11
**Related:** `docs/adr/ADR-012-connector-dual-write-pattern.md`, `docs/adr/ADR-027-multi-tenant-github-app-connect.md`, `docs/guides/connector-authoring.md`

## Decision up front

**Two Google Cloud OAuth clients total** — not one per connector.

| Client | Purpose | Status |
|---|---|---|
| `GOOGLE_LOGIN_CLIENT_ID`/`SECRET` | Social sign-in (Better Auth) | **Already live** — `packages/auth/src/auth.ts:383-393` |
| `GOOGLE_DATA_CLIENT_ID`/`SECRET` | All Google Workspace data-source connectors (Drive, Gmail, Calendar, BigQuery, Contacts, Meet, Tasks, and future) | **Net-new — this spec** |

One Google Cloud OAuth client can request scopes across multiple Google APIs in a single authorization (confirmed against Google's own docs — see "Premise correction" below). The two-client split here is a *purpose* split (login identity vs. data access), not a per-API split — mirroring how `GITHUB_LOGIN_CLIENT_ID` and `GITHUB_APP_CLIENT_ID` are already split in `.env.example`.

## Premise correction: not one client per API

Google explicitly supports bundling scopes from many APIs (Gmail, Calendar, Drive, BigQuery, …) into one authorization request against one `client_id`. This repo already assumes that model:

- `.env.example:102-106` scaffolds a *singular* `GOOGLE_DATA_CLIENT_ID`/`GOOGLE_DATA_CLIENT_SECRET` pair, commented "Workspace data scopes; future connection."
- The seven bundled Google connector schemas (`packages/ingestion/src/connectors/google-*/schema.yaml`) each declare their own `scopes:` array under the same `oauth2_authorization_code` auth-scheme `id: oauth2` — the schema format was built for one shared client differentiated by scope, not by client identity per connector.
- GitHub's working connector callback is explicitly commented as "the (single, global) callback" (`apps/api/src/routes/v1/github-oauth.ts:263`), with connector/org/workspace identity carried in an HMAC-signed `state` param — not via a dedicated redirect URI per connector.

**The one real constraint is narrower:** Google's *single-purpose policy* applies to **restricted** scopes specifically (Gmail and Drive are restricted; see scope table below). If a verification reviewer judges the restricted-scope purposes as unrelated, they can require splitting *those specific scopes* into a separate OAuth client/listing. This is a case-by-case verification outcome, not a blanket "one client per app" technical requirement, and it does not extend to non-restricted scopes (Calendar, Tasks, Contacts, BigQuery, Meet).

**Fallback plan if verification pushes back:** split only the restricted-tier scopes (Gmail, Drive) into their own client(s) at that point. Do not pre-split all thirteen products speculatively — that multiplies redirect-URI registrations, consent-screen submissions, and annual re-verification burden for products (Calendar, Tasks, BigQuery, …) that were never going to be flagged.

Sources: [OAuth 2.0 Policies](https://developers.google.com/identity/protocols/oauth2/policies), [Restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification), [Using OAuth 2.0 to Access Google APIs](https://developers.google.com/identity/protocols/oauth2).

---

## Client A — Login (`GOOGLE_LOGIN_CLIENT_ID` / `GOOGLE_LOGIN_CLIENT_SECRET`)

Already built. Documented here for completeness and as the pattern precedent for redirect-URI minimization.

- **Client type:** Web application
- **Scopes:** `openid`, `profile`, `email` only — explicitly minimal (comment at `packages/auth/src/auth.ts:389-391`: "prevents Google Cloud Console pre-authorized scopes from silently expanding the consent screen"). Non-sensitive tier; no Google verification required.
- **Consumer:** Better Auth (`packages/auth/src/auth.ts`, `socialProviders.google`), mounted at `apps/app/src/app/api/auth/[...all]/`.
- **Redirect URI — exactly ONE, registered against production only:**
  `{OAUTH_PROXY_PRODUCTION_URL}/api/auth/callback/google` → `https://app.oxagen.sh/api/auth/callback/google`
- **How previews and local work without extra redirect URIs:** Better Auth's OAuth Proxy (`OXA-1789`, `packages/auth/src/auth.ts:192-204`) relays social-login traffic for every preview deployment and local dev through the single production callback, using `OAUTH_PROXY_SECRET` to encrypt/decrypt the relay payload. This exists specifically because "a GitHub OAuth App (and a Google OAuth client) allows only ONE callback host" (comment at `auth.ts:195`) — Google forbids wildcard redirect URIs, so proxying beats registering N preview hostnames.
- **Action needed:** none — already wired. Just confirm `GOOGLE_LOGIN_CLIENT_ID`/`SECRET` and `OAUTH_PROXY_SECRET` are set in Vercel prod + preview envs.

## Client B — Data (`GOOGLE_DATA_CLIENT_ID` / `GOOGLE_DATA_CLIENT_SECRET`)

Net-new. This is the client backing all Google Workspace source connectors.

- **Client type:** Web application
- **Consumer:** `apps/api` (Hono), modeled directly on `github-oauth.ts` — NOT the Next.js app, NOT the Better Auth OAuth Proxy (that mechanism is login-specific).
- **Redirect URI — exactly ONE, registered for local + prod:**
  - `http://localhost:4000/oauth/google/callback` (apps/api's local port per `CLAUDE.md`; plain HTTP — Google allows non-HTTPS for `localhost`)
  - `https://api.oxagen.sh/oauth/google/callback`
  - No preview-deployment entry needed: `apps/api` is not multi-tenant-per-branch the way `apps/app` previews are: verify against actual preview deploy topology before shipping; if previews DO get their own api subdomain, extend the OAuth Proxy pattern from Client A rather than registering N more URIs.
- **Connector identity routing:** carried in an HMAC-signed `state` param, not the URL path — same shape as GitHub's `buildStateHmac`/`encodeState` (`github-oauth.ts:41-46`):
  ```
  state = base64url(JSON.stringify({ connector, orgId, workspaceId, connectionId, returnTo })) + "." + HMAC-SHA256(...)
  ```
  `connector` is one of `google-drive`, `google-gmail`, `google-calendar`, `google-bigquery`, `google-contacts`, `google-meet`, `google-tasks`, plus whichever future connectors below get built. The callback looks up which scopes/token-exchange path to use from `connector`, matching how each connector's `schema.yaml` `auth.schemes[].scopes` already declares its own scope list.
- **Scope union — requested per-connection based on which connector initiated the flow, not all at once:**

  | Connector | Status | Scopes (from `schema.yaml`) | Google sensitivity tier |
  |---|---|---|---|
  | `google-drive` | Built | `drive.readonly`, `drive.metadata.readonly` | **Restricted** |
  | `google-gmail` | Built | `gmail.readonly` | **Restricted** |
  | `google-calendar` | Built | `calendar.readonly` | Sensitive |
  | `google-contacts` | Built | `contacts.readonly` | Sensitive |
  | `google-tasks` | Built | `tasks.readonly` | Sensitive |
  | `google-meet` | Built | `meetings.space.readonly`, `meetings.space.created` | Sensitive |
  | `google-bigquery` | Built | `bigquery.readonly` | Non-sensitive (Cloud Platform API, separate review track) |
  | `google-docs`, `google-sheets`, `google-slides`, `google-photos`, `google-maps`, `google-keep` | **Not yet built** — no `schema.yaml` exists | TBD — author via `docs/guides/connector-authoring.md` before requesting scopes | TBD |
  | `google-ads` | **Not yet built** | TBD — Ads API additionally requires a separate **developer token** application, independent of OAuth scopes | TBD |
  | `google-analytics` | **Not yet built** | TBD — requires per-GA-property access grant on top of OAuth | TBD |

  Sensitivity tiers above are best-effort from current Google documentation categories — re-verify each against the live [OAuth 2.0 Scopes for Google APIs](https://developers.google.com/identity/protocols/oauth2/scopes) list before submitting for verification, since Google revises tiering.

- **Secret storage:** `GOOGLE_DATA_CLIENT_SECRET` via Vercel env (prod + preview), never committed. Per-tenant *tokens* (not the client secret) are KMS-encrypted at rest in `ingestion.oauth_accounts`, matching the GitHub connector's existing storage path.
- **Verification/compliance action items (not code, but blocking for restricted scopes in production for non-test users):**
  1. Publish a privacy policy + verified homepage under the `oxagen-502118` GCP project.
  2. Submit for OAuth verification once Drive/Gmail scopes are requested — budget **weeks**, not days; restricted scopes require Google's CASA security assessment, renewed annually.
  3. Until verified, only Google accounts added as "test users" on the OAuth consent screen can complete these connectors' auth flow — fine for internal dogfooding, blocking for GA.
  4. `google-ads` and `google-analytics` need their own product-specific access grants (Ads developer token; Analytics property-level access) in addition to — not instead of — this OAuth client. Scope those out as separate follow-up work when those connectors are actually authored.

---

## Redirect URI registration checklist (both clients combined)

```
GOOGLE_LOGIN_CLIENT_ID   → https://app.oxagen.sh/api/auth/callback/google
GOOGLE_DATA_CLIENT_ID    → http://localhost:4000/oauth/google/callback
GOOGLE_DATA_CLIENT_ID    → https://api.oxagen.sh/oauth/google/callback
```

Four URIs total across two clients — versus the 26 URIs across one client implied by a per-connector-path registration. Rotate the previously-pasted secret before using any of this; it was exposed in plaintext chat.

## Open follow-ups

- Confirm `apps/api` preview-deployment topology (does each PR preview get its own `api-*.oxagen.sh`-style host?) before finalizing whether Client B needs an OAuth-Proxy-style relay like Client A, or whether local + prod is genuinely sufficient.
- Author `schema.yaml` for the six not-yet-built connectors via `docs/guides/connector-authoring.md` before requesting their scopes on the live OAuth consent screen — don't pre-request scopes for connectors that don't exist yet, since every added scope re-triggers verification review.
- Implement `/oauth/google/callback` in `apps/api`, modeled on `github-oauth.ts`'s state-signing + token-exchange structure, once this spec is approved.
