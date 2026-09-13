import { Suspense } from "react";
import { cookies } from "next/headers";
import { chatUxV2Enabled, CHAT_UX_V2_COOKIE } from "@/lib/flags";
import { type ChatMessage } from "./message-bubble";
import { type ComposerAction } from "./message-composer";
import { Skeleton } from "@/components/ui/skeleton";
import { ChatShellClient } from "./chat-shell-client";
import { resolvedTierCatalog } from "@oxagen/ai";
import type {
  ComposerModelState,
  WorkspaceBudgetGovernance,
} from "./model-picker";
import type { McpServerSummary } from "./mcp-types";
import type { AgentOption } from "./agent-picker/agent-picker-types";

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
  orgSlug,
  workspaceSlug,
  enterToSubmit,
  pendingPromptBehavior,
  initialModelState,
  availableMcpServers,
  availableAgents,
  defaultAgentId,
  setDefaultAgentAction,
  workspaceBudgetGovernance,
  agentId,
  walletBalanceCents,
  userFirstName,
}: ChatShellProps) {
  return (
    <Suspense fallback={<MessagesSkeleton />}>
      <AsyncShell
        promise={messagesPromise}
        walletBalanceCents={walletBalanceCents}
        userFirstName={userFirstName}
        conversationId={conversationId}
        conversationPublicId={conversationPublicId ?? null}
        activeLeafMessageId={activeLeafMessageId}
        sendAction={sendAction}
        resolveApprovalAction={resolveApprovalAction}
        resolveConsentAction={resolveConsentAction}
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        enterToSubmit={enterToSubmit}
        pendingPromptBehavior={pendingPromptBehavior}
        initialModelState={initialModelState}
        availableMcpServers={availableMcpServers}
        availableAgents={availableAgents}
        defaultAgentId={defaultAgentId}
        setDefaultAgentAction={setDefaultAgentAction}
        workspaceBudgetGovernance={workspaceBudgetGovernance}
        agentId={agentId}
      />
    </Suspense>
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
  orgSlug,
  workspaceSlug,
  enterToSubmit,
  pendingPromptBehavior,
  initialModelState,
  availableMcpServers,
  availableAgents,
  defaultAgentId,
  setDefaultAgentAction,
  workspaceBudgetGovernance,
  agentId,
  walletBalanceCents,
  userFirstName,
}: {
  promise: Promise<ChatMessage[]>;
  conversationId: string | null;
  conversationPublicId: string | null;
  activeLeafMessageId: string | null;
  sendAction: ComposerAction;
  resolveApprovalAction: ChatShellProps["resolveApprovalAction"];
  resolveConsentAction: ChatShellProps["resolveConsentAction"];
  orgSlug: string;
  workspaceSlug: string;
  enterToSubmit?: boolean;
  pendingPromptBehavior?: "queue" | "interrupt";
  initialModelState?: ComposerModelState;
  availableMcpServers?: McpServerSummary[];
  availableAgents?: AgentOption[];
  defaultAgentId?: string | null;
  setDefaultAgentAction?: (
    agentId: string | null,
  ) => Promise<{ ok: boolean; error?: string }>;
  workspaceBudgetGovernance?: WorkspaceBudgetGovernance | null;
  agentId?: string | null;
  walletBalanceCents?: number | null;
  userFirstName?: string | null;
}) {
  const messages = await promise;
  const modelConfig = resolvedTierCatalog();
  // chat_ux_v2 resolved ONCE here (env default + per-browser cookie override)
  // and passed down as a boolean — client code never re-derives it, so server
  // and client can't disagree about which state tree is live.
  const chatUxV2 = chatUxV2Enabled(
    (await cookies()).get(CHAT_UX_V2_COOKIE)?.value ?? null,
  );
  return (
    <ChatShellClient
      chatUxV2={chatUxV2}
      walletBalanceCents={walletBalanceCents}
      userFirstName={userFirstName}
      conversationId={conversationId}
      conversationPublicId={conversationPublicId}
      activeLeafMessageId={activeLeafMessageId}
      messages={messages}
      sendAction={sendAction}
      resolveApprovalAction={resolveApprovalAction}
      resolveConsentAction={resolveConsentAction}
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      modelConfig={modelConfig}
      enterToSubmit={enterToSubmit}
      pendingPromptBehavior={pendingPromptBehavior}
      initialModelState={initialModelState}
      availableMcpServers={availableMcpServers}
      availableAgents={availableAgents}
      defaultAgentId={defaultAgentId}
      setDefaultAgentAction={setDefaultAgentAction}
      workspaceBudgetGovernance={workspaceBudgetGovernance}
      agentId={agentId}
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
