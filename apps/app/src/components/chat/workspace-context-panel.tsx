"use client";

/**
 * WorkspaceContextPanel — the persistent chat side-panel's file surface: a
 * tabbed "Files" / "Workspace" view mounted alongside the transcript (see
 * `chat-shell-client.tsx`).
 *
 * "Files" reuses `ConversationFilesList` (`./conversation-files.tsx`) — the
 * exact same fetch (`GET /api/v1/conversations/:id/assets`) and row rendering
 * the header's Sheet-based `ConversationFiles` trigger uses, so there is one
 * implementation of "list this conversation's generated assets", not two.
 *
 * "Workspace" delegates entirely to the existing model-dispatched
 * `registry-components/workspace-context-panel.tsx` (componentId
 * "workspace-context-panel") — it already implements the full
 * `agent.sandbox_file.list`/`.read` fetch, lazy directory expansion, and file
 * viewer against `FileTreeCard`. Reusing it here (instead of a second
 * hand-rolled sandbox-file fetch) means the two surfaces can never drift out
 * of sync on the sandbox file contract. The tab only appears once the turn
 * has actually started a durable sandbox session (an `agent.sandbox.start`
 * tool call completed with a `sessionId`) — before that there is nothing to
 * browse.
 */

import * as React from "react";
import { Paperclip, FolderTree } from "lucide-react";
import { Tabs, TabsList, TabsTab, TabsPanel } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { ConversationFilesList } from "./conversation-files";
// Aliased import: the default export is itself named `WorkspaceContextPanel`
// (it's the model-dispatched registry component for componentId
// "workspace-context-panel") — alias it so this file's own exported
// `WorkspaceContextPanel` (the persistent tabbed panel) isn't shadowed.
import SandboxWorkspaceTree from "./registry-components/workspace-context-panel";
import type { LiveToolCall } from "./use-tool-stream";

/**
 * Finds the `sessionId` of the most recently completed `agent.sandbox.start`
 * tool call in the live turn's tool-call state, or null if the turn hasn't
 * started a durable sandbox session. Exported (pure) for unit testing.
 */
export function findActiveSandboxSessionId(
  toolCalls: Record<string, LiveToolCall>,
): string | null {
  let found: string | null = null;
  let latestStart = -Infinity;
  for (const tc of Object.values(toolCalls)) {
    if (tc.capability !== "start_sandbox" || tc.status !== "completed") continue;
    const output = tc.output as Record<string, unknown> | null;
    const sessionId = output && typeof output.sessionId === "string" ? output.sessionId : null;
    if (!sessionId) continue;
    if (tc.startedAt >= latestStart) {
      latestStart = tc.startedAt;
      found = sessionId;
    }
  }
  return found;
}

export interface WorkspaceContextPanelProps {
  /** publicId of the active conversation — powers the "Files" tab's fetch. */
  conversationPublicId: string | null;
  orgSlug: string;
  workspaceSlug: string;
  /** Live tool-call state from `useToolStream()` — used to detect an active sandbox. */
  toolCalls: Record<string, LiveToolCall>;
  className?: string;
}

type PanelTab = "files" | "workspace";

export function WorkspaceContextPanel({
  conversationPublicId,
  orgSlug,
  workspaceSlug,
  toolCalls,
  className,
}: WorkspaceContextPanelProps) {
  const sandboxSessionId = React.useMemo(
    () => findActiveSandboxSessionId(toolCalls),
    [toolCalls],
  );
  const [tab, setTab] = React.useState<PanelTab>("files");

  // The first time a sandbox session appears this turn, default the panel to
  // the Workspace tab — that's almost always what the user wants to see
  // right after code-mode kicks off. Subsequent renders (sandbox still
  // active) never force the tab again, so the user's own tab choice sticks.
  const sawSandboxRef = React.useRef(false);
  React.useEffect(() => {
    if (sandboxSessionId && !sawSandboxRef.current) {
      sawSandboxRef.current = true;
      setTab("workspace");
    }
  }, [sandboxSessionId]);

  return (
    <div
      data-component="workspace-context-panel-tabs"
      className={cn(
        "flex min-h-0 flex-col rounded-xl border border-border bg-card text-card-foreground shadow-sm",
        className,
      )}
    >
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as PanelTab)}
        className="flex min-h-0 flex-1 flex-col p-2"
      >
        <TabsList variant="underline">
          <TabsTab value="files" className="gap-1.5">
            <Paperclip className="size-3.5" aria-hidden="true" />
            <span>Files</span>
          </TabsTab>
          {sandboxSessionId ? (
            <TabsTab value="workspace" className="gap-1.5">
              <FolderTree className="size-3.5" aria-hidden="true" />
              <span>Workspace</span>
            </TabsTab>
          ) : null}
        </TabsList>

        <TabsPanel value="files" className="min-h-0 flex-1 overflow-y-auto">
          <ConversationFilesList conversationPublicId={conversationPublicId} active={tab === "files"} />
        </TabsPanel>

        {sandboxSessionId ? (
          <TabsPanel value="workspace" className="min-h-0 flex-1 overflow-y-auto">
            <SandboxWorkspaceTree
              sessionId={sandboxSessionId}
              orgSlug={orgSlug}
              workspaceSlug={workspaceSlug}
              title="Workspace files"
            />
          </TabsPanel>
        ) : null}
      </Tabs>
    </div>
  );
}
