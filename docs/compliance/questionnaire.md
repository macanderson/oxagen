# Security questionnaire

Use these answers for an initial procurement review of identity, authority, credentials, and records. This is an original short questionnaire, not a completed licensed CAIQ or SIG instrument. The [pack baseline](README.md) defines the source reviewed. “Implemented” describes code and requires production evidence before it becomes an assurance about operation.

| Question | Answer and evidence |
| --- | --- |
| Is a SOC 2 report available? | No report evidenced. See [readiness](soc2-readiness.md). |
| Has an independent penetration test completed? | No report evidenced. [#3758](https://github.com/macanderson/oxagen/issues/3758). |
| Is a signed DPA available? | This pack contains a [draft](dpa-template.md), not an executed agreement. |
| Are processor locations documented? | [Recipient inventory](subprocessors.md) distinguishes AWS region from unverified vendor locations. Contract schedule remains incomplete. |
| Does every agent have an identity? | Not every agent. Agents created by [registration](../../packages/handlers/src/agent.register.ts) or [definition create](../../packages/agent/src/handlers/agent.definition.create.ts) receive a delegated agent principal. The [agent schema](../../packages/database/src/schema/agent.ts) permits a null principal. The [workspace qa-chat bootstrap](../../packages/handlers/src/workspace-agents.ts) creates its agent without one, and the [assistant run](../../packages/agent/src/runtime/assistant-run.ts) attaches the `oxagen.assistant` service principal on first use, which is not a delegated principal. Legacy agents may lack one. Confirm provisioning before making an every-agent claim. |
| Are roles checked? | [IAM](../../packages/iam/src/check-iam.ts) and sensitive handler checks apply to governed calls. Tier-dependent fast paths and runtime bootstrap require review. |
| Is tenant isolation implemented? | Postgres RLS and scoped transactions: [tenant helper](../../packages/database/src/tenant.ts), [scope](../../packages/tenancy/src/scope.ts). Dedicated system operations use explicit bypass. RLS filters only while `TENANT_RLS_ENFORCEMENT_ENABLED` is on, which [configuration](../../packages/config/src/env.ts) defaults to on in production only. |
| Are machine credentials scoped? | Partly. [Machine-key scope](../../packages/iam/src/machine-key-scope.ts) limits a key that carries a purpose to that purpose's capability allowlist and denies an unknown purpose. A plain organization key with no purpose passes this check and relies on handler role gates. Key lookup is fenced to the organization. No workspace binding is enforced here. |
| Is MFA available? | TOTP plugin in [authentication](../../packages/auth/src/auth.ts). No claim of universal mandatory MFA. |
| Are passkeys supported? | No passkey plugin in this baseline. |
| Is enterprise SSO available? | Yes in source. The SAML and OIDC [SSO plugin](../../packages/auth/src/sso/plugin.ts) is registered in [authentication](../../packages/auth/src/auth.ts), merged in [#3735](https://github.com/macanderson/oxagen/pull/3735). An organization's plan must include SSO ([entitlement](../../packages/auth/src/sso/entitlement.ts)). Verify deployed status before answering yes to a customer. |
| Does IdP deprovisioning revoke credentials? | SCIM is not implemented. [#3734](https://github.com/macanderson/oxagen/issues/3734). |
| Do login sessions expire? | Yes. A session expires 30 days after it was created or last extended, and a session used more than one day after its last update is extended (`expiresIn` and `updateAge` in [auth](../../packages/auth/src/auth.ts)). Cookie caching is off. |
| Is access review periodically performed? | No operating access-review evidence supplied. [#3757](https://github.com/macanderson/oxagen/issues/3757). |
| Are secrets field-encrypted? | [Envelope encryption](../../packages/crypto/src/envelope.ts) and [credential resolver](../../packages/plugins/src/credentials/kms.ts) implement specific paths. [OAuth hook limits](../../packages/auth/src/token-encryption.ts) prevent a universal yes. |
| Is stored infrastructure data encrypted? | [Aurora](../../infra/stacks-new/oxagen/data-services.tf) and [node volumes](../../infra/modules/app-node/main.tf) configure encryption. Verify deployed settings. |
| Is public traffic encrypted? | Public TLS terminates at the [ALB](../../infra/stacks-new/oxagen/main.tf). The ALB forwards HTTP to [Caddy](../../infra/tools/caddy/Caddyfile.alb) on the node, and the [node security group](../../infra/modules/app-node/main.tf) admits that traffic only from the ALB. That hop is not encrypted. |
| Are model credentials hidden from the harness? | Supported host custody paths exist in [credential store](../../packages/tacho/src/host/credential-store.ts). Host-owner access remains possible. |
| Can an operator approve or deny governed work? | [Approval runtime](../../packages/agent/src/runtime/approval.ts) and [decision capability](../../packages/oxagen/src/contracts/agent.approval.resolve.ts). |
| Do hooks contain a process? | No. [Vision](../VISION.md) distinguishes hook controls from the unbuilt contained tier. |
| Does a budget stop all spending? | No universal claim. The [proxy](../../packages/tacho/src/collector/model-proxy.ts) refuses routed requests only when the bundle's budget is enforced and sets a per-session limit. Unpriced models pass, and a call already in flight is not stopped. Verify source-to-bundle propagation and the supported harness. |
| Is action history retained? | [Run ledger](../../packages/run-ledger/src/run-store.ts), security events, and telemetry have different records and retention. [Retention table](data-retention.md). |
| Can records be checked offline? | [Export guide](../guides/export-and-verify.md) describes integrity verification. It does not establish source completeness. |
| Is full subject erasure automated? | No. [Erasure processor](../../packages/inngest-functions/src/functions/privacy.erasure.execute.ts) reports incomplete multi-store cleanup. |
| Is there a defined retention policy? | Yes, but some policies lack automated deletion. [Retention table](data-retention.md). |
| Are backups configured? | [Aurora](../../infra/stacks-new/oxagen/data-services.tf) and [Neo4j DLM](../../infra/modules/app-node/backup.tf). No inference of ClickHouse backup coverage. |
| Have restores met an RTO or RPO? | No dated restore evidence or measured targets supplied. |
| Are changes reviewed and tested? | [Contribution workflow](../../CONTRIBUTING.md) and [CI](../../.github/workflows/pipeline.yml). Inspect exact commits and checks. |
| Are migrations controlled separately? | Partly. On each push to `main`, after checks, tests, and staging pass, the [pipeline's `migration-gate` job](../../.github/workflows/pipeline.yml) applies pending production migrations, Postgres with [apply-postgres-migrations.sh](../../infra/tools/apply-postgres-migrations.sh) and ClickHouse and Neo4j with [db-migrate.ts](../../tools/scripts/db-migrate.ts), then re-checks all three stores, and `deploy-node` waits for it. The [manual DB workflow](../../.github/workflows/db-migrate.yml) and [run-db-migrations.sh](../../infra/tools/run-db-migrations.sh) are the fallback when the gate refuses. `deploy-web` and the break-glass `manual-app-deploy` do not wait for migrations. |
| Is security reporting documented? | Private channels and response targets in [SECURITY.md](../../SECURITY.md). |
| Is incident response effectiveness measured? | No exercise report or response-time evidence supplied. |
| Is data residency guaranteed? | No. Regional AWS configuration does not cover onward model, SMTP, or storage routes. [Recipients](subprocessors.md). |
| Is customer-operated self-hosting verified? | No deployment exercise evidenced by this pack. |
| Is a BAA available? | No executed BAA or HIPAA assessment evidenced. |
| Are data used for provider training? | No universal answer from application source. Obtain selected providers' contractual terms for the actual route. |

Attach deployment evidence, vendor terms, access reviews, and restore records before changing a qualified answer to yes. Keep the source revision and review date with any questionnaire sent outside the repository.
