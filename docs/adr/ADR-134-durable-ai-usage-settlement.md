# ADR-134: Durable AI usage settlement

Status: Accepted for implementation. Production migration application is separate.

## Context

The AI wrappers wrote usage and charged credits independently. Both failures were swallowed. A ClickHouse outage could erase the usage behind a completed debit. Retrying a debit could charge the same call twice, including its fractional credit carry. Issue #2972 requires durable delivery and a debit identity.

## Decision

Create one UUID admission per provider operation before contacting the provider. A message can contain several operations, so its message ID remains a correlation field and cannot serve as the debit identity. Cache hits create no admission. The streaming wrapper uses the awaited `prepareStep` hook. AI SDK 7's notification hooks swallow callback errors, so `onStart` cannot enforce admission.

Persist the completed usage and frozen charge terms before settlement. Keep this temporary delivery body in `billing.usage_outbox` on the shared Postgres plane. This is transactional delivery state, not an analytics source. Scope validation and explicit organisation and workspace predicates fence request writes. Dedicated data-plane tenants still settle platform billing on the shared plane.

Lock the admission before settling it. The credit carry, credit lots, credit ledger, spend counter, and settlement marker commit in one transaction. A second finalizer or concurrent worker sees the marker and cannot repeat those writes. If settlement fails, the staged usage remains available for retry. No customer debit can commit without that durable usage body.

The scheduled worker retries pending settlements and deliveries with per-row backoff. It holds one admission lock for each delivery. It does not discard a row after a retry limit. A delivery acknowledgment clears the temporary body and charge instructions. The admission identity remains to reject repeated settlement.

ClickHouse receives new rows in `durable_token_usage`, a `ReplacingMergeTree` keyed by the stable call UUID and its fixed scope and timestamp. The `metered_token_usage` view combines historical `token_usage` rows with `durable_token_usage FINAL`. Existing aggregation paths read the view. A lost insert acknowledgment can cause another physical row, but readers count the operation once. This does not depend on a finite insert-deduplication window. Both tables retain the existing 365-day analytics retention.

## Interrupted calls and limits

An aborted stream or later-step provider error settles the usage reported for completed steps. The provider may not report usage for its interrupted step. The admission remains marked incomplete even when some usage was settled. The worker counts and logs admissions still incomplete after one hour. A process crash or Postgres outage after the provider starts can also leave an incomplete admission. These records need reconciliation. They are not priced as zero, deleted, or claimed to contain token counts the provider never returned.

Admission failure prevents the provider request. Settlement failure propagates through the object and embedding wrappers. Streaming SDK notification semantics can absorb a finalizer failure, so the wrapper also emits a structured error and retains its durable admission. This change does not make the provider call and Postgres commit one distributed transaction.

## Verification and deployment

Apply the Postgres admission migration and ClickHouse table/view migration before deploying the wrappers and delivery worker. Existing writers continue using the historical table until deployment. No existing usage rows are rewritten or deleted.

Postgres integration tests exercise rollback after a real credit debit, concurrent finalizers, repeated correlation IDs, retained failed delivery, and cross-tenant refusal. ClickHouse integration tests deliver the same call twice and another call with the same execution step, then assert the unified aggregation counts two calls. Provider tests check admission refusal, durable finalization, and partial cancellation. CI executes these tests. No additional local test run is part of this batch.

The remaining #2972 requirements for system-database role isolation, a shrinking bypass baseline, historical migration evidence, and audit partitions are separate. This decision does not mark that issue complete.
