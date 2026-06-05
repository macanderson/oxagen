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
import { Suspense } from "react";
import Link from "next/link";
import { ArrowUpRight, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePageContext } from "@/lib/page-context";
import type { ScopeContext } from "@/lib/scope";
import type { ResolvedTierCatalog } from "@oxagen/ai/catalog";
import {
  Sheet,
  SheetPopup,
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
  /** Resolved tier→model map from the server, forwarded to the composer. */
  modelConfig: ResolvedTierCatalog;
}

export function AskDrawer({
  ctx,
  sendAction,
  resolveApprovalAction,
  resolvePlanAction,
  modelConfig,
}: AskDrawerProps) {
  const { isAskOpen, closeAsk } = usePageContext();

  const chatHref =
    ctx.workspaceSlug
      ? `/${ctx.orgSlug}/${ctx.workspaceSlug}/ask`
      : `/${ctx.orgSlug}`;

  return (
    <Sheet
      open={isAskOpen}
      onOpenChange={(open) => !open && closeAsk()}
      // Keep the drawer open on outside clicks — closed only via the buttons.
      disablePointerDismissal
    >
      <SheetPopup
        side="right"
        className={cn(
          // ~480px on desktop, full-width on mobile
          "flex flex-col p-0",
          "w-full sm:w-[480px] sm:max-w-[480px]",
          // Override default sm:max-w-sm from sheet variants
          "[&]:sm:max-w-[480px]",
        )}
      >
        {/* Header */}
        <SheetHeader className="flex flex-row items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="inline-flex size-7 items-center justify-center rounded-lg border border-border bg-muted" aria-hidden="true">
              <Sparkles className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </span>
            <SheetTitle className="text-sm font-medium">Ask Oxagen</SheetTitle>
          </div>
          <div className="flex items-center gap-1 pr-6">
            {/* Pop out to full chat — the Sheet's built-in close handles dismissal. */}
            <Button
              variant="ghost"
              size="icon"
              render={<Link href={chatHref} onClick={closeAsk} />}
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              aria-label="Open in full chat"
            >
              <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
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
            modelConfig={modelConfig}
          />
        </div>
      </SheetPopup>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Inner component — lazily imports ChatShellClient to avoid bundling it
// into the topbar chunk when the drawer is closed.
// ---------------------------------------------------------------------------

// React.lazy defers the chat bundle until the drawer first opens.
const LazyChatShellClient = React.lazy(() =>
  import("@/components/chat/chat-shell-client").then((m) => ({
    default: m.ChatShellClient,
  })),
);

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
  return (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-foreground" aria-label="Loading" />
        </div>
      }
    >
      <LazyChatShellClient
        conversationId={null}
        activeLeafMessageId={null}
        messages={[]}
        sendAction={sendAction}
        resolveApprovalAction={resolveApprovalAction}
        resolvePlanAction={resolvePlanAction}
        orgSlug={ctx.orgSlug}
        workspaceSlug={ctx.workspaceSlug ?? ""}
      />
    </Suspense>
  );
}
