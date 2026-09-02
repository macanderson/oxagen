"use client";
/**
 * chat-header-desktop.tsx — the v2 desktop chat header (chat_ux_v2 + non-mobile
 * viewport only; see chat-shell-client.tsx's mount gate). A single compact
 * (~48px) row at the top of the conversation column: agent avatar + name over
 * a `{model} · {repo} @ {branch} · {environment}` subtitle, with a pulsing
 * activity dot while streaming.
 *
 * The ENTIRE header is one button — there is no separate settings icon.
 * Clicking it calls `onFocusSessionPanel`, which the caller wires to scroll
 * the rail's always-visible Session panel into view and focus its first
 * control, mirroring the mobile header's tap-to-open-settings affordance but
 * pointing at the rail instead of a drawer (desktop keeps settings visible,
 * not hidden behind a sheet).
 *
 * Props-driven — no data fetching here. Reads the unified session store
 * directly via `useChatSession()` (safe: only ever mounted once
 * `useChatSessionContext() !== null`, see chat-shell-client.tsx) and projects
 * it through the same `sessionSubtitleParts()` the mobile header, the rail,
 * and SessionSettings use, so this header can never disagree with the panel
 * it opens.
 */
import * as React from "react";
import { cn } from "@/lib/utils";
import { useChatSession } from "./session/session-store";
import { sessionSubtitleParts } from "./session/session-state";
import { modelLabelOf } from "./message-receipt";
import { AgentAvatar } from "./agent-picker/agent-avatar";
import type { RepoOption } from "./repo-selector";
import type { EnvironmentOption } from "./environment-selector";
import type { AgentOption } from "./agent-picker/agent-picker-types";

/** "fast" → "Fast" — the no-catalog fallback label for a bare tier id. */
function tierLabel(tier: string): string {
  return tier.length > 0 ? tier.charAt(0).toUpperCase() + tier.slice(1) : tier;
}

/**
 * Middle-ellipsize a value once it exceeds `maxLen`: keep the first `headLen`
 * characters, an ellipsis, then the last `tailLen` characters. Used ONLY for
 * the header's repo segment — the full, unellipsized value always lives in
 * the rail's Session panel, so nothing is ever lost, just abbreviated here.
 */
export function middleEllipsis(
  value: string,
  maxLen = 24,
  headLen = 12,
  tailLen = 8,
): string {
  if (value.length <= maxLen) return value;
  return `${value.slice(0, headLen)}…${value.slice(value.length - tailLen)}`;
}

export interface ChatHeaderDesktopProps {
  /** Selectable agents, for resolving the current agent's display name + avatar. */
  agents: readonly AgentOption[];
  /** GitHub repos, for resolving the current repo/branch subtitle segment. */
  repos: readonly RepoOption[];
  /** Workspace environments, for resolving the current environment segment. */
  environments: readonly EnvironmentOption[];
  /** Shows a pulsing activity dot while true. */
  isStreaming: boolean;
  /** Scrolls the rail's Session panel into view and focuses its first
   * focusable control. */
  onFocusSessionPanel: () => void;
}

export function ChatHeaderDesktop({
  agents,
  repos,
  environments,
  isStreaming,
  onFocusSessionPanel,
}: ChatHeaderDesktopProps) {
  const { state } = useChatSession();
  const agent = agents.find((a) => a.agentId === state.agentId) ?? null;
  const agentName = agent?.name ?? "Default assistant";

  const modelLabel = state.model
    ? modelLabelOf(state.model)
    : tierLabel(state.tier ?? "fast");

  const parts = sessionSubtitleParts(state, {
    repos,
    environments,
    modelLabel,
  });
  const repoSegment = parts.repo
    ? parts.branch
      ? `${middleEllipsis(parts.repo)} @ ${parts.branch}`
      : middleEllipsis(parts.repo)
    : null;
  const subtitle = [parts.model, repoSegment, parts.environment]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  return (
    <button
      type="button"
      data-component="chat-header-desktop"
      aria-label="Session settings"
      onClick={onFocusSessionPanel}
      className={cn(
        "flex h-12 w-full shrink-0 items-center gap-2 rounded-lg border border-transparent px-2 text-left",
        "hover:border-border hover:bg-accent/40",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      <AgentAvatar
        avatarUrl={agent?.avatarUrl ?? null}
        name={agentName}
        slug={agent?.slug ?? "default"}
        size="sm"
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-foreground">
          {agentName}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {subtitle}
        </span>
      </span>
      {isStreaming ? (
        <span
          aria-hidden="true"
          data-testid="chat-header-desktop-activity-dot"
          className="size-1.5 shrink-0 rounded-full bg-info animate-pulse motion-reduce:animate-none"
        />
      ) : null}
    </button>
  );
}
