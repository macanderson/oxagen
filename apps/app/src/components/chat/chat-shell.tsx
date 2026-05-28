import { Suspense } from "react";
import { type ChatMessage } from "./message-bubble";
import { type ComposerAction } from "./message-composer";
import { Skeleton } from "@/components/ui/skeleton";
import { ChatShellClient } from "./chat-shell-client";
import {
  BackgroundTaskTray,
  type BackgroundTaskSnapshot,
} from "./background-task-tray";

export { type ChatMessage } from "./message-bubble";

export interface ChatShellProps {
  conversationId: string | null;
  activeLeafMessageId: string | null;
  messagesPromise: Promise<ChatMessage[]>;
  sendAction: ComposerAction;
  resolveApprovalAction: (
    approvalId: string,
    decision: "approved" | "denied",
  ) => Promise<{ ok: boolean; error?: string }>;
  resolvePlanAction: (
    planId: string,
    decision: "approved" | "denied" | "amended",
    amendedSteps?: import("./stream-event-types").PlanStep[],
  ) => Promise<{ ok: boolean; error?: string }>;
  fetchBackgroundTask: (taskId: string) => Promise<BackgroundTaskSnapshot>;
  cancelBackgroundTask?: (taskId: string) => Promise<{ ok: boolean; error?: string }>;
  initialBackgroundTaskIds?: string[];
  agentCapabilities?: readonly import("./plan-card").AgentCapability[];
}

// RSC streaming: the messages promise resolves inside a Suspense boundary
// so the composer paints immediately and the active-leaf path streams in
// as Postgres returns rows. New tokens from the AI SDK are rendered by
// `messagesPromise` being recomputed after the server action revalidates.
export function ChatShell({
  conversationId,
  activeLeafMessageId,
  messagesPromise,
  sendAction,
  resolveApprovalAction,
  resolvePlanAction,
  fetchBackgroundTask,
  cancelBackgroundTask,
  initialBackgroundTaskIds,
  agentCapabilities,
}: ChatShellProps) {
  return (
    <>
      <Suspense fallback={<MessagesSkeleton />}>
        <AsyncShell
          promise={messagesPromise}
          conversationId={conversationId}
          activeLeafMessageId={activeLeafMessageId}
          sendAction={sendAction}
          resolveApprovalAction={resolveApprovalAction}
          resolvePlanAction={resolvePlanAction}
          agentCapabilities={agentCapabilities}
        />
      </Suspense>
      <BackgroundTaskTray
        initialTaskIds={initialBackgroundTaskIds}
        fetchTask={fetchBackgroundTask}
        cancelTask={cancelBackgroundTask}
      />
    </>
  );
}

async function AsyncShell({
  promise,
  conversationId,
  activeLeafMessageId,
  sendAction,
  resolveApprovalAction,
  resolvePlanAction,
  agentCapabilities,
}: {
  promise: Promise<ChatMessage[]>;
  conversationId: string | null;
  activeLeafMessageId: string | null;
  sendAction: ComposerAction;
  resolveApprovalAction: ChatShellProps["resolveApprovalAction"];
  resolvePlanAction: ChatShellProps["resolvePlanAction"];
  agentCapabilities?: ChatShellProps["agentCapabilities"];
}) {
  const messages = await promise;
  return (
    <ChatShellClient
      conversationId={conversationId}
      activeLeafMessageId={activeLeafMessageId}
      messages={messages}
      sendAction={sendAction}
      resolveApprovalAction={resolveApprovalAction}
      resolvePlanAction={resolvePlanAction}
      agentCapabilities={agentCapabilities}
    />
  );
}

function MessagesSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <Skeleton className="h-16 w-2/3" />
      <Skeleton className="h-12 w-1/2 self-end" />
      <Skeleton className="h-20 w-3/4" />
    </div>
  );
}
