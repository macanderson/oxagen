"use client";
/**
 * AskDrawer — right-side Sheet that wraps ChatShellClient.
 *
 * Workspace resolution mirrors WandPanel: mounted at the [orgSlug] layout
 * boundary, so we resolve the active workspace from usePathname() via
 * resolveSidebarCtx(), falling back to the first available workspace when the
 * current path is org-level (no workspace in the URL).
 */

import * as React from "react";
import { Suspense } from "react";
import Link from "next/link";
import { ArrowUpRight, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePageContext } from "@/lib/page-context";
import { usePathname } from "next/navigation";
import { resolveSidebarCtx } from "@/lib/sidebar";
import type { ResolvedTierCatalog } from "@oxagen/ai/catalog";
import {
  Sheet,
  SheetPopup,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import {
  wandSendAction,
  wandResolveApprovalAction,
  wandResolveConsentAction,
  wandResolvePlanAction,
} from "@/app/[orgSlug]/shell-actions";
import type { ComposerAction } from "@/components/chat/message-composer";
import type { ChatShellProps } from "@/components/chat/chat-shell";
import type { ChatMessage } from "@/components/chat/message-bubble";
import type { ChatPageContext } from "@/components/chat/chat-shell-client";
import type { FormFillResult } from "@/lib/ask/fill-types";

const EMPTY_MESSAGES: ChatMessage[] = [];

export interface AskDrawerProps {
  orgSlug: string;
  availableWorkspaces: { slug: string; name: string; publicId: string }[];
  modelConfig: ResolvedTierCatalog;
}

export function AskDrawer({ orgSlug, availableWorkspaces, modelConfig }: AskDrawerProps) {
  const { isAskOpen, closeAsk, fillableForm, entity, _setIsFilling, _setFillResult, pendingAskText, _clearPendingAskText } = usePageContext();
  const pathname = usePathname();

  // Ref to the inner content div so we can find the composer textarea when
  // the drawer opens with pendingAskText from a Quick Action invocation.
  const contentRef = React.useRef<HTMLDivElement>(null);

  // When the drawer opens and there is pending text from a Quick Action,
  // programmatically seed the composer's textarea and clear the pending state.
  // We use a short rAF delay to ensure the Suspense-lazy ChatShellClient has
  // mounted its textarea before we try to populate it.
  React.useEffect(() => {
    if (!isAskOpen || !pendingAskText) return;
    const text = pendingAskText;
    _clearPendingAskText();
    let rafId: number;
    // Poll for the textarea in the Sheet — it's lazy-loaded via Suspense.
    let attempts = 0;
    function tryPopulate() {
      attempts += 1;
      const textarea = contentRef.current?.querySelector<HTMLTextAreaElement>("textarea[name='content']");
      if (textarea) {
        // Use the React-synthetic native value setter so controlled components
        // that intercept the native `input` event are notified.
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype,
          "value",
        )?.set;
        if (nativeInputValueSetter) {
          nativeInputValueSetter.call(textarea, text);
          textarea.dispatchEvent(new Event("input", { bubbles: true }));
        } else {
          textarea.value = text;
        }
        textarea.focus();
      } else if (attempts < 20) {
        // Retry up to ~1s (50ms × 20) waiting for Suspense to resolve.
        rafId = window.setTimeout(tryPopulate, 50);
      }
    }
    rafId = requestAnimationFrame(() => { rafId = window.setTimeout(tryPopulate, 50); });
    return () => {
      cancelAnimationFrame(rafId);
      clearTimeout(rafId);
    };
  }, [isAskOpen, pendingAskText, _clearPendingAskText]);

  // Build the serialisable page context from the current PageContext state at
  // send-time. Captured once per send so the closure always has latest values.
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

  // Callbacks forwarded to ChatShellClient to wire fill results into PageContext.
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

  const ctx = resolveSidebarCtx(pathname, { orgSlug });
  const activeWorkspaceSlug =
    ctx.workspaceSlug ?? availableWorkspaces[0]?.slug ?? "";

  const chatHref = activeWorkspaceSlug
    ? `/${orgSlug}/${activeWorkspaceSlug}/ask`
    : `/${orgSlug}`;

  const scopedSendAction = React.useCallback<ComposerAction>(
    async (formData: FormData) => {
      formData.set("orgSlug", orgSlug);
      formData.set("workspaceSlug", activeWorkspaceSlug);
      return wandSendAction(formData);
    },
    [orgSlug, activeWorkspaceSlug],
  );

  const scopedResolveApprovalAction = React.useCallback<
    ChatShellProps["resolveApprovalAction"]
  >(
    async (approvalId, decision) =>
      wandResolveApprovalAction(orgSlug, activeWorkspaceSlug, approvalId, decision),
    [orgSlug, activeWorkspaceSlug],
  );

  const scopedResolveConsentAction = React.useCallback<
    ChatShellProps["resolveConsentAction"]
  >(
    async (approvalId, decision, grantAllTools) =>
      wandResolveConsentAction(orgSlug, activeWorkspaceSlug, approvalId, decision, grantAllTools),
    [orgSlug, activeWorkspaceSlug],
  );

  const scopedResolvePlanAction = React.useCallback<ChatShellProps["resolvePlanAction"]>(
    async (planId, decision, amendedSteps) =>
      wandResolvePlanAction(orgSlug, activeWorkspaceSlug, planId, decision, amendedSteps),
    [orgSlug, activeWorkspaceSlug],
  );

  return (
    <Sheet
      open={isAskOpen}
      onOpenChange={(open) => !open && closeAsk()}
      disablePointerDismissal
    >
      <SheetPopup
        side="right"
        className={cn(
          "flex flex-col p-0",
          "w-full sm:w-[480px] sm:max-w-[480px]",
          "[&]:sm:max-w-[480px]",
        )}
      >
        <SheetHeader className="flex flex-row items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <span
              className="inline-flex size-7 items-center justify-center rounded-lg border border-border bg-muted"
              aria-hidden="true"
            >
              <Sparkles className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </span>
            <SheetTitle className="text-sm font-medium">Ask Oxagen</SheetTitle>
          </div>
          <div className="flex items-center gap-1 pr-6">
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

        <div ref={contentRef} className="flex min-h-0 flex-1 flex-col overflow-hidden p-4">
          <AskDrawerChatShell
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
      </SheetPopup>
    </Sheet>
  );
}

const LazyChatShellClient = React.lazy(() =>
  import("@/components/chat/chat-shell-client").then((m) => ({
    default: m.ChatShellClient,
  })),
);

function AskDrawerChatShell({
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
  // Snapshot page context at render time so LazyChatShellClient gets a stable
  // value each render without capturing the mutable ref directly.
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
