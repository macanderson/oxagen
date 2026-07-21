import { billingDunningSweep } from "./functions/billing.dunning-sweep";
import { stripeSyncSubscription } from "./functions/stripe.sync-subscription";
import { stripeSyncInvoice } from "./functions/stripe.sync-invoice";
import { chatPersistStream } from "./functions/chat.persist-stream";
import { agentExecuteSubagent } from "./functions/agent.execute-subagent";
import { agentAggregateFanout } from "./functions/agent.aggregate-fanout";
import { webSearchIngestGraph } from "./functions/web.search.ingest-graph";
import { agentBackgroundTaskExecute } from "./functions/agent.background-task.execute";
import {
  agentVideoRender,
  agentVideoRenderOnFailure,
} from "./functions/agent.video-render";
import { securityAuditPartitionRollover } from "./functions/security.audit-partition-rollover";
import { pluginOauthRefreshWatcher } from "./functions/plugin.oauth-refresh-watcher";
import { agentWorkflowSupervisor } from "./functions/agent.workflow.supervisor";
import { agentWorkflowTaskExecute } from "./functions/agent.workflow.task.execute";
import { agentSyncExecutionToGraph } from "./functions/agent.sync-execution-to-graph";
import { agentProjectFileLockToGraph } from "./functions/agent.project-file-lock-to-graph";
import { agentLeaseSweep } from "./functions/agent.lease-sweep";
import { agentSandboxReaper } from "./functions/agent.sandbox-reaper";
import { contentSyncGeneratedFileToGraph } from "./functions/content.sync-generated-file-to-graph";
import {
  privacyExportProcess,
  privacyExportProcessOnFailure,
} from "./functions/privacy.export.process";
import {
  privacyErasureExecute,
  privacyErasureExecuteOnFailure,
} from "./functions/privacy.erasure.execute";
import { authSessionExpiryAudit } from "./functions/auth.session-expiry-audit";
import { ingestionPipeline } from "./functions/ingestion.pipeline";
import {
  ingestionDeleteConnection,
  ingestionDeleteConnectionOnFailure,
} from "./functions/ingestion.delete";
import { ingestionOauthRefresh } from "./functions/ingestion.oauth-refresh";
import { ingestionGithubInitialSync } from "./functions/ingestion.github-initial-sync";
import { ingestionGithubCommitFiles } from "./functions/ingestion.github-commit-files";
import { ingestionGithubParseFile } from "./functions/ingestion.github-parse-file";
import { ingestionRepositoryRefUpdated } from "./functions/ingestion.repository-ref-updated";
import { ingestionGenerationFileDone } from "./functions/ingestion.generation-file-done";
import { ingestionRepositoryReconcile } from "./functions/ingestion.repository-reconcile";
import { ingestionGithubInferFeatures } from "./functions/ingestion.github-infer-features";
import { ingestionGithubInferFeaturesBatch } from "./functions/ingestion.github-infer-features-batch";
import { ingestionGithubInferDomains } from "./functions/ingestion.github-infer-domains";
import { ingestionSemanticEdgeInfer } from "./functions/ingestion.semantic-edge-infer";
import { ingestionBatchReconcile } from "./functions/ai.batch-reconcile";
import { ingestionSyncRequested } from "./functions/ingestion.sync-requested";
import { ingestionPollScheduler } from "./functions/ingestion.poll-scheduler";
import { ingestionConnectionPoll } from "./functions/ingestion.connection-poll";
import { ingestionWebhookProvision } from "./functions/ingestion.webhook-provision";
import { ingestionWebhookRenew } from "./functions/ingestion.webhook-renew";
import {
  playbookTriggerMatch,
  playbookTriggerMatchUpdated,
} from "./functions/playbook.trigger.match";
import { playbookRunExecute } from "./functions/playbook.run.execute";
import { mcpToolSnapshotRetention } from "./functions/mcp.tool-snapshot-retention";
import { pluginCatalogSync } from "./functions/plugin.catalog-sync";
import { schemaReconcile } from "./functions/schema.reconcile";
import { engramSyncMemoryToGraph } from "./functions/engram.sync-memory-to-graph";
import { engramEmbedMemory } from "./functions/engram.embed-memory";
import { engramConsolidationRun } from "./functions/engram.consolidation.run";
import { memoryDecayPass } from "./functions/memory.decay-pass";
import { observabilityCaptureFailure } from "./functions/observability.capture-failure";
import { evalRunExecute } from "./functions/eval.run.execute";

// The DurableFunction objects returned by createFunction are also valid Inngest
// function instances at runtime (they are Object.assign-ed Inngest functions).
// We export as any[] so the serve layer can accept them without a type conflict
// between the abstract DurableFunction interface and Inngest's internal Like type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const functions: any[] = [
  billingDunningSweep,
  stripeSyncSubscription,
  stripeSyncInvoice,
  chatPersistStream,
  agentExecuteSubagent,
  agentAggregateFanout,
  webSearchIngestGraph,
  agentBackgroundTaskExecute,
  agentVideoRender,
  agentVideoRenderOnFailure,
  securityAuditPartitionRollover,
  pluginOauthRefreshWatcher,
  agentWorkflowSupervisor,
  agentWorkflowTaskExecute,
  agentSyncExecutionToGraph,
  agentProjectFileLockToGraph,
  agentLeaseSweep,
  agentSandboxReaper,
  contentSyncGeneratedFileToGraph,
  privacyExportProcess,
  privacyExportProcessOnFailure,
  privacyErasureExecute,
  privacyErasureExecuteOnFailure,
  authSessionExpiryAudit,
  ingestionPipeline,
  ingestionDeleteConnection,
  ingestionDeleteConnectionOnFailure,
  ingestionOauthRefresh,
  ingestionGithubInitialSync,
  ingestionGithubCommitFiles,
  ingestionGithubParseFile,
  ingestionRepositoryRefUpdated,
  ingestionGenerationFileDone,
  ingestionRepositoryReconcile,
  ingestionGithubInferFeatures,
  ingestionGithubInferFeaturesBatch,
  ingestionGithubInferDomains,
  ingestionSemanticEdgeInfer,
  ingestionBatchReconcile,
  ingestionSyncRequested,
  ingestionPollScheduler,
  ingestionConnectionPoll,
  ingestionWebhookProvision,
  ingestionWebhookRenew,
  playbookTriggerMatch,
  playbookTriggerMatchUpdated,
  playbookRunExecute,
  mcpToolSnapshotRetention,
  pluginCatalogSync,
  schemaReconcile,
  engramSyncMemoryToGraph,
  engramEmbedMemory,
  engramConsolidationRun,
  memoryDecayPass,
  observabilityCaptureFailure,
  evalRunExecute,
].filter((fn): fn is NonNullable<typeof fn> => fn != null);
