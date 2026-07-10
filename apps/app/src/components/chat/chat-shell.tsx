import { Suspense } from "react";
import { type ChatMessage } from "./message-bubble";
import { type ComposerAction } from "./message-composer";
import { Skeleton } from "@/components/ui/skeleton";
import { ChatShellClient } from "./chat-shell-client";
import { BackgroundTaskTray } from "./background-task-tray";
import { resolvedTierCatalog } from "@oxagen/ai";
import type { ComposerModelState, WorkspaceBudgetGovernance } from "./model-picker";
import type { McpServerSummary } from "./mcp-types";
import type { RepoOption } from "./repo-selector";
import type { EnvironmentOption } from "./environment-selector";
import type { AgentOption } from "./agent-selector";

export { type ChatMessage, type MessageAttachment } from "./message-bubble";
// The prop contract lives in chat-shell-props.ts (a type-only leaf) so
// chat-shell-client.tsx can type it without importing this server module,
// which value-imports the client back. Re-exported for existing consumers.
export type { ChatShellProps } from "./chat-shell-props";
import type { ChatShellProps } from "./chat-shell-props";

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
  resolveConsentAction,
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
  availableMcpServers,
  availableRepos,
  availableEnvironments,
  availableAgents,
  workspaceBudgetGovernance,
  agentId,
  boundAgentName,
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
          resolveConsentAction={resolveConsentAction}
          resolvePlanAction={resolvePlanAction}
          agentCapabilities={agentCapabilities}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          enterToSubmit={enterToSubmit}
          pendingPromptBehavior={pendingPromptBehavior}
          initialModelState={initialModelState}
          availableMcpServers={availableMcpServers}
          availableRepos={availableRepos}
          availableEnvironments={availableEnvironments}
          availableAgents={availableAgents}
          workspaceBudgetGovernance={workspaceBudgetGovernance}
          agentId={agentId}
          boundAgentName={boundAgentName}
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
  resolveConsentAction,
  resolvePlanAction,
  agentCapabilities,
  orgSlug,
  workspaceSlug,
  enterToSubmit,
  pendingPromptBehavior,
  initialModelState,
  availableMcpServers,
  availableRepos,
  availableEnvironments,
  availableAgents,
  workspaceBudgetGovernance,
  agentId,
  boundAgentName,
}: {
  promise: Promise<ChatMessage[]>;
  conversationId: string | null;
  conversationPublicId: string | null;
  activeLeafMessageId: string | null;
  sendAction: ComposerAction;
  resolveApprovalAction: ChatShellProps["resolveApprovalAction"];
  resolveConsentAction: ChatShellProps["resolveConsentAction"];
  resolvePlanAction: ChatShellProps["resolvePlanAction"];
  agentCapabilities?: ChatShellProps["agentCapabilities"];
  orgSlug: string;
  workspaceSlug: string;
  enterToSubmit?: boolean;
  pendingPromptBehavior?: "queue" | "interrupt";
  initialModelState?: ComposerModelState;
  availableMcpServers?: McpServerSummary[];
  availableRepos?: RepoOption[];
  availableEnvironments?: EnvironmentOption[];
  availableAgents?: AgentOption[];
  workspaceBudgetGovernance?: WorkspaceBudgetGovernance | null;
  agentId?: string | null;
  boundAgentName?: string | null;
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
      resolveConsentAction={resolveConsentAction}
      resolvePlanAction={resolvePlanAction}
      agentCapabilities={agentCapabilities}
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      modelConfig={modelConfig}
      enterToSubmit={enterToSubmit}
      pendingPromptBehavior={pendingPromptBehavior}
      initialModelState={initialModelState}
      availableMcpServers={availableMcpServers}
      availableRepos={availableRepos}
      availableEnvironments={availableEnvironments}
      availableAgents={availableAgents}
      workspaceBudgetGovernance={workspaceBudgetGovernance}
      agentId={agentId}
      boundAgentName={boundAgentName}
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
