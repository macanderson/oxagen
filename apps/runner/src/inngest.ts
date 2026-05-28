import { Inngest, EventSchemas } from "inngest";
import { loadEnv } from "@oxagen/config/env";

// Inngest event registry. Adding an event here is the only way it becomes
// callable from inside the runner — typed at the boundary, never inferred.
type Events = {
  "stripe/subscription.updated": { data: { stripeSubscriptionId: string } };
  "stripe/invoice.updated": { data: { stripeInvoiceId: string } };
  "chat/message.streamed": {
    data: {
      tenantId: string;
      workspaceId: string;
      conversationId: string;
      assistantMessageId: string;
      content: string;
      tokenUsage: {
        model: string;
        inputTokens: number;
        outputTokens: number;
        cachedTokens: number;
        costMicros: number;
      } | null;
    };
  };
  "agent/subagent.dispatch": {
    data: { tenantId: string; workspaceId: string; fanoutId: string };
  };
  "agent/task.background.start": {
    data: {
      tenantId: string;
      workspaceId: string;
      taskId: string;
      kind: string;
      payload: unknown;
    };
  };
  "agent/task.background.cancel": {
    data: { tenantId: string; taskId: string };
  };
};

const env = loadEnv();

export const inngest = new Inngest({
  id: "oxagen-runner",
  eventKey: env.INNGEST_EVENT_KEY,
  schemas: new EventSchemas().fromRecord<Events>(),
});

export type InngestClient = typeof inngest;
