import { Suspense } from "react";
import { type ChatMessage } from "./message-bubble";
import { type ComposerAction } from "./message-composer";
import { Skeleton } from "@/components/ui/skeleton";
import { ChatShellClient } from "./chat-shell-client";
import {
  BackgroundTaskTray,
  type BackgroundTaskSnapshot,
} from "./background-task-tray";
import { resolvedTierCatalog } from "@oxagen/ai";
import type { ComposerModelState } from "./model-picker";

export { type ChatMessage } from "./message-bubble";

export interface ChatShellProps {
  conversationId: string | null;
  /** Public id (e.g. "conv_…") used to fetch conversation assets. */
  conversationPublicId?: string | null;
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
  /** Slug values forwarded to ChatShellClient for /api/v1/chat/stream requests. */
  orgSlug: string;
  workspaceSlug: string;
  /** User preference: submit on Enter. Passed through to the composer. */
  enterToSubmit?: boolean;
  /** User preference: what to do on concurrent submit. Passed to composer. */
  pendingPromptBehavior?: "queue" | "interrupt";
  /** Effective model defaults from server (workspace > user > system). */
  initialModelState?: ComposerModelState;
}

// RSC streaming: the messages promise resolves inside a Suspense boundary
// so the composer paints immediately and the active-leaf path streams in
// as Postgres returns rows. New tokens from the AI SDK are rendered by
// `messagesPromise` being recomputed after the server action revalidates.
export function ChatShell({
  conversationId,
  conversationPublicId,
  activeLeafMessageId,
  messagesPromise,
  sendAction,
  resolveApprovalAction,
  resolvePlanAction,
  fetchBackgroundTask,
  cancelBackgroundTask,
  initialBackgroundTaskIds,
  agentCapabilities,
  orgSlug,
  workspaceSlug,
  enterToSubmit,
  pendingPromptBehavior,
  initialModelState,
}: ChatShellProps) {
  return (
    <>
      <Suspense fallback={<MessagesSkeleton />}>
        <AsyncShell
          promise={messagesPromise}
          conversationId={conversationId}
          conversationPublicId={conversationPublicId ?? null}
          activeLeafMessageId={activeLeafMessageId}
          sendAction={sendAction}
          resolveApprovalAction={resolveApprovalAction}
          resolvePlanAction={resolvePlanAction}
          agentCapabilities={agentCapabilities}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          enterToSubmit={enterToSubmit}
          pendingPromptBehavior={pendingPromptBehavior}
          initialModelState={initialModelState}
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
  conversationPublicId,
  activeLeafMessageId,
  sendAction,
  resolveApprovalAction,
  resolvePlanAction,
  agentCapabilities,
  orgSlug,
  workspaceSlug,
  enterToSubmit,
  pendingPromptBehavior,
  initialModelState,
}: {
  promise: Promise<ChatMessage[]>;
  conversationId: string | null;
  conversationPublicId: string | null;
  activeLeafMessageId: string | null;
  sendAction: ComposerAction;
  resolveApprovalAction: ChatShellProps["resolveApprovalAction"];
  resolvePlanAction: ChatShellProps["resolvePlanAction"];
  agentCapabilities?: ChatShellProps["agentCapabilities"];
  orgSlug: string;
  workspaceSlug: string;
  enterToSubmit?: boolean;
  pendingPromptBehavior?: "queue" | "interrupt";
  initialModelState?: ComposerModelState;
}) {
  const messages = await promise;
  const modelConfig = resolvedTierCatalog();
  return (
    <ChatShellClient
      conversationId={conversationId}
      conversationPublicId={conversationPublicId}
      activeLeafMessageId={activeLeafMessageId}
      messages={messages}
      sendAction={sendAction}
      resolveApprovalAction={resolveApprovalAction}
      resolvePlanAction={resolvePlanAction}
      agentCapabilities={agentCapabilities}
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      modelConfig={modelConfig}
      enterToSubmit={enterToSubmit}
      pendingPromptBehavior={pendingPromptBehavior}
      initialModelState={initialModelState}
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
