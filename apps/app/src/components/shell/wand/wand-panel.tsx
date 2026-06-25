"use client";
/**
 * WandPanel — the floating AI agent panel.
 *
 * Opens as a floating, draggable panel (id="wand-panel") when the
 * WandButton is clicked. Renders ChatShellClient (lazily imported,
 * mirroring AskDrawer) wired to the real workspace-scoped wandSendAction.
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
import { Suspense, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Wand2, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { usePageContext } from "@/lib/page-context";
import { resolveSidebarCtx } from "@/lib/sidebar";
import type { ResolvedTierCatalog } from "@oxagen/ai/catalog";
import { Button } from "@/components/ui/button";
import { wandSendAction, wandResolveApprovalAction, wandResolveConsentAction, wandResolvePlanAction } from "@/app/[orgSlug]/shell-actions";
import type { ComposerAction } from "@/components/chat/message-composer";
import type { ChatShellProps } from "@/components/chat/chat-shell";
import type { ChatMessage } from "@/components/chat/message-bubble";
import type { ChatPageContext } from "@/components/chat/chat-shell-client";
import type { FormFillResult } from "@/lib/ask/fill-types";

const EMPTY_MESSAGES: ChatMessage[] = [];

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
  const { isWandOpen, closeWand, fillableForm, entity, _setIsFilling, _setFillResult } = usePageContext();
  const pathname = usePathname();
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });

  // Build the serialisable page context from current PageContext state at send-time.
  const buildPageContext = React.useCallback((): ChatPageContext | null => {
    const route = pathname;
    const entitySummary = entity?.summary ?? undefined;
    if (!fillableForm) return { route, entitySummary };
    return {
      route,
      entitySummary,
      fillableForm: {
        formId: fillableForm.formId,
        title: fillableForm.title,
        fields: fillableForm.fields,
      },
    };
  }, [pathname, entity, fillableForm]);

  // Callbacks to wire fill tool results back into PageContext.
  const handleFormFillStart = React.useCallback(() => {
    _setIsFilling(true);
  }, [_setIsFilling]);

  const handleFormFillEnd = React.useCallback(
    (result: FormFillResult) => {
      _setIsFilling(false);
      _setFillResult(result);
    },
    [_setIsFilling, _setFillResult],
  );

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

  const scopedResolveConsentAction = React.useCallback<
    ChatShellProps["resolveConsentAction"]
  >(
    async (approvalId, decision, grantAllTools) => {
      return wandResolveConsentAction(orgSlug, activeWorkspaceSlug, approvalId, decision, grantAllTools);
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

  // Drag handler. Starts a drag only when the press lands on the header
  // ([data-drag-handle]); the move/up listeners are attached to the document
  // for the duration of the gesture and torn down on release so a drag that
  // leaves the panel still tracks the cursor.
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (!target.closest("[data-drag-handle]")) return;
    e.preventDefault();
    const start = {
      x: e.clientX,
      y: e.clientY,
      offsetX: position.x,
      offsetY: position.y,
    };

    const handlePointerMove = (ev: PointerEvent) => {
      setPosition({
        x: start.offsetX + (ev.clientX - start.x),
        y: start.offsetY + (ev.clientY - start.y),
      });
    };

    const handlePointerUp = () => {
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", handlePointerUp);
    };

    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", handlePointerUp);
  };

  if (!isWandOpen) return null;

  return (
    <div
      id="wand-panel"
      ref={panelRef}
      onPointerDown={handlePointerDown}
      className="fixed z-40 w-[480px] rounded-lg border border-white/15 shadow-2xl flex flex-col overflow-hidden"
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
        backgroundColor: "rgba(255, 255, 255, 0.92)",
        backdropFilter: "blur(10px)",
      }}
    >
      {/* Header — draggable */}
      <div
        data-drag-handle
        className="flex flex-row items-center justify-between border-b border-white/20 px-4 py-3 cursor-grab active:cursor-grabbing"
      >
        <div className="flex items-center gap-2">
          <span
            className="inline-flex size-7 items-center justify-center rounded-lg border border-border bg-muted"
            aria-hidden="true"
          >
            <Wand2 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          </span>
          <span className="text-sm font-medium">Oxagen AI</span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            render={<Link href={chatHref} onClick={closeWand} />}
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            aria-label="Open in full chat"
          >
            <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={closeWand}
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </div>

      {/* Chat shell */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-4" style={{ minHeight: "500px" }}>
        <WandChatShell
          orgSlug={orgSlug}
          workspaceSlug={activeWorkspaceSlug}
          sendAction={scopedSendAction}
          resolveApprovalAction={scopedResolveApprovalAction}
          resolveConsentAction={scopedResolveConsentAction}
          resolvePlanAction={scopedResolvePlanAction}
          modelConfig={modelConfig}
          buildPageContext={buildPageContext}
          onFormFillStart={handleFormFillStart}
          onFormFillEnd={handleFormFillEnd}
        />
      </div>
    </div>
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
  resolveConsentAction,
  resolvePlanAction,
  modelConfig,
  buildPageContext,
  onFormFillStart,
  onFormFillEnd,
}: {
  orgSlug: string;
  workspaceSlug: string;
  sendAction: ComposerAction;
  resolveApprovalAction: ChatShellProps["resolveApprovalAction"];
  resolveConsentAction: ChatShellProps["resolveConsentAction"];
  resolvePlanAction: ChatShellProps["resolvePlanAction"];
  modelConfig: ResolvedTierCatalog;
  buildPageContext: () => ChatPageContext | null;
  onFormFillStart: () => void;
  onFormFillEnd: (result: FormFillResult) => void;
}) {
  const pageCtx = buildPageContext();

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
        messages={EMPTY_MESSAGES}
        sendAction={sendAction}
        resolveApprovalAction={resolveApprovalAction}
        resolveConsentAction={resolveConsentAction}
        resolvePlanAction={resolvePlanAction}
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        modelConfig={modelConfig}
        pageContext={pageCtx}
        onFormFillStart={onFormFillStart}
        onFormFillEnd={onFormFillEnd}
      />
    </Suspense>
  );
}
