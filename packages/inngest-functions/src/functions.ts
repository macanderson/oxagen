import { billingRollupUsage } from "./functions/billing.rollup-usage";
import { billingDunningSweep } from "./functions/billing.dunning-sweep";
import { stripeSyncSubscription } from "./functions/stripe.sync-subscription";
import { stripeSyncInvoice } from "./functions/stripe.sync-invoice";
import { chatPersistStream } from "./functions/chat.persist-stream";
import { agentExecuteSubagent } from "./functions/agent.execute-subagent";
import { agentBackgroundTaskExecute } from "./functions/agent.background-task.execute";
import { agentVideoRender, agentVideoRenderOnFailure } from "./functions/agent.video-render";
import { securityAuditPartitionRollover } from "./functions/security.audit-partition-rollover";
import { pluginCatalogSyncCron } from "./functions/plugin.catalog-sync-cron";
import { pluginRegistrySync } from "./functions/plugin.registry-sync";
import { pluginOauthRefreshWatcher } from "./functions/plugin.oauth-refresh-watcher";
import { agentWorkflowSupervisor } from "./functions/agent.workflow.supervisor";
import { agentWorkflowTaskExecute } from "./functions/agent.workflow.task.execute";
import { agentSyncExecutionToGraph } from "./functions/agent.sync-execution-to-graph";
import { privacyExportProcess, privacyExportProcessOnFailure } from "./functions/privacy.export.process";
import { privacyErasureExecute, privacyErasureExecuteOnFailure } from "./functions/privacy.erasure.execute";
import { authSessionExpiryAudit } from "./functions/auth.session-expiry-audit";
import { ingestionPipeline } from "./functions/ingestion.pipeline";
import { ingestionDeleteConnection } from "./functions/ingestion.delete";
import { ingestionOauthRefresh } from "./functions/ingestion.oauth-refresh";
import { ingestionGithubInitialSync } from "./functions/ingestion.github-initial-sync";
import { ingestionGithubParseFile } from "./functions/ingestion.github-parse-file";
import { ingestionGithubInferFeatures } from "./functions/ingestion.github-infer-features";
import { ingestionSemanticEdgeInfer } from "./functions/ingestion.semantic-edge-infer";
import { ingestionSyncRequested } from "./functions/ingestion.sync-requested";
import { playbookTriggerMatch } from "./functions/playbook.trigger.match";
import { playbookRunExecute } from "./functions/playbook.run.execute";

export const functions = [
  billingRollupUsage,
  billingDunningSweep,
  stripeSyncSubscription,
  stripeSyncInvoice,
  chatPersistStream,
  agentExecuteSubagent,
  agentBackgroundTaskExecute,
  agentVideoRender,
  agentVideoRenderOnFailure,
  securityAuditPartitionRollover,
  pluginCatalogSyncCron,
  pluginRegistrySync,
  pluginOauthRefreshWatcher,
  agentWorkflowSupervisor,
  agentWorkflowTaskExecute,
  agentSyncExecutionToGraph,
  privacyExportProcess,
  privacyExportProcessOnFailure,
  privacyErasureExecute,
  privacyErasureExecuteOnFailure,
  authSessionExpiryAudit,
  ingestionPipeline,
  ingestionDeleteConnection,
  ingestionOauthRefresh,
  ingestionGithubInitialSync,
  ingestionGithubParseFile,
  ingestionGithubInferFeatures,
  ingestionSemanticEdgeInfer,
  ingestionSyncRequested,
  playbookTriggerMatch,
  playbookRunExecute,
];
