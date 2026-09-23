# Security questionnaire

Use these answers for an initial procurement review of identity, authority, credentials, and records. This is an original short questionnaire, not a completed licensed CAIQ or SIG instrument. The [pack baseline](README.md) defines the source reviewed. “Implemented” describes code and requires production evidence before it becomes an assurance about operation.

| Question | Answer and evidence |
| --- | --- |
| Is a SOC 2 report available? | No report evidenced. See [readiness](soc2-readiness.md). |
| Has an independent penetration test completed? | No report evidenced. [#3758](https://github.com/macanderson/oxagen/issues/3758). |
| Is a signed DPA available? | This pack contains a [draft](dpa-template.md), not an executed agreement. |
| Are processor locations documented? | [Recipient inventory](subprocessors.md) distinguishes AWS region from unverified vendor locations. Contract schedule remains incomplete. |
| Does every agent have an identity? | New registered agents receive delegated principals, but the [agent schema](../../packages/database/src/schema/agent.ts) permits a null principal. Legacy agents and the [workspace qa-chat bootstrap](../../packages/handlers/src/workspace-agents.ts) may lack one. Confirm provisioning before making an every-agent claim. |
| Are roles checked? | [IAM](../../packages/iam/src/check-iam.ts) and sensitive handler checks apply to governed calls. Tier-dependent fast paths and runtime bootstrap require review. |
| Is tenant isolation implemented? | Postgres RLS and scoped transactions: [tenant helper](../../packages/database/src/tenant.ts), [scope](../../packages/tenancy/src/scope.ts). Dedicated system operations use explicit bypass. |
| Are machine credentials scoped? | [Machine-key scope](../../packages/iam/src/machine-key-scope.ts) checks credential purpose and context. |
| Is MFA available? | TOTP plugin in [authentication](../../packages/auth/src/auth.ts). No claim of universal mandatory MFA. |
| Are passkeys supported? | No passkey plugin in this baseline. |
| Is enterprise SSO available? | [#3735](https://github.com/macanderson/oxagen/pull/3735) is outside this baseline. Verify merged and deployed status before answering yes. |
| Does IdP deprovisioning revoke credentials? | SCIM is not implemented. [#3734](https://github.com/macanderson/oxagen/issues/3734). |
| Do login cookies expire? | Thirty days, refreshed after one day in [auth](../../packages/auth/src/auth.ts). |
| Is access review periodically performed? | No operating access-review evidence supplied. [#3757](https://github.com/macanderson/oxagen/issues/3757). |
| Are secrets field-encrypted? | [Envelope encryption](../../packages/crypto/src/envelope.ts) and [credential resolver](../../packages/plugins/src/credentials/kms.ts) implement specific paths. [OAuth hook limits](../../packages/auth/src/token-encryption.ts) prevent a universal yes. |
| Is stored infrastructure data encrypted? | [Aurora](../../infra/stacks-new/oxagen/data-services.tf) and [node volumes](../../infra/modules/app-node/main.tf) configure encryption. Verify deployed settings. |
| Is public traffic encrypted? | Public TLS terminates at the [ALB](../../infra/stacks-new/oxagen/main.tf). The ALB forwards HTTP to [Caddy](../../infra/tools/caddy/Caddyfile.alb) on the node through a restricted security group; that hop is not encrypted. |
| Are model credentials hidden from the harness? | Supported host custody paths exist in [credential store](../../packages/tacho/src/host/credential-store.ts). Host-owner access remains possible. |
| Can an operator approve or deny governed work? | [Approval runtime](../../packages/agent/src/runtime/approval.ts) and [decision capability](../../packages/oxagen/src/contracts/agent.approval.resolve.ts). |
| Do hooks contain a process? | No. [Vision](../VISION.md) distinguishes hook controls from the unbuilt contained tier. |
| Does a budget stop all spending? | No universal claim. [Proxy](../../packages/tacho/src/collector/model-proxy.ts) checks routed requests. Verify source-to-bundle propagation and the supported harness. |
| Is action history retained? | [Run ledger](../../packages/run-ledger/src/run-store.ts), security events, and telemetry have different records and retention. [Retention table](data-retention.md). |
| Can records be checked offline? | [Export guide](../guides/export-and-verify.md) describes integrity verification. It does not establish source completeness. |
| Is full subject erasure automated? | No. [Erasure processor](../../packages/inngest-functions/src/functions/privacy.erasure.execute.ts) reports incomplete multi-store cleanup. |
| Is there a defined retention policy? | Yes, but some policies lack automated deletion. [Retention table](data-retention.md). |
| Are backups configured? | [Aurora](../../infra/stacks-new/oxagen/data-services.tf) and [Neo4j DLM](../../infra/modules/app-node/backup.tf). No inference of ClickHouse backup coverage. |
| Have restores met an RTO or RPO? | No dated restore evidence or measured targets supplied. |
| Are changes reviewed and tested? | [Contribution workflow](../../CONTRIBUTING.md) and [CI](../../.github/workflows/pipeline.yml). Inspect exact commits and checks. |
| Are migrations controlled separately? | [Manual DB workflow](../../.github/workflows/db-migrate.yml) and production deployment gate. |
| Is security reporting documented? | Private channels and response targets in [SECURITY.md](../../SECURITY.md). |
| Is incident response effectiveness measured? | No exercise report or response-time evidence supplied. |
| Is data residency guaranteed? | No. Regional AWS configuration does not cover onward model, SMTP, or storage routes. [Recipients](subprocessors.md). |
| Is customer-operated self-hosting verified? | No deployment exercise evidenced by this pack. |
| Is a BAA available? | No executed BAA or HIPAA assessment evidenced. |
| Are data used for provider training? | No universal answer from application source. Obtain selected providers' contractual terms for the actual route. |

Attach deployment evidence, vendor terms, access reviews, and restore records before changing a qualified answer to yes. Keep the source revision and review date with any questionnaire sent outside the repository.
