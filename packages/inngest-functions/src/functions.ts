import { contextLabelsBackfill } from "./functions/context.labels-backfill";
import { steeringSync, steeringSyncSweep } from "./functions/steering.sync";
import { billingDunningSweep } from "./functions/billing.dunning-sweep";
import { billingUsageDelivery } from "./functions/billing.usage-delivery";
import { billingGauClose } from "./functions/billing.gau-close";
import { costRunRollup } from "./functions/cost.run-rollup";
import { runFit } from "./functions/run.fit";
import { costRunProgress } from "./functions/cost.run-progress";
import { tachoSessionIdleClose } from "./functions/tacho.session-idle-close";
import { runLedgerIdleClose } from "./functions/run.ledger-idle-close";
import { costDailyRollup } from "./functions/cost.daily-rollup";
import { costPriceBookSync } from "./functions/cost.price-book-sync";
import { costPriceBookReprice } from "./functions/cost.price-book-reprice";
import { costFindings, costFindingsNightly } from "./functions/cost.findings";
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
import { pluginCatalogSync } from "./functions/plugin.catalog-sync";
import { schemaReconcile } from "./functions/schema.reconcile";
import { memoryDecayPass } from "./functions/memory.decay-pass";
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

// The DurableFunction objects returned by createFunction are also valid Inngest
// function instances at runtime (they are Object.assign-ed Inngest functions).
// We export as any[] so the serve layer can accept them without a type conflict
// between the abstract DurableFunction interface and Inngest's internal Like type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const functions: any[] = [
  contextLabelsBackfill,
  steeringSync,
  steeringSyncSweep,
  billingDunningSweep,
  billingGauClose,
  billingUsageDelivery,
  costRunRollup,
  runFit,
  costRunProgress,
  tachoSessionIdleClose,
  runLedgerIdleClose,
  costDailyRollup,
  costPriceBookSync,
  costPriceBookReprice,
  costFindings,
  costFindingsNightly,
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
  mcpCredentialGrantRetention,
  pluginCatalogSync,
  schemaReconcile,
  memoryDecayPass,
  observabilityCaptureFailure,
  evidenceRunExport,
  evidenceRunExportOnFailure,
  evidenceFrameCompaction,
  evidenceAssistantRunAbandon,
  runEnrich,
  runEnrichOnFailure,
  runEnrichmentSweep,
].filter((fn): fn is NonNullable<typeof fn> => fn != null);
