# SOC 2 readiness

Your audit needs evidence of operating controls as well as code. No SOC 2 report or signed auditor engagement is evidenced by this repository review. Do not describe the audit as in progress until the engagement is recorded.

The [AICPA trust services criteria](https://www.aicpa-cima.com/resources/download/2017-trust-services-criteria-with-revised-points-of-focus-2022) cover security, availability, processing integrity, confidentiality, and privacy. The auditor and contracting entity must agree the applicable scope. The mapping below is a readiness aid, not an assessment against every criterion.

| Area | Repository evidence | Missing operating evidence or control |
| --- | --- | --- |
| Control environment and ownership | [Contribution rules](../../CONTRIBUTING.md), [security reporting](../../SECURITY.md) | Named control owners, personnel policies, training records, approved risk register, and management review |
| Logical access | [Auth](../../packages/auth/src/auth.ts), [IAM](../../packages/iam/src/check-iam.ts), [tenant transactions](../../packages/database/src/tenant.ts) | Recurring access review, joiner/mover/leaver evidence, a live IdP exercise of [SCIM](../../packages/handlers/src/scim.request.ts) ([#3734](https://github.com/macanderson/oxagen/issues/3734)), and production configuration inspection |
| System operations | [Alarms and log archive](../../infra/stacks-new/oxagen/observability.tf), [audit maintenance](../../packages/inngest-functions/src/functions/security.audit-partition-rollover.ts) | Alert response samples, incident exercise, and independent penetration test |
| Change management | [CI](../../.github/workflows/pipeline.yml), [migration workflow](../../.github/workflows/db-migrate.yml), PR history | Selected samples linking approval, tested commit, database state, and actual deployed artifact |
| Availability | [Aurora backups](../../infra/stacks-new/oxagen/data-services.tf), [Neo4j snapshots](../../infra/modules/app-node/backup.tf) | Restore drill, measured RTO/RPO, capacity review, and verified coverage for other stores |
| Processing integrity | [Kernel contracts](../../packages/oxagen/src/kernel.ts), [run ledger](../../packages/run-ledger/src/run-store.ts), [billing](../../packages/billing/src/action-metering.ts) | Control reconciliations, exception handling samples, and period evidence |
| Confidentiality | [Envelope encryption](../../packages/crypto/src/envelope.ts), [OAuth hook limitations](../../packages/auth/src/token-encryption.ts) | Approved classification, rotation evidence, full recipient schedule, and remediation of incomplete encryption paths |
| Privacy | [Request handlers](../../packages/handlers/src/privacy.data.erase.ts), [data map](pii-inventory.md), [retention](data-retention.md) | Complete current data inventory, full erasure, signed processing terms, transfer review, and rights-request exercise |

## External decisions

| Decision | Handoff | Cost status |
| --- | --- | --- |
| Select an auditor and report scope | [#3756](https://github.com/macanderson/oxagen/issues/3756), with the [decision prepared on 2026-09-23](https://github.com/macanderson/oxagen/issues/3756#issuecomment-5800937888) | No quote obtained. The decision carries published price bands, not quotes. The estimate remains unpriced until written scope and at least two quotes exist. |
| Choose manual or vendor-assisted evidence collection | [#3757](https://github.com/macanderson/oxagen/issues/3757) | No quote obtained. Compare software fees and recurring staff time. |
| Select an independent penetration tester | [#3758](https://github.com/macanderson/oxagen/issues/3758) | No quote obtained. Require remediation retest costs in the estimate. |

The source does not support a dollar estimate or an audit completion date. Record those figures from vendor quotes and the agreed evidence period. Shipping this pack does not engage a vendor, accept a contract, or produce an attestation.

## Evidence register

For each control, retain its accountable owner, source revision, production configuration capture, operating sample dates, exceptions, reviewer, and review date. Keep secrets and full personal data out of public issue bodies. Store private findings in the approved restricted system and link only their identifiers from the handoff.
