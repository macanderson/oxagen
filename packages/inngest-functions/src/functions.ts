import { billingDunningSweep } from "./functions/billing.dunning-sweep";
import { stripeSyncSubscription } from "./functions/stripe.sync-subscription";
import { stripeSyncInvoice } from "./functions/stripe.sync-invoice";
import { chatPersistStream } from "./functions/chat.persist-stream";
import { agentExecuteSubagent } from "./functions/agent.execute-subagent";
import { agentAggregateFanout } from "./functions/agent.aggregate-fanout";
import { agentBackgroundTaskExecute } from "./functions/agent.background-task.execute";
import {
  agentVideoRender,
  agentVideoRenderOnFailure,
} from "./functions/agent.video-render";
import { securityAuditPartitionRollover } from "./functions/security.audit-partition-rollover";
import { pluginOauthRefreshWatcher } from "./functions/plugin.oauth-refresh-watcher";
import { agentWorkflowSupervisor } from "./functions/agent.workflow.supervisor";
import { agentWorkflowTaskExecute } from "./functions/agent.workflow.task.execute";
import { agentLeaseSweep } from "./functions/agent.lease-sweep";
import { agentSandboxReaper } from "./functions/agent.sandbox-reaper";
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
  agentBackgroundTaskExecute,
  agentVideoRender,
  agentVideoRenderOnFailure,
  securityAuditPartitionRollover,
  pluginOauthRefreshWatcher,
  agentWorkflowSupervisor,
  agentWorkflowTaskExecute,
  agentLeaseSweep,
  agentSandboxReaper,
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
  memoryDecayPass,
  observabilityCaptureFailure,
  evalRunExecute,
].filter((fn): fn is NonNullable<typeof fn> => fn != null);
