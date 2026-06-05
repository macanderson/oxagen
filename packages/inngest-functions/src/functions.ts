import { billingRollupUsage } from "./functions/billing.rollup-usage";
import { billingDunningSweep } from "./functions/billing.dunning-sweep";
import { stripeSyncSubscription } from "./functions/stripe.sync-subscription";
import { stripeSyncInvoice } from "./functions/stripe.sync-invoice";
import { chatPersistStream } from "./functions/chat.persist-stream";
import { agentExecuteSubagent } from "./functions/agent.execute-subagent";
import { agentBackgroundTaskExecute } from "./functions/agent.background-task.execute";
import { agentVideoRender, agentVideoRenderOnFailure } from "./functions/agent.video-render";

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
];
