# Spec: inngest-billing-privacy-playbooks

> Auto-extracted by spec-miner. Last mined: 2026-06-20.
> Source: packages/inngest-functions/src/functions/{billing,stripe,privacy,security,auth,chat,playbook}.*
> Last verified: 2026-06-20 (commit 2f628504)

Background job runners for billing usage rollup & dunning, Stripe invoice/subscription sync, GDPR erasure/export, audit partition rotation, chat message persistence, and playbook execution.

---

### Requirement: Dunning sweep runs daily at 02:00 UTC
<!-- id: billingDunningSweep -->
<!-- entities: Org, OrgBillingSettings -->
<!-- enforced: billing.dunning-sweep.ts(15-50) -->
<!-- depends_on: -->

The system SHALL execute a daily dunning sweep at 02:00 UTC to transition any organizations in 'grace' status whose `graceEndsAt` has elapsed to 'suspended' status. The operation is idempotent and retries up to 3 times on failure. The function runs a secondary check for active organizations with low account balance and dispatches alert notifications to org managers.

#### Scenario: Grace period elapses, org moves to suspended
- **WHEN** a daily cron trigger fires at 02:00 UTC and an organization in 'grace' status has `graceEndsAt <= now`
- **THEN** `sweepDunning()` is invoked and the organization is transitioned to 'suspended' status; function returns count of suspended orgs

#### Scenario: Active org has low balance, manager is notified
- **WHEN** daily cron executes and finds an organization with `dunningState = 'active'` AND `isLowBalance() returns true`
- **THEN** `notifyLowBalance()` is invoked for that org and count of notified orgs is incremented

#### Scenario: Low-balance check fails for an org, sweep continues
- **WHEN** `isLowBalance()` or `notifyLowBalance()` throws an error for an individual org
- **THEN** the error is caught and logged as non-fatal; the sweep continues for remaining orgs

---

### Requirement: Billing usage rollup runs nightly at 01:00 UTC
<!-- id: billingRollupUsage -->
<!-- entities: Subscription, UsageRecord -->
<!-- enforced: billing.rollup-usage.ts(28-148) -->
<!-- depends_on: -->

The system SHALL run a nightly usage rollup at 01:00 UTC across all active subscriptions (status in ['trialing', 'active', 'past_due']). The function computes per-subscription token usage from ClickHouse for the subscription's current billing period and upserts rows into `billing.usage_records` to form the basis for invoice line items. Pagination uses keyset pagination with batch size 200; processing is serial per batch to keep ClickHouse concurrency predictable. The operation is idempotent — a `(subscription_id, metric, period_start, period_end)` unique index ensures on-conflict-do-update semantics.

#### Scenario: Subscriptions are loaded and rolled up in batches
- **WHEN** nightly cron fires at 01:00 UTC
- **THEN** subscriptions are fetched in batches of 200 ordered by `id` (keyset pagination), and for each batch, `sumTokenUsage()` is called with the subscription's current period; usage records are upserted

#### Scenario: No usage in a period, no row is written
- **WHEN** `sumTokenUsage()` for a subscription returns an empty array (no metered tokens in the period)
- **THEN** no row is inserted for that subscription

#### Scenario: Duplicate invocation due to cron retry, idempotency via unique index
- **WHEN** the cron fires twice for the same period and both trigger the rollup
- **THEN** the second invocation's upsert on the `(subscription_id, metric, period_start, period_end)` unique index triggers on-conflict-do-update; quantity and totalCostMicros are updated to the same computed value; no duplication occurs

#### Scenario: Pagination loop terminates correctly
- **WHEN** batch size is less than the page limit (200), indicating the final batch
- **THEN** the keyset pagination loop exits; total processed count is logged

---

### Requirement: Stripe invoice updates are synced to canonical record
<!-- id: stripeSyncInvoice -->
<!-- entities: StripeInvoice -->
<!-- enforced: stripe.sync-invoice.ts(5-16) -->
<!-- depends_on: -->

When Stripe emits an `invoice.updated` webhook event, the system SHALL dispatch an Inngest function to re-sync the canonical invoice record in the Oxagen database. The event carries a `stripeInvoiceId`; the function invokes `syncInvoiceFromStripe()` to fetch the latest invoice state from Stripe and persist changes. The function retries up to 5 times on failure.

#### Scenario: Invoice update event triggers sync
- **WHEN** Stripe webhook event `stripe/invoice.updated` arrives with `{ stripeInvoiceId: "inv_..." }`
- **THEN** `syncInvoiceFromStripe(stripeInvoiceId)` is invoked; completion is logged

#### Scenario: Sync failure is retried
- **WHEN** `syncInvoiceFromStripe()` throws an error
- **THEN** Inngest retries the event delivery up to 5 times with backoff before abandoning

---

### Requirement: Stripe subscription updates are synced to canonical record
<!-- id: stripeSyncSubscription -->
<!-- entities: StripeSubscription, Subscription -->
<!-- enforced: stripe.sync-subscription.ts(9-20) -->
<!-- depends_on: -->

When Stripe emits a `subscription.updated` webhook event, the system SHALL dispatch an Inngest function to re-sync the canonical subscription record. Event-driven architecture decouples the webhook acknowledgement (fast) from the actual sync (async via Inngest), allowing Inngest to retry on Stripe API hiccups. The function invokes `syncSubscriptionFromStripe()` and retries up to 5 times.

#### Scenario: Subscription update event triggers sync
- **WHEN** Stripe webhook event `stripe/subscription.updated` arrives with `{ stripeSubscriptionId: "sub_..." }`
- **THEN** `syncSubscriptionFromStripe(stripeSubscriptionId)` is invoked asynchronously; completion is logged

#### Scenario: Sync failure is retried
- **WHEN** `syncSubscriptionFromStripe()` throws an error
- **THEN** Inngest retries the event delivery up to 5 times with backoff

---

### Requirement: User-scoped GDPR erasure with grace period enforcement
<!-- id: privacyErasureExecute -->
<!-- entities: User, PrivacyErasureRequest, Session -->
<!-- enforced: privacy.erasure.execute.ts(34-130) -->
<!-- depends_on: -->
<!-- triggers: -->

GDPR Article 17 right-to-erasure implementation. When a privacy erasure request is triggered, sessions are revoked immediately. An Inngest function is dispatched with `scheduledAt` set to `now + grace period` (or immediately if `PRIVACY_ERASURE_GRACE_DAYS=0`). The function executes only after `scheduledAt` elapses (via Inngest's `sendAt` scheduling). Steps: (1) mark request as 'processing', (2) for user scope, anonymize the user PII row (displayName, email, avatarUrl), (3) throw `NonRetriableError` to fail the request. The full cascade delete (conversations, messages, api_keys, generated_assets, audit rows, org-scope deletes) is NOT yet implemented (OXA-1721). Until then, the function refuses to mark the request 'completed' so a data subject is never falsely told their data was erased while personal data remains. On failure, the `onFailure` handler marks the request 'failed' and logs the error message for operator follow-up. Concurrency is capped at 2 per `requestId` to prevent race conditions.

#### Scenario: Grace period has elapsed, erasure executes
- **WHEN** Inngest delivers the event after `scheduledAt` has passed
- **THEN** request status is marked 'processing'; user PII is anonymized (displayName="Deleted User", email="{userId}@deleted.invalid", avatarUrl=null); a NonRetriableError is thrown to mark the request failed (pending OXA-1721)

#### Scenario: Clock skew causes early delivery before grace period
- **WHEN** Inngest delivers the event before `scheduledAt` (e.g., clock skew)
- **THEN** `step.sleep()` is called until the scheduled time before proceeding

#### Scenario: Org scope is deferred
- **WHEN** scope is 'org' (cascade delete of all members, workspaces, billing, org row)
- **THEN** the function does not attempt the delete (OXA-1721); throws NonRetriableError

#### Scenario: Function failure is marked in privacy erasure requests
- **WHEN** any step throws an error, the `onFailure` handler is invoked
- **THEN** `privacyErasureRequests` row is updated: status='failed', errorMessage is set, updatedAt is refreshed

---

### Requirement: User-scoped GDPR data export with assembly deferred
<!-- id: privacyExportProcess -->
<!-- entities: User, PrivacyExportRequest -->
<!-- enforced: privacy.export.process.ts(24-90) -->
<!-- depends_on: -->

GDPR Article 20 data portability export. When a privacy export request is triggered, an Inngest function is dispatched to assemble a ZIP archive containing user profile, conversations, api-key metadata, audit log, and generated-asset metadata, upload it to Vercel Blob, and return a signed download URL. Until OXA-1722 ships (ZIP assembly + upload), the function refuses to return a download link marked 'ready' — it throws `NonRetriableError` to fail the request. This keeps the data subject honest: they never receive a broken/fake export link. On failure, the `onFailure` handler marks the request 'failed' with the error message for operator review. Concurrency is capped at 5 per `userId`.

#### Scenario: Export processing starts but assembly is not implemented
- **WHEN** `privacy/export.process` event arrives
- **THEN** request status is marked 'processing'; a NonRetriableError is thrown (pending OXA-1722) with a message "export ZIP assembly not implemented"

#### Scenario: Function failure is marked in privacy export requests
- **WHEN** any step throws an error, the `onFailure` handler is invoked
- **THEN** `privacyExportRequests` row is updated: status='failed', errorMessage is set, updatedAt is refreshed

---

### Requirement: Audit partition rollover monthly with 7-year retention
<!-- id: securityAuditPartitionRollover -->
<!-- entities: SecurityEvent (via pg_class, pg_inherits) -->
<!-- enforced: security.audit-partition-rollover.ts(55-189) -->
<!-- depends_on: -->

Monthly cron (1st of month, 03:00 UTC) that manages Postgres partitions for `security.security_events`. Two idempotent steps: (1) CREATE the next 2 monthly partitions if they don't exist (so future inserts always land in a named partition, never the DEFAULT safety net); (2) DROP any named partition whose entire date range is older than 7 years (SOC2 retention matching ClickHouse `audit_events` TTL). Partition naming: `security_events_<YYYY>_<MM>` (zero-padded month, covering [first of month, first of next month)). The DEFAULT partition is never dropped. Concurrency is limited to 1 to prevent double-create races. System-level DDL via `withSystemDb` (cross-tenant, RLS-bypass).

#### Scenario: Next 2 partitions are created if missing
- **WHEN** cron fires on the 1st at 03:00 UTC
- **THEN** for month M and month M+1, if the partition table does not exist in `pg_class`, execute `CREATE TABLE IF NOT EXISTS security.security_events_YYYY_MM PARTITION OF security.security_events FOR VALUES FROM (start) TO (end)`; log counts of created and skipped partitions

#### Scenario: Expired partitions (>7 years old) are dropped
- **WHEN** a monthly child partition's upper bound (first day of following month) is on or before `now - 7 years`
- **THEN** execute `DROP TABLE IF EXISTS security.{partition_name}`; log partition names dropped

#### Scenario: Partition creation is idempotent
- **WHEN** the CREATE step is retried or executed concurrently
- **THEN** `IF NOT EXISTS` guard plus the `pg_class` check ensure no duplicate creates; skipped count increments

#### Scenario: DEFAULT partition is never dropped
- **WHEN** evaluating partitions for drop, a partition named `security_events_default` is encountered
- **THEN** it is excluded from the drop list (via filter on relname != 'security_events_default')

---

### Requirement: Expired sessions emit TTL sign_out audit events hourly
<!-- id: authSessionExpiryAudit -->
<!-- entities: Session, SecurityEvent -->
<!-- enforced: auth.session-expiry-audit.ts(29-139) -->
<!-- depends_on: -->

Hourly cron (0 * * * *) that bridges a SOC2 CC6.1/CC7.2 gap: Better Auth's `session.delete.after` hook only fires on explicit sign-outs; TTL-expired sessions are silent. This function scans sessions expired within a 25-hour sliding window (to tolerate one missed run) and, via LEFT JOIN on `security_events` with requestId='ttl:' + sessionId, identifies sessions without a TTL sign_out event. For each unprocessed expired session, an `auth.sign_out` event is emitted with `occurredAt = session.expiresAt` and the dedup key. Batch cap of 500 per run; if the limit is hit, a WARN is logged to alert ops of potential backfill need. Concurrency is limited to 1 to prevent double-emit races. Org resolution uses the first (oldest) org membership per user.

#### Scenario: Expired sessions are found and deduped via requestId
- **WHEN** hourly cron fires
- **THEN** sessions with `expiresAt < now AND expiresAt > now - 25 hours` are fetched; a LEFT JOIN on `security_events` filters to those without a matching `requestId='ttl:{sessionId}'` event; UP TO 500 are processed

#### Scenario: Missing org membership falls back to sentinel
- **WHEN** a session's userId has no `orgUsers` row (orphaned user)
- **THEN** org_id is set to the sentinel UUID `00000000-0000-0000-0000-000000000000` in the emitted event

#### Scenario: Batch limit is hit, warning is logged
- **WHEN** exactly `BATCH_SIZE` (500) sessions are found
- **THEN** a WARN is logged: "hit batch cap — additional sessions may remain; will be processed next run"

#### Scenario: No expired unprocessed sessions, function returns early
- **WHEN** no sessions match the expiry window and dedup criteria
- **THEN** function logs "no unprocessed expired sessions" at info level and returns { emitted: 0 }

---

### Requirement: Chat message persistence after streaming completes
<!-- id: chatPersistStream -->
<!-- entities: Message, TokenUsage (ClickHouse) -->
<!-- enforced: chat.persist-stream.ts(17-89) -->
<!-- depends_on: -->

When a streamed assistant turn completes, the event `chat/message.streamed` triggers an Inngest function that performs terminal persistence. The message content is written to `chat.messages` (Postgres transactional state); token usage metrics are written to ClickHouse `token_usage` (append-only telemetry). Postgres update sets message `status='complete'` and persists the final content. For ClickHouse, all required fields are populated with sentinels (provider='', duration_ms=0, prompt_hash='', surface defaults to 'app') when omitted by the event payload (OXA-1498). Retries up to 3 times.

#### Scenario: Message content is persisted and marked complete
- **WHEN** `chat/message.streamed` event arrives with assistantMessageId and final content
- **THEN** the message row is updated: content is set, metadata.status='complete', updatedAt is refreshed

#### Scenario: Token usage is inserted to ClickHouse with all required fields
- **WHEN** tokenUsage is present in the event payload
- **THEN** an ClickHouse `token_usage` row is inserted with execution_step_id, org_id, workspace_id, model, provider (or ''), input/output/cached tokens, cost_micros, duration_ms (or 0), surface (or 'app'), prompt_hash (or ''), created_at

#### Scenario: Missing token usage is a no-op, message is still persisted
- **WHEN** tokenUsage is null or omitted
- **THEN** message is persisted; no ClickHouse insert is attempted

---

### Requirement: Playbook run executes steps end-to-end with event chain hashing
<!-- id: playbookRunExecute -->
<!-- entities: PlaybookRun, PlaybookStepRun, PlaybookEvent, PlaybookApproval -->
<!-- enforced: playbook.run.execute.ts(90-1218) -->
<!-- depends_on: -->
<!-- triggers: -->

Event-driven playbook execution engine. Triggered by `playbook/run.execute` with `{ runId, orgId, workspaceId }`. The function loads a pending run, marks it 'running', and executes the playbook version's steps in topological order (entry step = no incoming edge; traversal via default edges; fallback to insertion order if no edges defined). Steps emit a SHA-256 event chain (each event is hashed with the previous hash + canonical JSON; genesis hash is literal 'genesis'). For each step, a `step_run` row is inserted with status='running', then the step is executed by type:
- **tool**: checks `getCapability().agent.requiresApproval`; if true, pauses with approval record (expires in 7 days); otherwise, invokes the capability via `invoke()` in runner context.
- **agent**: single-shot LLM completion via `generateObjectFor()` with system prompt and interpolated instruction.
- **prompt**: interpolates {{key}} placeholders from run payload; single-shot LLM via `generateObjectFor()`.
- **condition**: evaluates property conditions against run payload; if false and a false-branch edge exists, follows it; otherwise, stops traversal gracefully.
- **webhook**: enforces HTTPS-only; sends `{ runId, payload, stepOutputs }` as JSON; returns statusCode and ok; forbids automatic redirect following.
- **human_input**: pauses run with approval record (expires in 7 days); awaits human action.

Traversal caps at 200 steps to guard against infinite loops via loop_back edges. Step failure handling: if exitOnError=true, run fails immediately; if false, failure is logged and traversal continues. All DB access uses tenant scope via `runInTenantScope`. Terminal events (step_completed/step_failed/run_paused/run_completed) are emitted and hashed. Telemetry is logged to ClickHouse per step (playbook_step.executed) and per run (playbook_run.completed). Concurrency is capped at 20 per org.

#### Scenario: Run is pending, marked running, and execution proceeds
- **WHEN** a `playbook/run.execute` event arrives for a pending run
- **THEN** run status is transitioned to 'running' with startedAt; execution proceeds through steps

#### Scenario: Run is not pending, execution is skipped
- **WHEN** run status is not 'pending' (already running, completed, failed, etc.)
- **THEN** function returns { status: 'skipped', reason: '...' }

#### Scenario: Playbook with no steps completes immediately
- **WHEN** playbook version has zero steps
- **THEN** run is marked completed; stepsExecuted=0; function returns immediately

#### Scenario: Tool step with requiresApproval capability pauses run
- **WHEN** a tool step's capability declares `agent.requiresApproval=true`
- **THEN** approval record is inserted (expires 7 days); run transitions to waiting_approval; traversal stops

#### Scenario: Tool step invocation runs in runner surface context
- **WHEN** a tool step executes (no approval required)
- **THEN** capability is invoked with CapabilityContext { orgId, workspaceId, userId, apiKeyId=null, requestId=stepInvocationId, surface='runner', messageId=runId }

#### Scenario: Condition step evaluates properties and branches
- **WHEN** a condition step's propertyConditions evaluate to true
- **THEN** default-edge next step is followed; if false and false-branch edge exists, false target is followed; if no false-branch, run completes cleanly (no error)

#### Scenario: Webhook step enforces HTTPS and sends payload
- **WHEN** a webhook step executes with config.url and optional headers/method
- **THEN** URL is parsed; if protocol != 'https:', error is thrown; fetch is sent with 10-second timeout, method defaults to POST, redirect='manual' (no follow); statusCode and ok are returned

#### Scenario: Agent step uses single-shot LLM completion
- **WHEN** an agent step executes
- **THEN** `generateObjectFor()` is called with system="You are an autonomous agent step executor...", prompt containing instruction + run payload context; agent returns { output: string }; output is captured

#### Scenario: Prompt step interpolates placeholders and generates text
- **WHEN** a prompt step executes with config.prompt containing {{key}} placeholders
- **THEN** placeholders are replaced with values from run payload (or left as {{key}} if missing); `generateObjectFor()` is called; output is captured

#### Scenario: Human input step pauses for approval
- **WHEN** a human_input step is encountered
- **THEN** approval record is inserted (expires 7 days); run transitions to waiting_approval; traversal stops

#### Scenario: Step failure with exitOnError=true terminates run
- **WHEN** a step throws an error and exitOnError=true
- **THEN** run is marked failed with error message; run_failed event is emitted; function returns { status: 'failed', failedStep }

#### Scenario: Step failure with exitOnError=false continues traversal
- **WHEN** a step throws an error and exitOnError=false
- **THEN** failure is logged; step_run is marked failed; traversal advances to next step (if any)

#### Scenario: Traversal halts at 200-step limit
- **WHEN** stepsExecuted reaches MAX_STEPS (200)
- **THEN** loop breaks; run completes normally (no error)

#### Scenario: Event chain is hashed with SHA-256 and chained
- **WHEN** any event is emitted (run_started, step_started, step_completed, tool_called, tool_completed, condition_evaluated, etc.)
- **THEN** eventHash = SHA-256(prevEventHash + canonical JSON), where canonical is {eventType, eventData, sequence, occurredAt.toISOString()}; prevEventHash is updated for the next event; sequence increments

#### Scenario: Run completes successfully and emits run_completed event
- **WHEN** traversal ends naturally (last step completed, no next edge)
- **THEN** run_completed event is emitted and hashed; run_completed status is set; stepsExecuted is logged; function returns { status: 'completed', stepsExecuted }

#### Scenario: Telemetry is emitted to ClickHouse for each step and run
- **WHEN** a step completes
- **THEN** playbook_step.executed event is written to ClickHouse with step metadata, latencyMs, status, and error; insertToolInvocation() is called with step details; failures are logged but do not block step completion

---

### Requirement: Playbook triggers match entity creation events and dispatch runs
<!-- id: playbookTriggerMatch -->
<!-- entities: PlaybookTrigger, PlaybookRun, Entity -->
<!-- enforced: playbook.trigger.match.ts(132-382) -->
<!-- depends_on: -->
<!-- triggers: playbook.run.execute -->

Event-driven trigger matcher. Subscribed to `ingestion/entity.created` (fired after step 4 upsert-node in the ingestion pipeline). For the created entity, loads all enabled event triggers in the workspace that match: (1) triggerType='event', (2) isEnabled=true, (3) config.entityType matches the entity type, (4) config.eventType='node.created' or undefined. For each candidate trigger, evaluates config.propertyConditions against the entity's propertiesSnapshot (all conditions must pass: AND semantics; empty conditions array matches unconditionally). If conditions pass, inserts a `playbookRuns` row (status='pending', source='event', startedByUserId=null, input contains { nodeId, entityType, naturalKey, isNew, properties }) and immediately dispatches `playbook/run.execute` to the Inngest queue. Telemetry: one `events` ClickHouse row per match outcome (evaluated, matched, dispatched) for per-trigger analytics. Concurrency is capped at 16 per org.

#### Scenario: Entity creation event arrives, candidate triggers are loaded
- **WHEN** `ingestion/entity.created` event arrives with { nodeId, entityType, propertiesSnapshot, workspaceId, orgId, ... }
- **THEN** enabled event triggers for (orgId, workspaceId) with config.entityType matching are loaded; candidates are filtered

#### Scenario: Property conditions match, run is dispatched
- **WHEN** a candidate trigger's config.propertyConditions are evaluated via `evaluatePropertyConditions()` and all pass
- **THEN** a `playbookRuns` row is inserted with status='pending'; `playbook/run.execute` event is sent to Inngest immediately; run is logged and added to dispatchedRunIds

#### Scenario: Property conditions fail to match, trigger is skipped
- **WHEN** `evaluatePropertyConditions()` returns false for a candidate trigger
- **THEN** the trigger is skipped; no run is created; logged at debug level

#### Scenario: No candidate triggers for entity type, function returns early
- **WHEN** no enabled event triggers match config.entityType or entityType is not in the workspace
- **THEN** function returns { evaluated: 0, matched: 0, dispatched: 0 }

#### Scenario: Playbook has no active version, run is not dispatched
- **WHEN** a matched trigger's playbook is found but activeVersionId is null or missing
- **THEN** the trigger is skipped; a warning is logged; no run is created

#### Scenario: Pinned version is used if available
- **WHEN** a trigger has pinnedVersionId set
- **THEN** the run is created with playbookVersionId=pinnedVersionId (not playbook.activeVersionId)

#### Scenario: Telemetry is written to ClickHouse (fire-and-forget)
- **WHEN** evaluation and dispatch complete
- **THEN** playbook_trigger.evaluated row is written (candidateCount, matchedCount, dispatchedCount); one playbook_trigger.dispatched row per dispatched run; telemetry failures are logged and do not block dispatch

---

### Invariant: Inngest functions are idempotent at step boundaries
<!-- entities: PlaybookRun, UsageRecord, SecurityEvent -->
<!-- enforced: createFunction, step.run patterns -->

All Inngest functions use `step.run()` to wrap side effects, ensuring atomicity and idempotency at step boundaries. A step is retried as a whole if Inngest fails; a successful step.run() result is cached and returned without re-execution on retry.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: System-level database operations bypass RLS via withSystemDb
<!-- entities: All -->
<!-- enforced: OXA-1515 cross-tenant boundary design -->

Cron jobs and system-scoped operations (partition rollover, session expiry audit, privacy erasure/export, dunning sweep, usage rollup) use `withSystemDb()` for cross-tenant reads and writes. Single-tenant operations (chat persistence, playbook execution when triggered within a workspace) use `withTenantDb()` via `runInTenantScope()`. This enforces the tenancy boundary: system-level operations explicitly bypass RLS; tenant-scoped operations are guarded by RLS.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Scheduled events are idempotent on collision
<!-- entities: UsageRecord, PlaybookEvent, SecurityEvent, PrivacyErasureRequest -->
<!-- enforced: Unique constraints, on-conflict-do-update patterns -->

Idempotency for scheduled crons is guaranteed by:
- **Billing rollup**: `(subscription_id, metric, period_start, period_end)` unique index on `usageRecords` with on-conflict-do-update.
- **Partition rollover**: `IF NOT EXISTS` on CREATE TABLE + pg_class check before creation.
- **Session expiry audit**: LEFT JOIN on `security_events` using requestId='ttl:' + sessionId deduplicates across retries.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Event chains in playbook runs are tamper-evident
<!-- entities: PlaybookEvent -->
<!-- enforced: computeEventHash in playbook.run.execute.ts -->

Every event emitted in a playbook run is appended to `playbook_events` with a SHA-256 hash chain. Each event's `eventHash = SHA-256(prevEventHash || canonical(eventType, eventData, sequence, occurredAt))`. The first event uses prevEventHash='genesis'. This ensures run history is tamper-evident: any modification to an earlier event invalidates all downstream hashes.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: GDPR compliance gates are fail-loud when cascade is incomplete
<!-- entities: User, Org, PrivacyErasureRequest, PrivacyExportRequest -->
<!-- enforced: NonRetriableError patterns in privacy.* functions -->

Erasure (OXA-1721) and export (OXA-1722) cascades are incomplete. Rather than returning partial results, both functions throw `NonRetriableError`, which routes to the `onFailure` handler and marks the request 'failed'. This prevents false GDPR claims: a data subject is never told their data was erased or exported while personal data remains in the system.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Concurrency is limited per resource to prevent races
<!-- entities: PlaybookRun, PrivacyErasureRequest, PrivacyExportRequest, SecurityEvent, Session -->
<!-- enforced: createFunction concurrency config -->

Concurrency limits prevent race conditions:
- **auth.session-expiry-audit**: limit=1 (prevents double-emit of TTL sign_out events)
- **security.audit-partition-rollover**: limit=1 (prevents double-create of partitions)
- **privacy.erasure.execute**: limit=2 per requestId (per-request serialization)
- **privacy.export.process**: limit=5 per userId (per-user rate limiting)
- **playbook.run.execute**: limit=20 per orgId (org-level concurrency cap)
- **playbook.trigger.match**: limit=16 per orgId (org-level concurrency cap)

> Last verified: 2026-06-20 (commit 2f628504)
