"use client";
/**
 * WandPanel — the floating AI agent drawer panel.
 *
 * Opens as a right-side Sheet when the WandButton is clicked. Renders
 * ChatShellClient (lazily imported, mirroring AskDrawer) wired to the
 * real workspace-scoped wandSendAction.
 *
 * Workspace resolution:
 *   The panel is mounted at the [orgSlug] layout boundary, which has no
 *   access to [workspaceSlug]. We resolve the active workspace from
 *   usePathname() via resolveSidebarCtx(), then inject orgSlug+workspaceSlug
 *   into every FormData submission by wrapping wandSendAction in a client-side
 *   closure. The server action resolves the IDs from the slugs itself.
 *
 *   If the current path has no workspace (e.g. org-level settings), we pick
 *   the first available workspace from availableWorkspaces (passed as a prop
 *   from the server layout). This ensures the wand always has a valid send
 *   target without showing a workspace picker.
 *
 * Fill plumbing:
 *   When a fillable form is registered on the current page, the wand's chat
 *   session can trigger the fill flow exactly as the AskBar does — the AI
 *   can classify the user's message as a "fill" intent and call fillFormAction.
 *   No extra wiring is needed here because fillFormAction reads PageContext
 *   directly through the shared provider.
 */

import * as React from "react";
import { Suspense } from "react";
import Link from "next/link";
import { ArrowUpRight, Wand2 } from "lucide-react";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { usePageContext } from "@/lib/page-context";
import { resolveSidebarCtx } from "@/lib/sidebar";
import type { ResolvedTierCatalog } from "@oxagen/ai/catalog";
import {
  Sheet,
  SheetPopup,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { wandSendAction, wandResolveApprovalAction, wandResolvePlanAction } from "@/app/[orgSlug]/shell-actions";
import type { ComposerAction } from "@/components/chat/message-composer";
import type { ChatShellProps } from "@/components/chat/chat-shell";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface WandPanelProps {
  /** The org slug from the server layout — needed to build hrefs. */
  orgSlug: string;
  /**
   * The workspaces available to this org, passed down from the server layout.
   * Used to pick a default workspace when the current path has no workspace.
   */
  availableWorkspaces: { slug: string; name: string; publicId: string }[];
  /** Resolved tier→model map forwarded to the composer. */
  modelConfig: ResolvedTierCatalog;
}

// ---------------------------------------------------------------------------
// WandPanel
// ---------------------------------------------------------------------------

export function WandPanel({ orgSlug, availableWorkspaces, modelConfig }: WandPanelProps) {
  const { isWandOpen, closeWand } = usePageContext();
  const pathname = usePathname();

  // Resolve the active workspace slug from the URL (mirrors ShellFrame).
  // Falls back to the first available workspace when the path is org-level.
  const ctx = resolveSidebarCtx(pathname, { orgSlug });
  const activeWorkspaceSlug =
    ctx.workspaceSlug ?? availableWorkspaces[0]?.slug ?? "";

  // Build the "open in full chat" href for the pop-out button.
  const chatHref = activeWorkspaceSlug
    ? `/${orgSlug}/${activeWorkspaceSlug}/ask`
    : `/${orgSlug}`;

  // ---------------------------------------------------------------------------
  // Wrap wandSendAction to inject orgSlug + workspaceSlug as FormData fields.
  //
  // We create this wrapper inside the render so it always captures the latest
  // activeWorkspaceSlug from usePathname(). The wrapper is stable across the
  // open/close lifetime of the panel because it's re-created on pathname changes
  // (which is correct — the workspace may change as the user navigates).
  // ---------------------------------------------------------------------------
  const scopedSendAction = React.useCallback<ComposerAction>(
    async (formData: FormData) => {
      // Inject the routing context so the server action can resolve IDs.
      formData.set("orgSlug", orgSlug);
      formData.set("workspaceSlug", activeWorkspaceSlug);
      return wandSendAction(formData);
    },
    [orgSlug, activeWorkspaceSlug],
  );

  const scopedResolveApprovalAction = React.useCallback<
    ChatShellProps["resolveApprovalAction"]
  >(
    async (approvalId, decision) => {
      return wandResolveApprovalAction(orgSlug, activeWorkspaceSlug, approvalId, decision);
    },
    [orgSlug, activeWorkspaceSlug],
  );

  const scopedResolvePlanAction = React.useCallback<
    ChatShellProps["resolvePlanAction"]
  >(
    async (planId, decision, amendedSteps) => {
      return wandResolvePlanAction(orgSlug, activeWorkspaceSlug, planId, decision, amendedSteps);
    },
    [orgSlug, activeWorkspaceSlug],
  );

  return (
    <Sheet
      open={isWandOpen}
      onOpenChange={(open) => !open && closeWand()}
      disablePointerDismissal
    >
      <SheetPopup
        id="wand-panel"
        side="right"
        className={cn(
          "flex flex-col p-0",
          "w-full sm:w-[480px] sm:max-w-[480px]",
          "[&]:sm:max-w-[480px]",
        )}
      >
        {/* Header */}
        <SheetHeader className="flex flex-row items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <span
              className="inline-flex size-7 items-center justify-center rounded-lg border border-border bg-muted"
              aria-hidden="true"
            >
              <Wand2 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </span>
            <SheetTitle className="text-sm font-medium">Oxagen AI</SheetTitle>
          </div>
          <div className="flex items-center gap-1 pr-6">
            <Button
              variant="ghost"
              size="icon"
              render={<Link href={chatHref} onClick={closeWand} />}
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              aria-label="Open in full chat"
            >
              <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        </SheetHeader>

        {/* Chat shell */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-4">
          <WandChatShell
            orgSlug={orgSlug}
            workspaceSlug={activeWorkspaceSlug}
            sendAction={scopedSendAction}
            resolveApprovalAction={scopedResolveApprovalAction}
            resolvePlanAction={scopedResolvePlanAction}
            modelConfig={modelConfig}
          />
        </div>
      </SheetPopup>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Inner lazy chat shell — mirrors AskDrawer's pattern exactly.
// ---------------------------------------------------------------------------

const LazyChatShellClient = React.lazy(() =>
  import("@/components/chat/chat-shell-client").then((m) => ({
    default: m.ChatShellClient,
  })),
);

function WandChatShell({
  orgSlug,
  workspaceSlug,
  sendAction,
  resolveApprovalAction,
  resolvePlanAction,
  modelConfig,
}: {
  orgSlug: string;
  workspaceSlug: string;
  sendAction: ComposerAction;
  resolveApprovalAction: ChatShellProps["resolveApprovalAction"];
  resolvePlanAction: ChatShellProps["resolvePlanAction"];
  modelConfig: ResolvedTierCatalog;
}) {
  return (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center">
          <div
            className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-foreground"
            aria-label="Loading AI agent"
          />
        </div>
      }
    >
      <LazyChatShellClient
        conversationId={null}
        conversationPublicId={null}
        activeLeafMessageId={null}
        messages={[]}
        sendAction={sendAction}
        resolveApprovalAction={resolveApprovalAction}
        resolvePlanAction={resolvePlanAction}
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        modelConfig={modelConfig}
      />
    </Suspense>
  );
}
