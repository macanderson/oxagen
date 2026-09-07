"use client";

/**
 * AgentActivityRail — the calm, always-present right rail for a chat surface.
 * Two titled cards, each with a collapse control and a graceful ambient state,
 * so the rail is reassuring even before the first turn:
 *
 *   • Progress — the live turn as an ordered list of governed tool calls, with
 *     a compact "Working · N tools" / "Turn complete" status line above.
 *   • Files — the conversation's attachments (reuses `WorkspaceContextTabs`).
 *
 * ADR-043 removed the third card (Context): it described the repository,
 * branch, sandbox environment, and open PR a coding turn was grounded in, and
 * Oxagen no longer runs coding turns. In chat_ux_v2 the writable Session panel
 * (`sessionPanelSlot`) already occupies that slot.
 *
 * Pure client composition over existing state and components — no new stream
 * events, no engine changes, no new fetches.
 */

import * as React from "react";
import { ChevronDown, ListTodo, FolderOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { WorkspaceContextTabs } from "./workspace-context-panel";
import { toolCallMeta } from "./tool-call-meta";
import type { LiveToolCall } from "./use-tool-stream";
import type { TurnUsage } from "./stream-event-types";

// ---------------------------------------------------------------------------
// Shared card chrome
// ---------------------------------------------------------------------------

interface RailCardProps {
  icon: React.ComponentType<{ className?: string }>;
  /** Stable test/DOM identifier (`data-card`) — independent of `title`, which
   * changes text in v2's idle states ("Progress · idle", "Files · 0"). */
  cardId: string;
  title: string;
  /** Small count/state pill shown right-aligned in the header. */
  badge?: React.ReactNode;
  /** Pulsing dot in the header while the turn is streaming. */
  live?: boolean;
  defaultOpen?: boolean;
  /**
   * Controlled open state (chat_ux_v2's idle-collapse/auto-expand cards).
   * Omit for the legacy uncontrolled toggle (`defaultOpen` + internal state).
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}

/**
 * One titled, collapsible rail card: header (icon · title · live dot · badge ·
 * chevron) over a bordered body. No trailing helper caption — every card body
 * renders either real content or a self-explanatory empty state.
 */
function RailCard({
  icon: Icon,
  cardId,
  title,
  badge,
  live = false,
  defaultOpen = true,
  open: controlledOpen,
  onOpenChange,
  children,
}: RailCardProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;
  const toggle = () => {
    const next = !open;
    if (isControlled) onOpenChange?.(next);
    else setUncontrolledOpen(next);
  };
  return (
    <section
      data-component="rail-card"
      data-card={cardId}
      className="overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-sm"
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2.5 text-left",
          "hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        )}
      >
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate text-sm font-semibold">{title}</span>
        {live ? (
          <span
            className="size-1.5 shrink-0 rounded-full bg-info animate-pulse"
            aria-hidden="true"
          />
        ) : null}
        {badge != null ? (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {badge}
          </span>
        ) : null}
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <div className="border-t border-border/60 px-3 pb-3 pt-2.5">
          {children}
        </div>
      ) : null}
    </section>
  );
}

/**
 * Controlled open/auto-expand state shared by the v2 Progress and Files
 * cards: starts open iff there's already content to show, flips open the
 * first time `active` becomes true (streaming starts / first row or file
 * appears) UNLESS the user has manually toggled the card — once they touch
 * it, their choice wins for the rest of the session (no fighting the user).
 */
function useV2CardOpenState(active: boolean, hasContent: boolean) {
  const userToggledRef = React.useRef(false);
  const [open, setOpen] = React.useState(() => hasContent || active);
  React.useEffect(() => {
    if (userToggledRef.current) return;
    if (active || hasContent) setOpen(true);
  }, [active, hasContent]);
  const onOpenChange = React.useCallback((next: boolean) => {
    userToggledRef.current = true;
    setOpen(next);
  }, []);
  return { open, onOpenChange };
}

// ---------------------------------------------------------------------------
// Progress card
// ---------------------------------------------------------------------------

/** One governed tool call, in the order the turn invoked it. */
export interface ProgressRow {
  toolCallId: string;
  capability: string;
  status: LiveToolCall["status"];
}

/**
 * Project the reducer's `order` + `toolCalls` into the rail's ordered rows.
 * Pure and exported so the projection is unit-testable without mounting the
 * rail: only `tool:*` entries produce a row, in first-appearance order, and an
 * order key whose tool call has already been evicted is skipped.
 */
export function progressRows(
  order: string[],
  toolCalls: Record<string, LiveToolCall>,
): ProgressRow[] {
  const rows: ProgressRow[] = [];
  for (const key of order) {
    if (!key.startsWith("tool:")) continue;
    const tc = toolCalls[key.slice("tool:".length)];
    if (!tc) continue;
    rows.push({
      toolCallId: tc.toolCallId,
      capability: tc.capability,
      status: tc.status,
    });
  }
  return rows;
}

const STATUS_DOT: Record<LiveToolCall["status"], string> = {
  pending: "bg-muted-foreground/50",
  running: "bg-info animate-pulse",
  completed: "bg-success",
  failed: "bg-destructive",
};

interface ProgressCardProps {
  order: string[];
  toolCalls: Record<string, LiveToolCall>;
  turnUsage: TurnUsage | undefined;
  isStreaming: boolean;
  /** chat_ux_v2 desktop rail: idle-collapse + auto-expand, no helper caption. */
  v2?: boolean;
}

function ProgressCard({
  order,
  toolCalls,
  turnUsage,
  isStreaming,
  v2 = false,
}: ProgressCardProps) {
  const rows = React.useMemo(
    () => progressRows(order, toolCalls),
    [order, toolCalls],
  );
  const hasContent = rows.length > 0;
  const { open, onOpenChange } = useV2CardOpenState(isStreaming, hasContent);
  const idle = v2 && !hasContent && !isStreaming;

  return (
    <RailCard
      icon={ListTodo}
      cardId="progress"
      title={idle ? "Progress · idle" : "Progress"}
      live={isStreaming}
      badge={hasContent ? rows.length : undefined}
      open={v2 ? open : undefined}
      onOpenChange={v2 ? onOpenChange : undefined}
    >
      {hasContent ? (
        <div className="flex flex-col gap-2">
          {isStreaming || turnUsage !== undefined ? (
            <div
              className="flex items-center gap-1.5 text-xs"
              data-testid="progress-status-line"
            >
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  isStreaming ? "bg-info animate-pulse" : "bg-success",
                )}
                aria-hidden="true"
              />
              <span className="font-medium text-foreground">
                {isStreaming ? "Working" : "Turn complete"}
              </span>
              <span className="text-muted-foreground">
                · {rows.length} tool{rows.length === 1 ? "" : "s"}
              </span>
            </div>
          ) : null}
          <ul className="flex flex-col gap-1" data-testid="progress-rows">
            {rows.map((row) => {
              const { label, Icon } = toolCallMeta(row.capability);
              return (
                <li
                  key={row.toolCallId}
                  className="flex items-center gap-2 text-xs"
                  data-testid="progress-row"
                >
                  <span
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      STATUS_DOT[row.status],
                    )}
                    aria-hidden="true"
                  />
                  <Icon
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span className="truncate text-foreground" title={label}>
                    {label}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <p
          className="py-2 text-center text-xs text-muted-foreground"
          data-testid="progress-empty"
        >
          No steps yet — send a message to start a turn.
        </p>
      )}
    </RailCard>
  );
}

// ---------------------------------------------------------------------------
// Files card
// ---------------------------------------------------------------------------

/**
 * Capabilities that produce or attach a file the Files card would show. There
 * is no cheap "how many files does this conversation have" count available
 * here (the actual list lives behind `WorkspaceContextTabs`'s own fetch,
 * mounted only once the card is open) — so the v2 idle/auto-expand decision is
 * driven by this turn's tool-call activity instead of a real count. Known
 * limitation: a conversation reloaded from history with PRE-EXISTING files but
 * no file tool calls THIS session starts collapsed at "Files · 0" until a new
 * one fires — accepted trade-off per the desktop-rail spec.
 */
const FILE_ACTIVITY_CAPABILITIES = new Set([
  "upload_asset",
  "add_conversation_attachment",
]);

export function hasFileToolActivity(
  toolCalls: Record<string, LiveToolCall>,
): boolean {
  return Object.values(toolCalls).some((tc) =>
    FILE_ACTIVITY_CAPABILITIES.has(tc.capability),
  );
}

interface FilesCardProps {
  conversationPublicId: string | null;
  toolCalls: Record<string, LiveToolCall>;
  /** chat_ux_v2 desktop rail: idle-collapse + auto-expand, no helper caption. */
  v2?: boolean;
}

function FilesCard({
  conversationPublicId,
  toolCalls,
  v2 = false,
}: FilesCardProps) {
  const hasFiles = React.useMemo(
    () => hasFileToolActivity(toolCalls),
    [toolCalls],
  );
  const { open, onOpenChange } = useV2CardOpenState(hasFiles, hasFiles);
  const idle = v2 && !hasFiles;

  return (
    <RailCard
      icon={FolderOpen}
      cardId="outputs"
      title={v2 ? (idle ? "Files · 0" : "Files") : "Files"}
      open={v2 ? open : undefined}
      onOpenChange={v2 ? onOpenChange : undefined}
    >
      {/* Definite height so the panel's inner `flex-1` body can scroll. */}
      <div className="flex h-56 flex-col">
        <WorkspaceContextTabs conversationPublicId={conversationPublicId} />
      </div>
    </RailCard>
  );
}

// ---------------------------------------------------------------------------
// Rail
// ---------------------------------------------------------------------------

export interface AgentActivityRailProps {
  // Progress
  order: string[];
  toolCalls: Record<string, LiveToolCall>;
  turnUsage: TurnUsage | undefined;
  isStreaming: boolean;
  // Files
  conversationPublicId: string | null;
  className?: string;
  /**
   * chat_ux_v2 desktop rail: renders `sessionPanelSlot` first and applies the
   * Progress/Files idle-collapse + auto-expand behavior.
   */
  v2?: boolean;
  /** v2 only: the SessionSettingsRail-wrapped panel rendered before Progress. */
  sessionPanelSlot?: React.ReactNode;
}

/**
 * The activity rail: Progress + Files, rendered both in the desktop `<aside>`
 * and, below `lg`, the mobile bottom sheet. Under chat_ux_v2 the writable
 * session panel is rendered above them via `sessionPanelSlot`.
 */
export function AgentActivityRail({
  order,
  toolCalls,
  turnUsage,
  isStreaming,
  conversationPublicId,
  className,
  v2 = false,
  sessionPanelSlot,
}: AgentActivityRailProps) {
  return (
    <div
      data-component="agent-activity-rail"
      className={cn("flex flex-col gap-3", className)}
    >
      {v2 ? sessionPanelSlot : null}
      <ProgressCard
        order={order}
        toolCalls={toolCalls}
        turnUsage={turnUsage}
        isStreaming={isStreaming}
        v2={v2}
      />
      <FilesCard
        conversationPublicId={conversationPublicId}
        toolCalls={toolCalls}
        v2={v2}
      />
    </div>
  );
}
