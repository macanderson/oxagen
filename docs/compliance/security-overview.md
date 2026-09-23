# Security overview

Your review needs to distinguish a control in code from a control exercised in production. This document describes the code baseline named in the [pack index](README.md). It does not attest to operation over a period.

## Data flow

A person authenticates through [Better Auth](../../packages/auth/src/auth.ts). Governed capability calls from the API, MCP, and app reach the [capability kernel](../../packages/oxagen/src/kernel.ts), which validates contracts and applies the installed identity, billing, entitlement, and decision-rule gates. Surface bootstrap must install these gates. A missing runtime gate is not equivalent to a denial. Webhooks, the Inngest endpoint, and CMS routes have separate authentication and validation boundaries in [API routing](../../apps/api/src/app.ts); they do not inherit these kernel gates merely by reaching the API.

Postgres stores transactional identity and configuration. [Tenant transactions](../../packages/database/src/tenant.ts) set organization and workspace scope for row-level security. Explicit system transactions serve cross-tenant jobs. [Data-plane resolution](../../packages/tenancy/src/data-plane.ts) selects configured stores. Neo4j stores graph relationships, ClickHouse stores telemetry, and [blob adapters](../../packages/storage/src/client.ts) store binary objects.

Wrapped harnesses send events and redacted frame bodies through [Tacho ingest](../../packages/handlers/src/tacho.events.ingest.ts). [The evidence store](../../packages/run-ledger/src/evidence-store.ts) retains bodies separately from the record. Model requests routed through [the local proxy](../../packages/tacho/src/collector/model-proxy.ts) reach the selected provider. A laptop operator can bypass or remove hooks. This baseline does not provide process containment.

## Identity and authorization

[Authentication configuration](../../packages/auth/src/auth.ts) supports email and password, configured social providers, and TOTP. Its login cookie expires after 30 days and refreshes after one day. [Machine-key scope](../../packages/iam/src/machine-key-scope.ts) restricts machine credentials by purpose and tenant. [IAM resolution](../../packages/iam/src/check-iam.ts) includes tier-dependent behavior, so sensitive handlers also enforce explicit organization roles.

Enterprise SSO is in [PR #3735](https://github.com/macanderson/oxagen/pull/3735), outside this baseline. [SCIM #3734](https://github.com/macanderson/oxagen/issues/3734) tracks identity-provider deprovisioning. Do not answer that automatic SCIM revocation is implemented. This baseline contains no passkey authentication plugin.

## Encryption

[Aurora configuration](../../infra/stacks-new/oxagen/data-services.tf) sets storage encryption. [App-node volumes](../../infra/modules/app-node/main.tf) are encrypted. The [active ALB HTTPS listener](../../infra/stacks-new/oxagen/main.tf) terminates public TLS. It forwards HTTP to the node, where [Caddy](../../infra/tools/caddy/Caddyfile.alb) routes to local services. The node security group restricts inbound HTTP to the ALB security group; the ALB-to-node hop is not encrypted.

[Envelope encryption](../../packages/crypto/src/envelope.ts) uses AES-256-GCM with a fresh data key wrapped by the configured KMS adapter. The current envelope does not authenticate tenant or row context. [Plugin credential KMS](../../packages/plugins/src/credentials/kms.ts) uses a local wrapping key from `AUTH_TOKEN_ENCRYPTION_KEY`. It must not be described as an AWS KMS call merely because it has a KMS interface.

[OAuth write hooks](../../packages/auth/src/token-encryption.ts) encrypt token fields on the paths they intercept. Their source documents remaining plaintext columns and the absence of the historical trigger from Atlas. Field encryption must therefore be described by write path, not as a universal guarantee.

[Host credential custody](../../packages/tacho/src/host/credential-store.ts) keeps supported model credentials outside the harness process. A machine's owner can still read the local sealing key. GitHub push custody is not present in this baseline.

## Records and retention

[Security events](../../packages/telemetry/src/security.ts), [kernel events](../../packages/oxagen/src/kernel.ts), and [run seals](../../packages/run-ledger/src/run-store.ts) serve different purposes. A security event is not a copy of every tool input and output. Run exports permit integrity verification, not a claim that the source producer reported everything truthfully.

The [retention table](data-retention.md) separates implemented expiry from intended policy. Full cross-store erasure is incomplete: [the erasure processor](../../packages/inngest-functions/src/functions/privacy.erasure.execute.ts) performs limited identity cleanup and deliberately refuses to report full completion.

## Backups and recovery

[Aurora](../../infra/stacks-new/oxagen/data-services.tf) configures a 35-day backup window and a final snapshot on deletion. [DLM](../../infra/modules/app-node/backup.tf) schedules hourly snapshots of the tagged Neo4j volume, with the module's seven-day default. This policy is not evidence of ClickHouse backup coverage or a successful restore.

No dated restore exercise, measured recovery time, or measured recovery point is supplied by this pack. Do not turn configured backup periods into a recovery service-level promise. Check active AWS policies, snapshot timestamps, and a restoration drill before making that commitment.

## Change control and response

[CI](../../.github/workflows/pipeline.yml) checks source and gates deployment. [DB Migrate](../../.github/workflows/db-migrate.yml) applies Postgres migrations separately. Review the exact deployed commit and artifacts, since a successful superseded deploy job may skip publication.

[SECURITY.md](../../SECURITY.md) provides private reporting channels and response targets. Those targets are published policy, not measured response evidence. No independent penetration test report or external attestation accompanies this pack.
