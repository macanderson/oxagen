"use client";
/**
 * AskDrawer — right-side Sheet that wraps ChatShellClient.
 *
 * The drawer persists across page navigations within the PageContextProvider
 * (the open/close state lives in PageContext, not in local component state).
 *
 * The "pop out" button navigates to /{org}/{ws}/chat so the user gets the
 * full chat experience.
 *
 * The drawer does NOT own a conversation — it passes a null conversationId and
 * a minimal set of props to ChatShellClient so it bootstraps a new conversation
 * for each session. This is intentional: the drawer is a quick-access surface,
 * not a persistent conversation view.
 *
 * Page context (entity summary + current route) is forwarded to the chat
 * action as a system prompt prefix via the seeded message in the composer.
 */

import * as React from "react";
import Link from "next/link";
import { ArrowUpRight, X, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePageContext } from "@/lib/page-context";
import type { ScopeContext } from "@/lib/scope";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";

export interface AskDrawerProps {
  ctx: ScopeContext;
  /**
   * The server actions forwarded to ChatShellClient.
   * We accept them as props so the drawer can be placed in the app-shell
   * layout and reused across all pages without re-resolving the actions.
   */
  sendAction: import("@/components/chat/message-composer").ComposerAction;
  resolveApprovalAction: import("@/components/chat/chat-shell").ChatShellProps["resolveApprovalAction"];
  resolvePlanAction: import("@/components/chat/chat-shell").ChatShellProps["resolvePlanAction"];
}

export function AskDrawer({
  ctx,
  sendAction,
  resolveApprovalAction,
  resolvePlanAction,
}: AskDrawerProps) {
  const { isAskOpen, closeAsk } = usePageContext();

  const chatHref =
    ctx.workspaceSlug
      ? `/${ctx.orgSlug}/${ctx.workspaceSlug}/chat`
      : `/${ctx.orgSlug}`;

  return (
    <Sheet open={isAskOpen} onOpenChange={(open) => !open && closeAsk()}>
      <SheetContent
        side="right"
        className={cn(
          // ~480px on desktop, full-width on mobile
          "flex flex-col p-0",
          "w-full sm:w-[480px] sm:max-w-[480px]",
          // Override default sm:max-w-sm from sheet variants
          "[&]:sm:max-w-[480px]",
        )}
        // Prevent the default close button from Sheet — we render our own.
        onInteractOutside={(e) => e.preventDefault()}
      >
        {/* Header */}
        <SheetHeader className="flex flex-row items-center justify-between border-b border-border/40 px-4 py-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-accent" aria-hidden="true" />
            <SheetTitle className="text-sm font-medium">Ask Oxagen</SheetTitle>
          </div>
          <div className="flex items-center gap-1">
            {/* Pop out to full chat */}
            <Button
              variant="ghost"
              size="icon"
              asChild
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              aria-label="Open in full chat"
            >
              <Link href={chatHref} onClick={closeAsk}>
                <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            </Button>
            {/* Close */}
            <Button
              variant="ghost"
              size="icon"
              onClick={closeAsk}
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              aria-label="Close ask drawer"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        </SheetHeader>

        {/* Chat shell */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-4">
          <AskDrawerChatShell
            ctx={ctx}
            sendAction={sendAction}
            resolveApprovalAction={resolveApprovalAction}
            resolvePlanAction={resolvePlanAction}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Inner component — lazily imports ChatShellClient to avoid bundling it
// into the topbar chunk when the drawer is closed.
// ---------------------------------------------------------------------------

function AskDrawerChatShell({
  ctx,
  sendAction,
  resolveApprovalAction,
  resolvePlanAction,
}: {
  ctx: ScopeContext;
  sendAction: import("@/components/chat/message-composer").ComposerAction;
  resolveApprovalAction: import("@/components/chat/chat-shell").ChatShellProps["resolveApprovalAction"];
  resolvePlanAction: import("@/components/chat/chat-shell").ChatShellProps["resolvePlanAction"];
}) {
  // Lazy import so the chat bundle is not loaded until the drawer opens.
  const [ChatShellClient, setChatShellClient] = React.useState<
    typeof import("@/components/chat/chat-shell-client").ChatShellClient | null
  >(null);

  React.useEffect(() => {
    void import("@/components/chat/chat-shell-client").then((m) => {
      setChatShellClient(() => m.ChatShellClient);
    });
  }, []);

  if (!ChatShellClient) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-accent" aria-label="Loading" />
      </div>
    );
  }

  return (
    <ChatShellClient
      conversationId={null}
      activeLeafMessageId={null}
      messages={[]}
      sendAction={sendAction}
      resolveApprovalAction={resolveApprovalAction}
      resolvePlanAction={resolvePlanAction}
      orgSlug={ctx.orgSlug}
      workspaceSlug={ctx.workspaceSlug ?? ""}
    />
  );
}
