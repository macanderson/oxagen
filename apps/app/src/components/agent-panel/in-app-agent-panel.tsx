"use client";
/**
 * InAppAgentPanel — the unified Linear-style in-app AI agent panel.
 *
 * Two size modes:
 *   - Standard: right 1/3 of the page, ~80% viewport height, anchored bottom-right.
 *   - Expanded: right 2/3 of the page (everything except the sidebar), 100% height.
 *
 * Header controls: minimize (_), expand/shrink (⤢), close (×), three-dots menu.
 * The panel overlays the page content (fixed positioning) so the underlying
 * page remains intact and scrollable underneath in standard mode.
 *
 * Workspace resolution mirrors the WandPanel approach: resolve the active
 * workspace from usePathname() so the panel persists across navigations.
 */

import * as React from "react";
import { Suspense } from "react";
import { usePathname } from "next/navigation";
import {
  X,
  Minus,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Copy,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { usePageContext } from "@/lib/page-context";
import { resolveSidebarCtx } from "@/lib/sidebar";
import { useAgentPanelStore } from "./use-agent-panel-store";
import { copyConversationAsMarkdown } from "./copy-as-markdown";
import { useToast } from "@/components/ui/toast";
import type { ResolvedTierCatalog } from "@oxagen/ai/catalog";
import type { ComposerAction } from "@/components/chat/message-composer";
import type { ChatShellProps } from "@/components/chat/chat-shell";
import type { ChatMessage } from "@/components/chat/message-bubble";
import type { ChatPageContext } from "@/components/chat/chat-shell-client";
import type { FormFillResult } from "@/lib/ask/fill-types";
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuPortal,
  MenuSeparator,
} from "@/components/ui/menu";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipPopup } from "@/components/ui/tooltip";
import {
  wandSendAction,
  wandResolveApprovalAction,
  wandResolveConsentAction,
  wandResolvePlanAction,
} from "@/app/[orgSlug]/shell-actions";

const EMPTY_MESSAGES: ChatMessage[] = [];

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface InAppAgentPanelProps {
  /** The org slug from the server layout. */
  orgSlug: string;
  /** Available workspaces for fallback resolution. */
  availableWorkspaces: { slug: string; name: string; publicId: string }[];
  /** Resolved tier→model catalog forwarded to the composer. */
  modelConfig: ResolvedTierCatalog;
}

// ---------------------------------------------------------------------------
// Panel Component
// ---------------------------------------------------------------------------

export function InAppAgentPanel({
  orgSlug,
  availableWorkspaces,
  modelConfig,
}: InAppAgentPanelProps) {
  const {
    visibility,
    sizeMode,
    conversationTitle,
    close,
    collapse,
    toggleSize,
    setStatus,
    setConversationTitle,
    startNewChat,
  } = useAgentPanelStore();

  const pathname = usePathname();
  const messagesRef = React.useRef<ChatMessage[]>(EMPTY_MESSAGES);

  // Don't render when fully closed.
  if (visibility !== "open") {
    return null;
  }

  // Resolve active workspace from the URL.
  const ctx = resolveSidebarCtx(pathname, { orgSlug });
  const activeWorkspaceSlug =
    ctx.workspaceSlug ?? availableWorkspaces[0]?.slug ?? "";

  const isExpanded = sizeMode === "expanded";

  return (
    <div
      className={cn(
        "fixed z-50 flex flex-col overflow-hidden",
        "rounded-lg border border-border bg-background shadow-2xl",
        "transition-all duration-200 ease-in-out",
        // Standard mode: right 1/3, 80% height, anchored bottom-right with margin.
        !isExpanded && "bottom-4 right-4 w-[min(420px,33vw)] min-w-[360px]",
        !isExpanded && "h-[80vh] max-h-[800px]",
        // Expanded mode: right 2/3, full height minus shell padding.
        isExpanded && "bottom-2 right-2 top-2",
        isExpanded &&
          "w-[calc(66.667vw-var(--sidebar-collapsed-width,56px))] min-w-[600px]",
      )}
      role="dialog"
      aria-label="AI Agent"
      aria-modal={false}
    >
      {/* Header */}
      <PanelHeader
        title={conversationTitle ?? "New chat"}
        isExpanded={isExpanded}
        onCollapse={collapse}
        onToggleSize={toggleSize}
        onClose={close}
        onNewChat={startNewChat}
        messagesRef={messagesRef}
      />

      {/* Chat area */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <AgentChatShell
          orgSlug={orgSlug}
          workspaceSlug={activeWorkspaceSlug}
          modelConfig={modelConfig}
          messagesRef={messagesRef}
          onStatusChange={setStatus}
          onTitleChange={setConversationTitle}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function PanelHeader({
  title,
  isExpanded,
  onCollapse,
  onToggleSize,
  onClose,
  onNewChat,
  messagesRef,
}: {
  title: string;
  isExpanded: boolean;
  onCollapse: () => void;
  onToggleSize: () => void;
  onClose: () => void;
  onNewChat: () => void;
  messagesRef: React.RefObject<ChatMessage[]>;
}) {
  const { add: addToast } = useToast();

  const handleCopyAsMarkdown = React.useCallback(async () => {
    const messages = messagesRef.current;
    if (!messages || messages.length === 0) {
      addToast({ type: "info", title: "Nothing to copy" });
      return;
    }
    const ok = await copyConversationAsMarkdown(messages);
    if (ok) {
      addToast({ type: "success", title: "Copied as markdown" });
    } else {
      addToast({ type: "error", title: "Failed to copy" });
    }
  }, [messagesRef, addToast]);

  const handleDelete = React.useCallback(() => {
    onNewChat();
  }, [onNewChat]);

  return (
    <header className="flex h-11 shrink-0 items-center gap-1 border-b border-border bg-background px-3">
      {/* Title */}
      <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
        {title}
      </h2>

      {/* Three-dots menu */}
      <Menu>
        <MenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              aria-label="Conversation options"
            />
          }
        >
          <MoreHorizontal className="h-4 w-4" />
        </MenuTrigger>
        <MenuPortal>
          <MenuPopup className="min-w-[180px]">
            <MenuItem onClick={handleCopyAsMarkdown}>
              <Copy className="mr-2 h-4 w-4" />
              Copy as markdown
            </MenuItem>
            <MenuSeparator />
            <MenuItem onClick={handleDelete}>
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </MenuItem>
          </MenuPopup>
        </MenuPortal>
      </Menu>

      {/* Minimize */}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              aria-label="Minimize"
              onClick={onCollapse}
            />
          }
        >
          <Minus className="h-4 w-4" />
        </TooltipTrigger>
        <TooltipPopup>Minimize</TooltipPopup>
      </Tooltip>

      {/* Expand/Shrink */}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              aria-label={isExpanded ? "Shrink panel" : "Expand panel"}
              onClick={onToggleSize}
            />
          }
        >
          {isExpanded ? (
            <Minimize2 className="h-4 w-4" />
          ) : (
            <Maximize2 className="h-4 w-4" />
          )}
        </TooltipTrigger>
        <TooltipPopup>{isExpanded ? "Standard size" : "Expand"}</TooltipPopup>
      </Tooltip>

      {/* Close */}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              aria-label="Close"
              onClick={onClose}
            />
          }
        >
          <X className="h-4 w-4" />
        </TooltipTrigger>
        <TooltipPopup>Close</TooltipPopup>
      </Tooltip>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Inner lazy chat shell — uses the same pattern as WandPanel.
// ---------------------------------------------------------------------------

const LazyChatShellClient = React.lazy(() =>
  import("@/components/chat/chat-shell-client").then((m) => ({
    default: m.ChatShellClient,
  })),
);

function AgentChatShell({
  orgSlug,
  workspaceSlug,
  modelConfig,
  messagesRef: _messagesRef,
  onStatusChange,
  onTitleChange: _onTitleChange,
}: {
  orgSlug: string;
  workspaceSlug: string;
  modelConfig: ResolvedTierCatalog;
  messagesRef: React.MutableRefObject<ChatMessage[]>;
  onStatusChange: (status: "idle" | "active" | "completed") => void;
  onTitleChange: (title: string | null) => void;
}) {
  const { fillableForm, entity, _setIsFilling, _setFillResult } =
    usePageContext();
  const pathname = usePathname();

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

  // Scoped send action: inject orgSlug + workspaceSlug into FormData.
  const scopedSendAction = React.useCallback<ComposerAction>(
    async (formData: FormData) => {
      formData.set("orgSlug", orgSlug);
      formData.set("workspaceSlug", workspaceSlug);
      onStatusChange("active");
      const result = await wandSendAction(formData);
      onStatusChange("completed");
      return result;
    },
    [orgSlug, workspaceSlug, onStatusChange],
  );

  const scopedResolveApprovalAction = React.useCallback<
    ChatShellProps["resolveApprovalAction"]
  >(
    async (approvalId, decision) => {
      return wandResolveApprovalAction(
        orgSlug,
        workspaceSlug,
        approvalId,
        decision,
      );
    },
    [orgSlug, workspaceSlug],
  );

  const scopedResolveConsentAction = React.useCallback<
    ChatShellProps["resolveConsentAction"]
  >(
    async (approvalId, decision, grantAllTools) => {
      return wandResolveConsentAction(
        orgSlug,
        workspaceSlug,
        approvalId,
        decision,
        grantAllTools,
      );
    },
    [orgSlug, workspaceSlug],
  );

  const scopedResolvePlanAction = React.useCallback<
    ChatShellProps["resolvePlanAction"]
  >(
    async (planId, decision, amendedSteps) => {
      return wandResolvePlanAction(
        orgSlug,
        workspaceSlug,
        planId,
        decision,
        amendedSteps,
      );
    },
    [orgSlug, workspaceSlug],
  );

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
        sendAction={scopedSendAction}
        resolveApprovalAction={scopedResolveApprovalAction}
        resolveConsentAction={scopedResolveConsentAction}
        resolvePlanAction={scopedResolvePlanAction}
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        modelConfig={modelConfig}
        pageContext={pageCtx}
        onFormFillStart={handleFormFillStart}
        onFormFillEnd={handleFormFillEnd}
      />
    </Suspense>
  );
}
