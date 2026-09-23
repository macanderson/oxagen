# Social login OAuth apps: Google and GitHub

**Status:** Current
**Date:** 2026-09-19
**Related:** `packages/auth/src/auth.ts`, `packages/auth/src/oauth-proxy-config.ts`, `oxagen-roadmap:docs/oxagen/specs/google-oauth-clients.md` (login vs data client split)

Use this checklist when Google or GitHub sign-in fails on `/login`, or when you create or rotate the login OAuth apps. These are the **LOGIN** clients only. They are not the Google DATA client, the GitHub App connector (`GITHUB_APP_*`), or MCP OAuth.

## What Oxagen expects

| Env var | Provider console | Used by |
|---|---|---|
| `GOOGLE_LOGIN_CLIENT_ID` / `GOOGLE_LOGIN_CLIENT_SECRET` | Google Cloud OAuth 2.0 Client (Web application) | Better Auth `socialProviders.google` |
| `GITHUB_LOGIN_CLIENT_ID` / `GITHUB_LOGIN_CLIENT_SECRET` | GitHub **OAuth App** (not a GitHub App) | Better Auth `socialProviders.github` |
| `BETTER_AUTH_URL` | n/a | Auth base URL (`https://app.oxagen.sh` in production) |
| `OAUTH_PROXY_PRODUCTION_URL` | n/a | Defaults to `https://app.oxagen.sh`. Preview social login relays through this origin. |
| `OAUTH_PROXY_SECRET` | n/a | Same value in production and preview. Encrypts the preview relay payload. |

Production and preview load these from SSM under `/oxagen/production/*` (and the preview path your deploy uses). Local loads them from `.env.local`.

If either LOGIN pair is empty, Better Auth leaves that provider `undefined`. The login page still shows the button, and the click fails. Deployed envs require both pairs (`requiredIn: preview + production`).

## Callback URLs (exact strings)

Auth is served by the **app** host (`app.oxagen.sh` → Next on `:3000`), not `api.oxagen.sh`.

### Production and preview (shared LOGIN apps)

Register **one** callback per provider on the shared production LOGIN app:

```
https://app.oxagen.sh/api/auth/callback/google
https://app.oxagen.sh/api/auth/callback/github
```

Preview deployments do not get their own callback host. Better Auth's OAuth Proxy rewrites the outgoing `redirect_uri` to the production callback, then relays the session back to the preview origin. Production itself is a passthrough.

### Local development (separate LOGIN apps)

Local disables the OAuth Proxy. Local needs its **own** Google client and GitHub OAuth App with:

```
http://localhost:3000/api/auth/callback/google
http://localhost:3000/api/auth/callback/github
```

Put those local client id/secret pairs in `.env.local` as `GOOGLE_LOGIN_*` and `GITHUB_LOGIN_*`. Do not point local at the production client unless you also register the localhost callbacks on that client (Google allows multiple redirect URIs; a GitHub OAuth App allows only one Authorization callback URL, so local GitHub needs a second OAuth App).

## Google LOGIN client checklist

In [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → APIs & Services → Credentials → the Web application client whose id matches `GOOGLE_LOGIN_CLIENT_ID`:

1. **Application type:** Web application.
2. **Authorized JavaScript origins:**
   - Production: `https://app.oxagen.sh`
   - Local (local client only): `http://localhost:3000`
3. **Authorized redirect URIs:** exactly the callback strings above for that environment. No trailing slash. No `api.oxagen.sh` path. No old `*.vercel.app` host.
4. **Scopes requested by Oxagen:** `openid`, `profile`, `email` only. Non-sensitive. No Google verification required for login.
5. **OAuth consent screen:**
   - Publishing status matches who may sign in (Testing = listed test users only; In production = any Google account).
   - App name and support email are set.
6. **Secrets in SSM / `.env.local`:**
   - `/oxagen/production/GOOGLE_LOGIN_CLIENT_ID`
   - `/oxagen/production/GOOGLE_LOGIN_CLIENT_SECRET`
   - Not `GOOGLE_DATA_*`. Those are for Workspace connectors.
7. **Smoke test:** `POST https://app.oxagen.sh/api/auth/sign-in/social` with body `{"provider":"google","callbackURL":"/"}` returns JSON whose `url` has `redirect_uri=https%3A%2F%2Fapp.oxagen.sh%2Fapi%2Fauth%2Fcallback%2Fgoogle`. Opening that URL shows Google's account chooser, not `redirect_uri_mismatch`.

## GitHub LOGIN OAuth App checklist

In [GitHub Developer Settings → OAuth Apps](https://github.com/settings/developers) → the OAuth App whose Client ID matches `GITHUB_LOGIN_CLIENT_ID`:

1. **Kind:** OAuth App. Not a GitHub App. `GITHUB_APP_*` is a different credential set for the connector.
2. **Application name:** production-facing (for example `Oxagen`). A name like `Oxagen (Development)` on the live app is a config smell: rename it or confirm you are not pointing production at a personal/dev app.
3. **Homepage URL:** `https://oxagen.sh` or `https://app.oxagen.sh`.
4. **Authorization callback URL:** exactly one value on a GitHub OAuth App:
   - Production/preview shared app: `https://app.oxagen.sh/api/auth/callback/github`
   - Local app: `http://localhost:3000/api/auth/callback/github`
5. **Scopes Oxagen requests:** `read:user`, `user:email`.
6. **Client secret:** regenerate if it was pasted into chat or a ticket. Store as `GITHUB_LOGIN_CLIENT_SECRET` in SSM / `.env.local`.
7. **Secrets-meta aliases** (env-manager): `oxagen-github-login-client-id` / `oxagen-github-login-client-secret` (also `oxagen-github-client-id` / `oxagen-github-client-secret`). Do not map App connector secrets into `GITHUB_LOGIN_*`.
8. **Smoke test:** same as Google with `"provider":"github"`. The authorize page should say continue to your production app name, not an unrelated org app, and must not say the redirect_uri is not associated with this application.

## Preview relay checklist

1. `OAUTH_PROXY_PRODUCTION_URL` is `https://app.oxagen.sh` (or unset, which defaults to that).
2. `OAUTH_PROXY_SECRET` is set to the **same** value in production and preview.
3. Preview origin is trusted (`https://preview-app.oxagen.sh` is in the hardcoded production trusted origins).
4. Access previews via that stable alias when testing social login.

## After a failed sign-in in the app

1. Failed provider round-trips redirect to `/login?error=<code>`. The login form shows a catalog message (`oauthCancelled` or `oauthFailed`).
2. A click that never leaves the page (missing credentials, network) shows the same alert on the OAuth buttons.
3. Browser Network: `POST /api/auth/sign-in/social` should be 200 with a provider `url`. A 4xx here means the provider is unset or the request is rejected before redirect.
4. After consent, `GET /api/auth/callback/<provider>` should set a `__Secure-oxagen.session_token` cookie and redirect to the `callbackURL` (usually `/`, which then routes to the first workspace or `/new-organization`).

## Common misconfigurations

| Symptom | Likely cause |
|---|---|
| Button click does nothing useful; alert about sign-in not finishing | LOGIN id/secret missing in that environment |
| Provider page: redirect_uri not associated / mismatch | Callback URL wrong host or path; old vercel.app URI still registered |
| Works in prod, fails locally | Local using production client without localhost callback; or expecting OAuth Proxy (disabled locally) |
| Works in prod, fails on preview | `OAUTH_PROXY_SECRET` mismatch, or preview not using the stable trusted origin |
| GitHub authorize shows a Development / personal app name | Production SSM points at the wrong OAuth App |
| Email/password works, social does not | LOGIN secrets wrong; App/Data secrets used by mistake |

## Related, not this checklist

- Google DATA client and Workspace connector scopes: `oxagen-roadmap:docs/oxagen/specs/google-oauth-clients.md`
- GitHub App install / connector OAuth: `GITHUB_APP_*`, `apps/api` github-oauth routes
- MCP provider OAuth: `MCP_OAUTH_PREREGISTERED_CLIENTS`
