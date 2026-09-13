"use client";
/**
 * AgentBottomBar — persistent bottom bar shown across all pages.
 *
 * Behavior mirrors Linear's agent bottom bar:
 *   - When a conversation is collapsed: shows the conversation title with a
 *     status indicator (pulsing green = active, static blue = completed,
 *     hidden = idle). Clicking the title re-opens the panel.
 *   - "Ask Oxagen" button + send icon on the right side always launches the
 *     agent panel (new chat if none active).
 *
 * The bar is always visible at the bottom of the content panel (not the
 * viewport — it scrolls with the shell's main content area). It sits above
 * the MobileBottomBar on small screens.
 */

import * as React from "react";
import { usePathname } from "next/navigation";
import { Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAgentPanelStore } from "./use-agent-panel-store";
import type { AgentStatus } from "./use-agent-panel-store";

// ---------------------------------------------------------------------------
// Route awareness
// ---------------------------------------------------------------------------

/**
 * The canonical full-page agent conversation surface is `/{org}/{ws}/sessions`
 * (the legacy `/chat` and `/ask` routes now 301-redirect here). On that surface
 * the user is already inside the agent, so the docked launcher would let them
 * open a second floating agent panel on top of the first — an "agent on top of
 * another agent". Match on the trailing path segment so this is exact: an
 * org/workspace literally named "sessions" earlier in the path never triggers a
 * false positive.
 */
function isConversationSurface(pathname: string | null): boolean {
  if (!pathname) return false;
  const segments = pathname.split("/").filter(Boolean);
  return segments[segments.length - 1] === "sessions";
}

// ---------------------------------------------------------------------------
// Status Indicator
// ---------------------------------------------------------------------------

function StatusIndicator({ status }: { status: AgentStatus }) {
  if (status === "idle") return null;

  return (
    <span
      className={cn(
        "inline-block h-2.5 w-2.5 rounded-full",
        status === "active" && "animate-pulse bg-emerald-500",
        status === "completed" && "bg-blue-500",
      )}
      aria-label={status === "active" ? "Agent is working" : "Agent completed"}
    />
  );
}

// ---------------------------------------------------------------------------
// AgentBottomBar
// ---------------------------------------------------------------------------

export function AgentBottomBar() {
  const pathname = usePathname();
  const { visibility, status, conversationTitle, open } = useAgentPanelStore();

  // Suppress the docked launcher on the full-page agent surface
  // (`/{org}/{ws}/sessions`) — the page there IS the agent, so launching the
  // floating panel would stack a second agent on top of it. Every other page
  // keeps the bar.
  if (isConversationSurface(pathname)) return null;

  // The bar is visible on all other pages. When the panel is open the bar still
  // renders (behind it) but we hide the collapsed conversation indicator
  // since the user is already looking at the full panel.
  const showCollapsedConversation =
    visibility === "collapsed" && conversationTitle !== null;

  return (
    <div
      className={cn(
        "flex h-10 shrink-0 items-center gap-2 border-t border-border bg-background px-3",
        "text-sm text-muted-foreground",
      )}
      role="toolbar"
      aria-label="Agent toolbar"
    >
      {/* Left side: collapsed conversation tabs (like Linear's bottom tabs) */}
      <div className="flex min-w-0 flex-1 items-center gap-3 overflow-x-auto">
        {showCollapsedConversation && (
          <button
            type="button"
            onClick={open}
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1 text-xs font-medium",
              "truncate transition-colors",
              "hover:bg-muted hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              // Active conversation tab styling.
              "bg-muted/50 text-foreground",
            )}
            aria-label={`Resume conversation: ${conversationTitle}`}
          >
            <StatusIndicator status={status} />
            <span className="truncate max-w-[200px]">{conversationTitle}</span>
          </button>
        )}
      </div>

      {/* Right side: "Ask Oxagen" launch button */}
      <button
        type="button"
        onClick={open}
        className={cn(
          "flex items-center gap-2 rounded-md px-3 py-1.5",
          "text-xs font-medium text-muted-foreground",
          "transition-colors hover:text-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
        aria-label="Open AI agent"
      >
        <Send className="h-3.5 w-3.5" aria-hidden="true" />
        <span>Ask Oxagen</span>
      </button>
    </div>
  );
}
