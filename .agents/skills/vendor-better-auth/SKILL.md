---
name: vendor-better-auth
description: Documentation map (llms.txt index) for the Better Auth TypeScript authentication framework — every adapter (Drizzle, Prisma, Postgres, MySQL…), OAuth provider, and plugin (organization, two-factor, passkeys, SSO, admin, API keys, Stripe) with a link to its official doc page. Use as a fast lookup when integrating or debugging Better Auth and you need to find the right doc. For hands-on setup workflows prefer the better-auth-best-practices, email-and-password-best-practices, organization-best-practices, and two-factor-authentication-best-practices skills; for the latest API always confirm at https://better-auth.com/docs.
---

# Better Auth — documentation map

Better Auth is the auth framework this monorepo standardizes on (see the IAM
package and `apps/app` auth). This skill is the **index**: a mirror of Better
Auth's `llms.txt`, grouping every adapter, provider, plugin, and concept with a
direct doc URL so you can jump to the exact page instead of searching.

- **Full index:** [`reference.md`](reference.md)
- **Latest API / code examples:** always confirm at <https://better-auth.com/docs>

## When to use which skill

| Need | Skill |
|------|-------|
| Find the right Better Auth doc page | **this skill** → `reference.md` |
| Server + client setup, adapters, sessions, plugins | `better-auth-best-practices` |
| Email/password, verification, password reset | `email-and-password-best-practices` |
| Multi-tenant orgs, members, RBAC, teams | `organization-best-practices` |
| TOTP, OTP, backup codes, trusted devices | `two-factor-authentication-best-practices` |
| Rate limiting, secrets, CSRF, cookies, token encryption | `better-auth-security-best-practices` |
| Scaffold auth into a new/existing app | `create-auth-skill` |

Keep this index in sync if Better Auth's `llms.txt` changes materially; it is a
pointer layer, not a substitute for the live docs.
