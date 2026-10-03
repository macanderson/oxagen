import { contextLabelsBackfill } from "./functions/context.labels-backfill";
import {
  workIntakeCheck,
  workIntakeCollect,
  workIntakeCountSweep,
  workIntakePrune,
  workIntakeSweep,
  workIntakeTriage,
  workIntakeTriageOnFailure,
} from "./functions/work.intake";
import { steeringSync, steeringSyncSweep } from "./functions/steering.sync";
import { mcpServerDiscover } from "./functions/mcp-server.discover";
import { mcpServerSync } from "./functions/mcp-server.sync";
import { steeringRepoProvision } from "./functions/steering-repo.provision";
import { steeringRepoBackfill } from "./functions/steering-repo.backfill";
import {
  steeringRepoHealthCheck,
  steeringRepoSweep,
} from "./functions/steering-repo.sweep";
import { billingDunningSweep } from "./functions/billing.dunning-sweep";
import { billingUsageDelivery } from "./functions/billing.usage-delivery";
import { billingGauClose } from "./functions/billing.gau-close";
import { costRunRollup } from "./functions/cost.run-rollup";
import { runFit } from "./functions/run.fit";
import { runReflect } from "./functions/run.reflect";
import { memoryCurate, memoryCurateDaily } from "./functions/memory.curate";
import { costRunProgress } from "./functions/cost.run-progress";
import { tachoSessionIdleClose } from "./functions/tacho.session-idle-close";
import { runLedgerIdleClose } from "./functions/run.ledger-idle-close";
import { costDailyRollup } from "./functions/cost.daily-rollup";
import { costPriceBookSync } from "./functions/cost.price-book-sync";
import { costPriceBookReprice } from "./functions/cost.price-book-reprice";
import { costFindings, costFindingsNightly } from "./functions/cost.findings";
import {
  costRunPrOutcomesDelivery,
  costRunPrOutcomesHourly,
} from "./functions/cost.run-pr-outcomes";
import { costWorkOrderSendBackHourly } from "./functions/cost.work-order-send-back";
import { securityAuditPartitionRollover } from "./functions/security.audit-partition-rollover";
import { pluginOauthRefreshWatcher } from "./functions/plugin.oauth-refresh-watcher";
import {
  privacyExportProcess,
  privacyExportProcessOnFailure,
} from "./functions/privacy.export.process";
import {
  privacyErasureExecute,
  privacyErasureExecuteOnFailure,
} from "./functions/privacy.erasure.execute";
import { authSessionExpiryAudit } from "./functions/auth.session-expiry-audit";
import {
  authSsoResealDaily,
  authSsoResealRequested,
} from "./functions/auth.sso-reseal";
import { approvalResume } from "./functions/approval.resume";
import { mandateExpiry } from "./functions/mandate.expiry";
import { ingestionPipeline } from "./functions/ingestion.pipeline";
import {
  ingestionDeleteConnection,
  ingestionDeleteConnectionOnFailure,
} from "./functions/ingestion.delete";
import { ingestionOauthRefresh } from "./functions/ingestion.oauth-refresh";
import { ingestionGithubInitialSync } from "./functions/ingestion.github-initial-sync";
import { ingestionSyncRequested } from "./functions/ingestion.sync-requested";
import { ingestionPollScheduler } from "./functions/ingestion.poll-scheduler";
import { ingestionConnectionPoll } from "./functions/ingestion.connection-poll";
import { ingestionWebhookProvision } from "./functions/ingestion.webhook-provision";
import { ingestionWebhookRenew } from "./functions/ingestion.webhook-renew";
import { mcpToolSnapshotRetention } from "./functions/mcp.tool-snapshot-retention";
import { mcpCredentialGrantRetention } from "./functions/mcp.credential-grant-retention";
import { assistantAttachmentSweep } from "./functions/assistant.attachment-sweep";
import { pluginCatalogSync } from "./functions/plugin.catalog-sync";
import { schemaReconcile } from "./functions/schema.reconcile";
import { memoryDecayPass } from "./functions/memory.decay-pass";
import { stellaSessionArchive } from "./functions/stella.session-archive";
import {
  embeddingsBackfill,
  embeddingsBackfillSchedule,
} from "./functions/embeddings.backfill";
import { observabilityCaptureFailure } from "./functions/observability.capture-failure";
import {
  evidenceRunExport,
  evidenceRunExportOnFailure,
} from "./functions/evidence.run-export";
import { evidenceFrameCompaction } from "./functions/evidence.frame-compaction";
import { evidenceAssistantRunAbandon } from "./functions/evidence.assistant-run-abandon";
import {
  runEnrich,
  runEnrichOnFailure,
  runEnrichmentSweep,
} from "./functions/run.enrich";
import { runEnrichScratchExpire } from "./functions/run.enrich-scratch-expire";
import { runPullRequestBackfill } from "./functions/run.pull-request-backfill";
import { forgePullRequestSync } from "./functions/forge.pull-request-sync";
import { forgePullRequestBackfill } from "./functions/forge.pull-request-backfill";
import { workOrderPullRequestLinked, workOrderRunEnded } from "./functions/work.order-results";
import { agentInterjectionTimeout } from "./functions/agent.interjection-timeout";
import { agentInterjectionTimeoutSweep } from "./functions/agent.interjection-timeout-sweep";
import { conversationTitle } from "./functions/conversation.title";
import { codeRepoCheck } from "./functions/code-repo.check";

// The DurableFunction objects returned by createFunction are also valid Inngest
// function instances at runtime (they are Object.assign-ed Inngest functions).
// We export as any[] so the serve layer can accept them without a type conflict
// between the abstract DurableFunction interface and Inngest's internal Like type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const functions: any[] = [
  contextLabelsBackfill,
  // Work intake and triage (P1-03, #5103).
  workIntakeCollect,
  workIntakeSweep,
  workIntakeCountSweep,
  workIntakeCheck,
  workIntakeTriage,
  workIntakeTriageOnFailure,
  workIntakePrune,
  steeringSync,
  steeringSyncSweep,
  steeringRepoProvision,
  steeringRepoBackfill,
  steeringRepoSweep,
  steeringRepoHealthCheck,
  billingDunningSweep,
  billingGauClose,
  billingUsageDelivery,
  costRunRollup,
  runFit,
  runReflect,
  memoryCurate,
  memoryCurateDaily,
  costRunProgress,
  tachoSessionIdleClose,
  runLedgerIdleClose,
  costDailyRollup,
  costPriceBookSync,
  costPriceBookReprice,
  costFindings,
  costFindingsNightly,
  costRunPrOutcomesHourly,
  costRunPrOutcomesDelivery,
  // Post each send-back note on a schedule (R3, #5108).
  costWorkOrderSendBackHourly,
  securityAuditPartitionRollover,
  pluginOauthRefreshWatcher,
  privacyExportProcess,
  privacyExportProcessOnFailure,
  privacyErasureExecute,
  privacyErasureExecuteOnFailure,
  authSessionExpiryAudit,
  authSsoResealDaily,
  authSsoResealRequested,
  mandateExpiry,
  approvalResume,
  ingestionPipeline,
  ingestionDeleteConnection,
  ingestionDeleteConnectionOnFailure,
  ingestionOauthRefresh,
  ingestionGithubInitialSync,
  ingestionSyncRequested,
  ingestionPollScheduler,
  ingestionConnectionPoll,
  ingestionWebhookProvision,
  ingestionWebhookRenew,
  mcpToolSnapshotRetention,
  mcpServerDiscover,
  mcpServerSync,
  mcpCredentialGrantRetention,
  assistantAttachmentSweep,
  pluginCatalogSync,
  schemaReconcile,
  memoryDecayPass,
  stellaSessionArchive,
  embeddingsBackfill,
  embeddingsBackfillSchedule,
  observabilityCaptureFailure,
  evidenceRunExport,
  evidenceRunExportOnFailure,
  evidenceFrameCompaction,
  evidenceAssistantRunAbandon,
  runEnrich,
  runEnrichOnFailure,
  runEnrichmentSweep,
  runEnrichScratchExpire,
  runPullRequestBackfill,
  forgePullRequestSync,
  // Move links recorded before the forge store existed into it (ADR-292).
  forgePullRequestBackfill,
  workOrderRunEnded,
  workOrderPullRequestLinked,
  agentInterjectionTimeout,
  agentInterjectionTimeoutSweep,
  conversationTitle,
  codeRepoCheck,
].filter((fn): fn is NonNullable<typeof fn> => fn != null);
