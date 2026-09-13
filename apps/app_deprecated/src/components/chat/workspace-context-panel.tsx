"use client";

/**
 * WorkspaceContextPanel — the persistent chat side-panel's file surface,
 * mounted alongside the transcript (see `chat-shell-client.tsx`).
 *
 * It renders `ConversationFilesList` (`./conversation-files.tsx`) — the
 * client-side fetch (`GET /api/v1/conversations/:id/assets`) and row rendering
 * for this conversation's attachments. This is the single surface for
 * conversation files, so there is exactly one implementation of "list this
 * conversation's files".
 *
 * ADR-043 removed the second "Workspace" tab: it browsed a live sandbox
 * working tree (`list_sandbox_files`), and Oxagen no longer runs sandboxes.
 * With one surface left the tab strip itself is gone — a single-tab tab bar is
 * chrome that explains nothing.
 */

import * as React from "react";
import { cn } from "@/lib/utils";
import { ConversationFilesList } from "./conversation-files";

export interface WorkspaceContextPanelProps {
  /** publicId of the active conversation — powers the files fetch. */
  conversationPublicId: string | null;
  className?: string;
}

/**
 * The chrome-less files body, WITHOUT the bordered card wrapper. The
 * agent-activity rail drops this straight into its own "Files" card, which
 * already draws a border and shadow; `WorkspaceContextPanel` wraps it in that
 * chrome itself.
 */
export function WorkspaceContextTabs({
  conversationPublicId,
  className,
}: WorkspaceContextPanelProps) {
  return (
    <div
      // Marker on the shared body (not the WorkspaceContextPanel wrapper) so
      // the rail's Files card — which renders this directly — is findable.
      data-component="workspace-context-panel-tabs"
      className={cn("flex min-h-0 flex-1 flex-col overflow-y-auto", className)}
    >
      <ConversationFilesList
        conversationPublicId={conversationPublicId}
        active
      />
    </div>
  );
}

export function WorkspaceContextPanel({
  conversationPublicId,
  className,
}: WorkspaceContextPanelProps) {
  return (
    // The `data-component` marker rides on the inner WorkspaceContextTabs, not
    // on this wrapper, so there is never a duplicate marker in the tree.
    <div
      className={cn(
        "flex min-h-0 flex-col rounded-xl border border-border bg-card text-card-foreground shadow-sm",
        className,
      )}
    >
      <WorkspaceContextTabs
        conversationPublicId={conversationPublicId}
        className="p-2"
      />
    </div>
  );
}
