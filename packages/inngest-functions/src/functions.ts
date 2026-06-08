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
];
