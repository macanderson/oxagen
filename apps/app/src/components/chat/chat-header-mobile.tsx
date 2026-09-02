"use client";
/**
 * chat-header-mobile.tsx — the v2 mobile chat header (chat_ux_v2 + phone
 * width only; see chat-shell-client.tsx's mount gate). Slim 48px bar:
 * conversations on the left, a tap-to-open session-settings summary in the
 * center (agent name over the `{model} · {branch}` subtitle), activity +
 * notifications on the right.
 *
 * Props-driven — no data fetching here. The center summary reads the
 * unified session store directly via `useChatSession()` (safe: this
 * component is only ever mounted once `useChatSessionContext() !== null`,
 * see the mount gate in chat-shell-client.tsx) and projects it through the
 * same `sessionSubtitleParts()` the desktop rail and SessionSettings use, so
 * the header can never disagree with the panel it opens.
 */
import * as React from "react";
import { Activity, History } from "lucide-react";
import { cn } from "@/lib/utils";
import { useChatSession } from "./session/session-store";
import { sessionSubtitleParts } from "./session/session-state";
import { modelLabelOf } from "./message-receipt";
import type { RepoOption } from "./repo-selector";
import type { EnvironmentOption } from "./environment-selector";
import type { AgentOption } from "./agent-picker/agent-picker-types";

/** "fast" → "Fast" — the no-catalog fallback label for a bare tier id. */
function tierLabel(tier: string): string {
  return tier.length > 0 ? tier.charAt(0).toUpperCase() + tier.slice(1) : tier;
}

export interface ChatHeaderMobileProps {
  /** Selectable agents, for resolving the current agent's display name. */
  agents: readonly AgentOption[];
  /** GitHub repos, for resolving the current repo/branch subtitle. */
  repos: readonly RepoOption[];
  /** Workspace environments (unused in the mobile subtitle, kept for parity
   * with `sessionSubtitleParts`' options shape). */
  environments: readonly EnvironmentOption[];
  /** Shows a pulsing status dot on the Activity button while true. */
  isStreaming: boolean;
  /** Opens the conversations list/drawer. Omit to render an inert button. */
  onOpenConversations?: () => void;
  /** Opens the session-settings drawer. */
  onOpenSettings: () => void;
  /** Opens the activity/trace bottom sheet. */
  onOpenActivity: () => void;
  /** The shell's notifications bell, embedded as-is (it is fully
   * self-contained — own data fetching, own org/workspace resolution via
   * `useParams()` — so passing it through here doesn't violate this
   * component's "no data fetching" rule). Omitted ⇒ no bell in the header. */
  notificationsSlot?: React.ReactNode;
}

export function ChatHeaderMobile({
  agents,
  repos,
  environments,
  isStreaming,
  onOpenConversations,
  onOpenSettings,
  onOpenActivity,
  notificationsSlot,
}: ChatHeaderMobileProps) {
  const { state } = useChatSession();

  const agentName =
    agents.find((a) => a.agentId === state.agentId)?.name ??
    "Default assistant";

  const modelLabel = state.model
    ? modelLabelOf(state.model)
    : tierLabel(state.tier ?? "fast");

  const parts = sessionSubtitleParts(state, {
    repos,
    environments,
    modelLabel,
  });
  const subtitle = parts.branch
    ? `${parts.model} · ${parts.branch}`
    : parts.model;

  return (
    <header
      data-component="chat-header-mobile"
      className="flex h-12 shrink-0 items-center gap-1 border-b border-border bg-background px-1"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      <button
        type="button"
        aria-label="Conversations"
        onClick={onOpenConversations}
        className={cn(
          "flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground",
          "hover:bg-accent/60 hover:text-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        <History className="size-4" aria-hidden="true" />
      </button>

      <button
        type="button"
        aria-label="Session settings"
        onClick={onOpenSettings}
        className={cn(
          "flex min-w-0 flex-1 flex-col items-center justify-center gap-0 rounded-md px-1 py-1 text-center",
          "hover:bg-accent/40",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        <span className="w-full truncate text-sm font-medium text-foreground">
          {agentName}
        </span>
        <span className="w-full truncate text-[11px] text-muted-foreground">
          {subtitle}
        </span>
      </button>

      <button
        type="button"
        aria-label={isStreaming ? "Activity, in progress" : "Activity"}
        onClick={onOpenActivity}
        className={cn(
          "relative flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground",
          "hover:bg-accent/60 hover:text-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        <Activity className="size-4" aria-hidden="true" />
        {isStreaming ? (
          <span
            aria-hidden="true"
            data-testid="chat-header-activity-dot"
            className="absolute right-2 top-2 size-1.5 rounded-full bg-info animate-pulse motion-reduce:animate-none"
          />
        ) : null}
      </button>

      {notificationsSlot}
    </header>
  );
}
