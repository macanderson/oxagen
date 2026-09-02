"use client";

/**
 * AgentActivityRail — the calm, always-present right rail for a chat surface.
 * Three titled cards, each with a collapse control and a graceful ambient
 * state, so the rail is reassuring even before the first turn:
 *
 *   • Progress — the live turn as ordered stages (reuses `CodingTraceStages`),
 *     with a compact "Working · N tools" / "Turn complete" status line above.
 *   • Context — the code grounding lifted OUT of the composer footer into a
 *     persistent card: repository, branch, environment, the open PR + live CI
 *     (reuses `ComposerPrStatusChip`), and the tools this turn touched. Reads
 *     the durable `conversationCodeBinding` AND the live picker selection
 *     (`useChatSelectionContext`), so it's populated even before a turn runs.
 *   • Outputs — files the assistant generated or edited (reuses
 *     `WorkspaceContextTabs`: conversation assets + the sandbox working tree).
 *
 * Pure client composition over existing state and components — no new stream
 * events, no engine changes, no new fetches beyond the CI poll the PR chip
 * already owns.
 */

import * as React from "react";
import {
  ChevronDown,
  ListTodo,
  FolderGit2,
  GitBranch,
  GitPullRequest,
  Server,
  Wrench,
  FolderOpen,
  Lock,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  CodingTraceStages,
  groupCodingTraceStages,
  type CodingTraceStage,
} from "./coding-trace-panel";
import { WorkspaceContextTabs } from "./workspace-context-panel";
import {
  ComposerPrStatusChip,
  type ComposerPrStatus,
} from "./composer-pr-status-chip";
import { useChatSelectionContext } from "./agent-picker/chat-selection-context";
import { useSessionSelectionBridge } from "./session/session-bridges";
import type { LiveFanout, LivePlan, LiveToolCall } from "./use-tool-stream";
import type { TurnUsage } from "./stream-event-types";
import type { RepoOption } from "./repo-selector";
import type { EnvironmentOption } from "./environment-selector";
import type { StoredCodeBinding } from "@/app/api/v1/chat/stream/code-binding";

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

const STAGE_KEYS: CodingTraceStage[] = [
  "plan",
  "tool",
  "code",
  "subagent",
  "result",
];

interface ProgressCardProps {
  order: string[];
  plans: Record<string, LivePlan>;
  toolCalls: Record<string, LiveToolCall>;
  activeFanouts: Record<string, LiveFanout>;
  turnUsage: TurnUsage | undefined;
  isStreaming: boolean;
  /** chat_ux_v2 desktop rail: idle-collapse + auto-expand, no helper caption. */
  v2?: boolean;
}

function ProgressCard({
  order,
  plans,
  toolCalls,
  activeFanouts,
  turnUsage,
  isStreaming,
  v2 = false,
}: ProgressCardProps) {
  const groups = React.useMemo(
    () =>
      groupCodingTraceStages({
        order,
        plans,
        toolCalls,
        activeFanouts,
        turnUsage,
        isStreaming,
      }),
    [order, plans, toolCalls, activeFanouts, turnUsage, isStreaming],
  );
  const totalRows = STAGE_KEYS.reduce((sum, s) => sum + groups[s].length, 0);
  const toolCount = groups.tool.length + groups.code.length;
  const hasContent = totalRows > 0;
  const { open, onOpenChange } = useV2CardOpenState(isStreaming, hasContent);
  const idle = v2 && !hasContent && !isStreaming;

  return (
    <RailCard
      icon={ListTodo}
      cardId="progress"
      title={idle ? "Progress · idle" : "Progress"}
      live={isStreaming}
      badge={hasContent ? totalRows : undefined}
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
              {toolCount > 0 ? (
                <span className="text-muted-foreground">
                  · {toolCount} tool{toolCount === 1 ? "" : "s"}
                </span>
              ) : null}
            </div>
          ) : null}
          <CodingTraceStages groups={groups} />
        </div>
      ) : (
        <p
          className="py-2 text-center text-xs text-muted-foreground"
          data-testid="progress-empty"
        >
          No steps yet — send a message to start a task.
        </p>
      )}
    </RailCard>
  );
}

// ---------------------------------------------------------------------------
// Context card
// ---------------------------------------------------------------------------

/** A single label → value row in the Context card. */
function ContextRow({
  icon: Icon,
  label,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon
        className="size-3.5 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <span className="w-16 shrink-0 text-muted-foreground">{label}</span>
      <span className="flex min-w-0 flex-1 items-center gap-1 text-foreground">
        {children}
      </span>
    </div>
  );
}

interface ContextCardProps {
  codeSessionPr: ComposerPrStatus | null;
  availableRepos?: RepoOption[];
  availableEnvironments?: EnvironmentOption[];
  conversationCodeBinding?: StoredCodeBinding | null;
  toolCalls: Record<string, LiveToolCall>;
  orgSlug: string;
  workspaceSlug: string;
}

/**
 * Resolve the repo the conversation is coding against: the durable binding
 * takes precedence (it survives every turn), else the live picker selection
 * resolved against `availableRepos`. Returns null when nothing is chosen yet.
 */
export function resolveContextRepo({
  binding,
  selectedRepoKey,
  availableRepos,
}: {
  binding: StoredCodeBinding | null;
  selectedRepoKey: string | null;
  availableRepos: RepoOption[];
}): { owner: string; name: string; branch: string | null } | null {
  if (binding) {
    return {
      owner: binding.owner,
      name: binding.name,
      branch: binding.defaultBranch,
    };
  }
  if (!selectedRepoKey) return null;
  const repo = availableRepos.find((r) => r.key === selectedRepoKey);
  return repo
    ? { owner: repo.owner, name: repo.name, branch: repo.defaultBranch }
    : null;
}

function ContextCard({
  codeSessionPr,
  availableRepos,
  availableEnvironments,
  conversationCodeBinding,
  toolCalls,
  orgSlug,
  workspaceSlug,
}: ContextCardProps) {
  // chat_ux_v2: the unified session store (when mounted) is the source of
  // truth — the legacy selection provider is only read when no session store
  // wraps the tree, so this card can never disagree with the composer.
  const sessionSelection = useSessionSelectionBridge();
  const legacySelection = useChatSelectionContext();
  const selection = sessionSelection ?? legacySelection;
  const binding = conversationCodeBinding ?? null;

  const repo = React.useMemo(
    () =>
      resolveContextRepo({
        binding,
        selectedRepoKey: selection?.selectedRepoKey ?? null,
        availableRepos: availableRepos ?? [],
      }),
    [binding, selection?.selectedRepoKey, availableRepos],
  );

  // The PR head branch (when a PR exists this turn) is the most specific; else
  // the repo's default branch.
  const branch = codeSessionPr?.headRef ?? repo?.branch ?? null;

  const envName = React.useMemo(() => {
    if (binding?.environmentName) return binding.environmentName;
    const id = binding?.environmentId ?? selection?.selectedEnvId ?? null;
    if (!id) return null;
    return (availableEnvironments ?? []).find((e) => e.id === id)?.name ?? null;
  }, [binding, selection?.selectedEnvId, availableEnvironments]);

  const locked = binding !== null || (selection?.selectionLocked ?? false);

  // Distinct capabilities the agent invoked this turn — the "tools used" tally.
  const toolCount = React.useMemo(
    () => new Set(Object.values(toolCalls).map((tc) => tc.capability)).size,
    [toolCalls],
  );

  return (
    <RailCard icon={FolderGit2} cardId="context" title="Context">
      {repo ? (
        <div
          className="flex flex-col gap-2 text-xs"
          data-testid="context-grounded"
        >
          <ContextRow icon={FolderGit2} label="Repo">
            <span className="truncate font-medium">
              {repo.owner}/{repo.name}
            </span>
            {locked ? (
              <Lock
                className="size-3 shrink-0 text-muted-foreground"
                aria-label="Locked to this conversation"
              />
            ) : null}
          </ContextRow>
          {branch ? (
            <ContextRow icon={GitBranch} label="Branch">
              <span className="truncate font-mono text-[11px]">{branch}</span>
            </ContextRow>
          ) : null}
          {envName ? (
            <ContextRow icon={Server} label="Env">
              <span className="truncate">{envName}</span>
            </ContextRow>
          ) : null}
          {codeSessionPr ? (
            <ContextRow icon={GitPullRequest} label="PR">
              <ComposerPrStatusChip
                pr={codeSessionPr}
                orgSlug={orgSlug}
                workspaceSlug={workspaceSlug}
              />
            </ContextRow>
          ) : null}
          {toolCount > 0 ? (
            <ContextRow icon={Wrench} label="Tools">
              <span className="tabular-nums">{toolCount} used this turn</span>
            </ContextRow>
          ) : null}
        </div>
      ) : (
        <div
          className="flex flex-col items-center gap-1.5 py-3 text-center"
          data-testid="context-empty"
        >
          <FolderGit2
            className="size-5 text-muted-foreground/70"
            aria-hidden="true"
          />
          <p className="text-xs font-medium text-foreground">
            Not connected to a repository
          </p>
          <p className="text-[11px] text-muted-foreground">
            Pick a code agent to work against a repo, branch, and environment.
          </p>
        </div>
      )}
    </RailCard>
  );
}

// ---------------------------------------------------------------------------
// Outputs card
// ---------------------------------------------------------------------------

interface OutputsCardProps {
  conversationPublicId: string | null;
  orgSlug: string;
  workspaceSlug: string;
  toolCalls: Record<string, LiveToolCall>;
  /** chat_ux_v2 desktop rail: retitles "Outputs" → "Files", idle-collapse +
   * auto-expand, no helper caption. */
  v2?: boolean;
}

/**
 * Capabilities that produce or edit a file the Files card would show. There is
 * no cheap "how many files does this conversation have" count available here
 * (the actual list lives behind `WorkspaceContextTabs`'s own fetch, mounted
 * only once the card is open) — so the v2 idle/auto-expand decision is driven
 * by this turn's tool-call activity instead of a real count. Known limitation:
 * a conversation reloaded from history with PRE-EXISTING files but no file
 * tool calls THIS session starts collapsed at "Files · 0" until a new one
 * fires — accepted trade-off per the desktop-rail spec.
 */
const FILE_ACTIVITY_CAPABILITIES = new Set([
  "generate_image",
  "create_image",
  "generate_svg",
  "generate_mermaid",
  "generate_video",
  "generate_markdown",
  "generate_document",
  "create_document",
  "create_pdf",
  "edit_repo_file",
  "put_repo_file",
  "upload_asset",
  "add_conversation_attachment",
  "start_sandbox",
]);

function hasFileToolActivity(toolCalls: Record<string, LiveToolCall>): boolean {
  return Object.values(toolCalls).some((tc) =>
    FILE_ACTIVITY_CAPABILITIES.has(tc.capability),
  );
}

function OutputsCard({
  conversationPublicId,
  orgSlug,
  workspaceSlug,
  toolCalls,
  v2 = false,
}: OutputsCardProps) {
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
      title={v2 ? (idle ? "Files · 0" : "Files") : "Outputs"}
      open={v2 ? open : undefined}
      onOpenChange={v2 ? onOpenChange : undefined}
    >
      {/* Definite height so the tabs' inner `flex-1` panels can scroll. */}
      <div className="flex h-56 flex-col">
        <WorkspaceContextTabs
          conversationPublicId={conversationPublicId}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          toolCalls={toolCalls}
        />
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
  plans: Record<string, LivePlan>;
  toolCalls: Record<string, LiveToolCall>;
  activeFanouts: Record<string, LiveFanout>;
  turnUsage: TurnUsage | undefined;
  isStreaming: boolean;
  // Outputs + Context
  conversationPublicId: string | null;
  orgSlug: string;
  workspaceSlug: string;
  // Context (code grounding)
  codeSessionPr: ComposerPrStatus | null;
  availableRepos?: RepoOption[];
  availableEnvironments?: EnvironmentOption[];
  conversationCodeBinding?: StoredCodeBinding | null;
  className?: string;
  /**
   * chat_ux_v2 desktop rail: renders `sessionPanelSlot` first IN PLACE of the
   * read-only Context card (which never renders in v2 — the session panel is
   * the writable replacement), and applies the Progress/Files idle-collapse +
   * auto-expand behavior. Defaults to the legacy three-card rail.
   */
  v2?: boolean;
  /** v2 only: the SessionSettingsRail-wrapped panel rendered before Progress. */
  sessionPanelSlot?: React.ReactNode;
}

/**
 * The activity rail. Legacy: three cards (Progress / Context / Outputs),
 * rendered inside `ChatSelectionProvider` so Context can read the live
 * repo/env selection — both in the desktop `<aside>` and, below `lg`, the
 * mobile bottom sheet. chat_ux_v2 desktop (`v2`): `sessionPanelSlot` / Progress
 * / Files — Context is dropped (the session panel already shows repo/branch/
 * env, writably) and Progress/Files idle-collapse with auto-expand.
 */
export function AgentActivityRail({
  order,
  plans,
  toolCalls,
  activeFanouts,
  turnUsage,
  isStreaming,
  conversationPublicId,
  orgSlug,
  workspaceSlug,
  codeSessionPr,
  availableRepos,
  availableEnvironments,
  conversationCodeBinding,
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
        plans={plans}
        toolCalls={toolCalls}
        activeFanouts={activeFanouts}
        turnUsage={turnUsage}
        isStreaming={isStreaming}
        v2={v2}
      />
      {!v2 ? (
        <ContextCard
          codeSessionPr={codeSessionPr}
          availableRepos={availableRepos}
          availableEnvironments={availableEnvironments}
          conversationCodeBinding={conversationCodeBinding}
          toolCalls={toolCalls}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
        />
      ) : null}
      <OutputsCard
        conversationPublicId={conversationPublicId}
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        toolCalls={toolCalls}
        v2={v2}
      />
    </div>
  );
}
