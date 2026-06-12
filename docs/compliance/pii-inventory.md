# PII inventory (GDPR Art. 30 data map)

Last audited: 2026-06-12. Source of truth for column definitions:
`packages/database/src/schema/`. Update this file whenever a schema change
adds, moves, or removes a PII-bearing column.

All Postgres data is encrypted at rest. OAuth tokens are additionally
field-encrypted via the ingestion crypto adapter (`INGESTION_CRYPTO_PROVIDER`).
Payment card data never touches Oxagen systems beyond display fields — Stripe
holds the tokens (PCI DSS SAQ-A scope).

## PII-bearing tables

| Table | PII fields | Scope | Purpose / notes |
| --- | --- | --- | --- |
| `auth.users` | `email`, `username`, `display_name`, `avatar_url` | Per-user (global) | Account identity. Email is the login identifier (citext, unique). Schema: `auth.ts`. |
| `auth.sessions` | `ip_address`, `user_agent` | Per-user | Session security metadata (Better Auth). Expires with the session. Schema: `auth.ts`. |
| `ingestion.oauth_accounts` | `provider_user_id`, `provider_user_email`, `provider_user_name`; `access_token_enc` / `refresh_token_enc` (field-encrypted) | Org-scoped | Third-party OAuth identity for data connectors (Google/GitHub data clients). Tokens are encrypted jsonb, never plaintext. Schema: `ingestion.ts`. |
| `billing.payment_methods` | `brand`, `last4`, `exp_month`, `exp_year` | Org-scoped | Display-only card metadata. Full PAN/tokens live at Stripe (`stripe_customer_id` / `stripe_payment_method_id` are opaque references) — PCI SAQ-A. Schema: `billing.ts`. |
| `org.invitations` | `email` | Org-scoped | Pending-member invitation target. Retained historically with status lifecycle (`pending`→`accepted`/`declined`/`revoked`/`expired`). Schema: `org.ts`. |
| `security.security_events` | `ip`, `user_agent`, `actor_user_id` | Org-scoped, append-only | SOC 2 audit trail (7-year retention). By policy stores user IDs only — never emails or usernames (see `packages/telemetry/src/security.ts`). Schema: `security.ts`. |

## Export and erasure (GDPR Art. 17 / Art. 20)

- **Request tracking tables:** `privacy.privacy_export_requests` and
  `privacy.privacy_erasure_requests` (`packages/database/src/schema/privacy.ts`),
  written via the `privacy.data.export` / `privacy.data.erase` capabilities,
  which also emit `privacy.*` security events.
- **Export processor:**
  `packages/inngest-functions/src/functions/privacy.export.process.ts` —
  assembles the subject's data into a portable export.
- **Erasure processor:**
  `packages/inngest-functions/src/functions/privacy.erasure.execute.ts` —
  executes erasure after the grace period (`PRIVACY_ERASURE_GRACE_DAYS`).
- **Operational runbook:** `docs/gdpr/sop-data-erasure.md`.
