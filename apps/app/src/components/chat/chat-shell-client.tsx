"use client";
import * as React from "react";
import { MessageTree } from "./message-tree";
import { MessageComposer, type ComposerAction } from "./message-composer";
import type { ChatMessage, MessageBubbleCallbacks } from "./message-bubble";
import type { ChatShellProps } from "./chat-shell";

// Client surface for the chat. The RSC `ChatShell` resolves the messages
// promise and hands them in; this component:
//  - threads the approval/plan resolvers down to the bubbles,
//  - blocks the composer while any approval-request block is still
//    awaiting a decision (spec §7 — "disabled while an approval is
//    pending"),
//  - exposes a hook point for child-branch navigation that the subagent
//    fanout cards delegate to.
export function ChatShellClient({
  conversationId,
  activeLeafMessageId,
  messages,
  sendAction,
  resolveApprovalAction,
  resolvePlanAction,
}: {
  conversationId: string | null;
  activeLeafMessageId: string | null;
  messages: ChatMessage[];
  sendAction: ComposerAction;
  resolveApprovalAction: ChatShellProps["resolveApprovalAction"];
  resolvePlanAction: ChatShellProps["resolvePlanAction"];
}) {
  const hasPendingApproval = React.useMemo(
    () =>
      messages.some((m) =>
        (m.contentBlocks ?? []).some(
          (b) => b.type === "approval-request" && b.resolution === undefined,
        ),
      ),
    [messages],
  );

  const callbacks: MessageBubbleCallbacks = {
    onResolveApproval: resolveApprovalAction,
    onResolvePlan: resolvePlanAction,
    onNavigateToChild: (childMessageId) => {
      // Defer to the existing branch-switcher mechanism by updating the
      // URL hash; the page-level effect picks it up and refetches the
      // active branch. Kept lightweight here so this component is not
      // coupled to a particular router instance.
      if (typeof window !== "undefined") {
        window.location.hash = `m-${childMessageId}`;
      }
    },
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-4">
      <div className="min-h-0 flex-1 overflow-y-auto pr-2">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center text-sm text-muted-foreground">
            <p className="font-medium">Start a conversation.</p>
            <p>Send a message below to begin.</p>
          </div>
        ) : (
          <MessageTree messages={messages} callbacks={callbacks} />
        )}
      </div>
      <MessageComposer
        conversationId={conversationId}
        parentMessageId={activeLeafMessageId}
        action={sendAction}
        disabled={hasPendingApproval}
        disabledReason={
          hasPendingApproval ? "Resolve the pending approval above to continue." : undefined
        }
      />
    </div>
  );
}
