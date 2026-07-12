"use client";

/**
 * AgentActivityRail — the calm, always-present right rail for a chat surface,
 * inspired by Claude's Progress / Outputs / Context cards. It replaces the old
 * dense stack (a bare `CodingTracePanel` trace-index + a tabbed
 * `WorkspaceContextPanel`) with three titled cards, each with a one-line
 * descriptor, a collapse control, and a graceful ambient state so the rail is
 * reassuring even before the first turn:
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
  title: string;
  /** One-line descriptor rendered muted at the foot of the card body. */
  helper: string;
  /** Small count/state pill shown right-aligned in the header. */
  badge?: React.ReactNode;
  /** Pulsing dot in the header while the turn is streaming. */
  live?: boolean;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

/**
 * One titled, collapsible rail card: header (icon · title · live dot · badge ·
 * chevron) over a bordered body that ends with the muted `helper` descriptor,
 * mirroring the reference rail's calm "title + subtext" rhythm.
 */
function RailCard({
  icon: Icon,
  title,
  helper,
  badge,
  live = false,
  defaultOpen = true,
  children,
}: RailCardProps) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <section
      data-component="rail-card"
      data-card={title.toLowerCase()}
      className="overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-sm"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
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
          <p className="mt-2.5 text-[11px] leading-relaxed text-muted-foreground">
            {helper}
          </p>
        </div>
      ) : null}
    </section>
  );
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
}

function ProgressCard({
  order,
  plans,
  toolCalls,
  activeFanouts,
  turnUsage,
  isStreaming,
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

  return (
    <RailCard
      icon={ListTodo}
      title="Progress"
      helper="Steps appear here as the agent works through a longer task."
      live={isStreaming}
      badge={hasContent ? totalRows : undefined}
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
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
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
    return { owner: binding.owner, name: binding.name, branch: binding.defaultBranch };
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
  const selection = useChatSelectionContext();
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
    <RailCard
      icon={FolderGit2}
      title="Context"
      helper="The repository, branch, and checks this task is grounded in."
    >
      {repo ? (
        <div className="flex flex-col gap-2 text-xs" data-testid="context-grounded">
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
              <span className="tabular-nums">
                {toolCount} used this turn
              </span>
            </ContextRow>
          ) : null}
        </div>
      ) : (
        <div
          className="flex flex-col items-center gap-1.5 py-3 text-center"
          data-testid="context-empty"
        >
          <FolderGit2 className="size-5 text-muted-foreground/70" aria-hidden="true" />
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
}

function OutputsCard({
  conversationPublicId,
  orgSlug,
  workspaceSlug,
  toolCalls,
}: OutputsCardProps) {
  return (
    <RailCard
      icon={FolderOpen}
      title="Outputs"
      helper="Files the assistant generates or edits in this conversation show up here."
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
}

/**
 * The three-card activity rail. Rendered inside `ChatSelectionProvider` (so the
 * Context card can read the live repo/env selection) — both in the desktop
 * `<aside>` and, below `lg`, the mobile bottom sheet.
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
}: AgentActivityRailProps) {
  return (
    <div
      data-component="agent-activity-rail"
      className={cn("flex flex-col gap-3", className)}
    >
      <ProgressCard
        order={order}
        plans={plans}
        toolCalls={toolCalls}
        activeFanouts={activeFanouts}
        turnUsage={turnUsage}
        isStreaming={isStreaming}
      />
      <ContextCard
        codeSessionPr={codeSessionPr}
        availableRepos={availableRepos}
        availableEnvironments={availableEnvironments}
        conversationCodeBinding={conversationCodeBinding}
        toolCalls={toolCalls}
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
      />
      <OutputsCard
        conversationPublicId={conversationPublicId}
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        toolCalls={toolCalls}
      />
    </div>
  );
}
