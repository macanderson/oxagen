# Security Policy

Oxagen is a governed control plane for AI agents — security is the product, not a feature. Typed capability contracts with deny-by-default IAM, entitlement gating, tenant isolation across every store, and full audit lineage are core to the platform's trust posture. We take reports that weaken any of that seriously and act on them fast.

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report privately through either channel:

1. **GitHub private vulnerability reporting** (preferred): [Report a vulnerability](https://github.com/macanderson/oxagen/security/advisories/new) on this repository.
2. **Email**: `security@oxagen.sh`

Include what you can of:

- A description of the vulnerability and its impact
- Steps to reproduce (proof-of-concept code or requests welcome)
- Affected surface (web app, API, MCP server, CLI, ingestion pipeline) and version/commit
- Any suggested remediation

## What to Expect

- **Acknowledgement within 48 hours** of a private report.
- **Triage and severity assessment within 5 business days**, with a remediation plan for confirmed issues.
- We will keep you informed as the fix progresses and credit you in the advisory if you'd like (or keep you anonymous — your choice).
- We ask that you give us a reasonable window to remediate before any public disclosure.

## Scope

In scope:

- This repository and everything deployed from it: `app.oxagen.sh`, `api.oxagen.sh`, `mcp.oxagen.sh`, `docs.oxagen.sh`, `oxagen.sh`
- The `oxagen` CLI and its telemetry ingest path
- Tenant-isolation boundaries: Postgres RLS, per-workspace Neo4j scoping, ClickHouse predicates
- The capability kernel's IAM, entitlement, and billing gates (bypasses are high severity)
- MCP tool surface: schema enforcement, tool-poisoning and injection resistance
- Secrets handling: BYOK model keys, API keys, OAuth tokens, SSO provider secrets

Out of scope:

- Denial-of-service via volumetric traffic
- Findings that require a compromised developer machine or already-privileged account without an escalation path
- Vulnerabilities exclusively in third-party dependencies with no exploitable path through Oxagen (please still report them upstream)
- Social engineering of Oxagen personnel

## Safe Harbor

We will not pursue legal action for good-faith security research that stays within scope, avoids privacy violations and data destruction, and does not degrade service for other tenants. Test against your own org and workspace; never access another tenant's data — if a boundary appears crossable, report the vector rather than exercising it.

## Supported Versions

Oxagen is deployed continuously from `main`. The production deployment and the latest published CLI release receive security fixes; older CLI versions should upgrade (`npm i -g oxagen@latest`).

## Security Posture (for reviewers)

- **Every capability is a typed contract** (Zod-validated input/output) dispatched through a single `invoke()` kernel. The kernel runs the IAM check on every call, the billing admission gate on every contract not marked `noBillingGate`, and the plugin entitlement gate on contracts a plugin claims. IAM denies by default in an organization on the enterprise tier and for every agent principal. In other organizations a person passes IAM, and a handler that needs an organization role checks it with `assertOrgRole`.
- **Tenant isolation** is enforced at the data layer: Postgres row-level security via a non-superuser app role (raw `db()` access is banned in code), workspace-scoped Neo4j graphs, and tenant predicates on ClickHouse queries.
- **Auth** is Better Auth: email and password, Google and GitHub sign-in, TOTP two-factor, and enterprise SSO over OIDC and SAML 2.0 with IdP group-to-role mapping. Organization and workspace RBAC decide what a signed-in person may call. Auth endpoints are rate limited, with tighter limits on password, SSO, and sign-up attempts. The counters live in Postgres, so every server instance shares them.
- **Secrets**: platform secrets live in environment configuration, validated at runtime by a Zod schema and catalogued in `packages/config/src/registry.ts`, and never in code. Secrets a customer hands Oxagen (model provider keys, plugin credentials, dedicated data-plane connections, and SSO client secrets and SAML private keys) are stored in Postgres as AES-256-GCM envelopes whose data key is wrapped by a master key held in environment configuration.
- **Audit**: the kernel writes one row per capability call to Postgres `security.security_events`, with the outcome (allow, deny, or error), organization, workspace, person, capability, request id, and time. Sign-in, SSO, role, API key, and billing changes write to the same table. The write does not block the call, so a failed write loses that row rather than failing the call. Model usage and token counts go to ClickHouse through `@oxagen/ai`.
- **CLI telemetry** is anonymous and allowlist-validated at ingest — see [`TELEMETRY.md`](TELEMETRY.md) for the exact schema and opt-out.
