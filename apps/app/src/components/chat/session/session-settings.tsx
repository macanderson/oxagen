"use client";
/**
 * session-settings.tsx — the ONE SessionSettings component, rendered three
 * ways (`variant: "drawer" | "slide-over" | "rail"`) by `session-settings-host.tsx`.
 * Reads and writes ONLY through `useChatSession()` — there is no local copy of
 * agent/model/effort/budget/org/repo/branch/env/output state anywhere in this
 * file, so a settings-panel-vs-composer mismatch is structurally impossible
 * (see `session-state.ts`'s module doc).
 *
 * Picker chrome differs by variant, content does not: `variant="drawer"`
 * pushes a full-screen page (an internal stack of one, `pushed`) with ZERO
 * popovers; `variant="rail"`/`"slide-over"` open an anchored Popover per row.
 * Both render the exact same `SessionPickerList`/`ModelPickerRows` content
 * from `session-pickers.tsx`.
 *
 * Every write is instant — there is no save button anywhere in this surface.
 */
import * as React from "react";
import {
  ChevronLeft,
  ChevronRight,
  Lock,
  Sparkles,
  Building2,
  FolderGit2,
  GitBranch,
  Server,
  Wallet,
} from "lucide-react";
import { cn, formatCentsCompact } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/segmented-control";
import { Popover, PopoverTrigger, PopoverPopup } from "@/components/ui/popover";
import {
  getModel,
  TEXT_TIERS,
  type EffortLevel,
  type ResolvedTierCatalog,
} from "@oxagen/ai/catalog";
import { useChatSession } from "./session-store";
import {
  BUDGET_PRESETS_USD,
  BUDGET_MIN_USD,
  BUDGET_STEP_USD,
  sessionSelectionIssues,
} from "./session-state";
import {
  SessionPickerList,
  ModelPickerRows,
  type SessionPickerGroup,
  type SessionPickerRow,
} from "./session-pickers";
import { AgentAvatar } from "../agent-picker/agent-avatar";
import type { AgentOption } from "../agent-picker/agent-picker-types";
import type { RepoOption } from "../repo-selector";
import type { EnvironmentOption } from "../environment-selector";

export type SessionSettingsVariant = "drawer" | "slide-over" | "rail";

type PickerKind = "model" | "org" | "repo" | "branch" | "environment";

const PICKER_TITLES: Record<PickerKind, string> = {
  model: "Model",
  org: "Organization",
  repo: "Repository",
  branch: "Branch",
  environment: "Environment",
};

/** Sentinel row id for "use the repository's default branch" (branch: null). */
const DEFAULT_BRANCH_ROW_ID = "__repo_default__";

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Wallet balance label — abbreviates large totals ($12.3K) so the drawer
 *  footer row stays readable; small balances keep full cent precision. */
function formatUsd(n: number): string {
  return formatCentsCompact(Math.round(n * 100));
}

/** Chip label: "$0.50", "$1", "$2", "$5" — whole dollars drop the cents. */
function formatBudgetChip(n: number): string {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

function isPresetBudget(v: number): boolean {
  return (BUDGET_PRESETS_USD as readonly number[]).includes(v);
}

// ---------------------------------------------------------------------------
// Code-section picker group builders (pure — no hooks)
// ---------------------------------------------------------------------------

function buildOrgGroup(repos: RepoOption[]): SessionPickerGroup {
  const owners = Array.from(new Set(repos.map((r) => r.owner))).sort((a, b) =>
    a.localeCompare(b),
  );
  return { id: "orgs", rows: owners.map((o) => ({ id: o, label: o })) };
}

function buildRepoGroup(
  repos: RepoOption[],
  org: string | null,
): SessionPickerGroup {
  const filtered = org ? repos.filter((r) => r.owner === org) : repos;
  return {
    id: "repos",
    rows: filtered.map((r) => ({
      id: r.key,
      label: r.name,
      sublabel: r.owner,
    })),
  };
}

function buildEnvironmentGroup(
  environments: EnvironmentOption[],
): SessionPickerGroup {
  return {
    id: "environments",
    rows: environments.map((e) => ({
      id: e.id,
      label: e.name,
      badge: e.isDefault ? (
        <Badge variant="outline" size="sm">
          Default
        </Badge>
      ) : undefined,
    })),
  };
}

function buildBranchGroup(
  branches: string[] | null,
  defaultBranch: string | null,
): SessionPickerGroup {
  const rows: SessionPickerRow[] = [
    {
      id: DEFAULT_BRANCH_ROW_ID,
      label: defaultBranch
        ? `Repository default (${defaultBranch})`
        : "Repository default",
    },
  ];
  for (const name of branches ?? []) {
    rows.push({
      id: name,
      label: name,
      badge:
        name === defaultBranch ? (
          <Badge variant="outline" size="sm">
            Default
          </Badge>
        ) : undefined,
    });
  }
  return { id: "branches", rows };
}

// ---------------------------------------------------------------------------
// Agent row — avatar + name; locked state shows the inline explanation
// ---------------------------------------------------------------------------

function AgentRow({
  agent,
  locked,
  onOpen,
  onStartNewChat,
}: {
  agent: AgentOption | null;
  locked: boolean;
  onOpen?: () => void;
  onStartNewChat?: () => void;
}) {
  const name = agent?.name ?? "Default assistant";
  const avatar = (
    <AgentAvatar
      avatarUrl={agent?.avatarUrl ?? null}
      name={name}
      slug={agent?.slug ?? "default"}
      size="sm"
    />
  );

  if (locked) {
    return (
      <div className="flex flex-col gap-1 rounded-md px-2 py-1.5">
        <div className="flex items-center gap-2">
          {avatar}
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {name}
          </span>
          <Lock
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        </div>
        <p className="pl-8 text-xs text-muted-foreground">
          Locked after the first message
        </p>
        {onStartNewChat ? (
          <button
            type="button"
            onClick={onStartNewChat}
            className="ml-8 self-start text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Start a new chat with a different agent
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Agent: ${name}`}
      className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {avatar}
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
        {name}
      </span>
      <ChevronRight
        className="size-4 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Budget preset chip
// ---------------------------------------------------------------------------

function BudgetChip({
  label,
  pressed,
  onClick,
}: {
  label: string;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "min-h-11 rounded-full border px-3 text-xs font-medium transition-colors sm:min-h-8",
        pressed
          ? "border-primary bg-primary/10 text-primary"
          : "border-border bg-background text-foreground hover:bg-accent/60",
      )}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// A settings row that opens a picker: full-screen push on mobile, an
// anchored Popover on rail/slide-over. ZERO popovers render on `"drawer"`.
// ---------------------------------------------------------------------------

interface PickerFieldRowProps {
  variant: SessionSettingsVariant;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: React.ReactNode;
  sublabel?: string | null;
  warning?: string | null;
  locked?: boolean;
  ariaLabel: string;
  /** Side effect on open (both the drawer push and the popover open) — e.g. loading branches. */
  onOpen?: () => void;
  /** Drawer only: pushes the full-screen picker page. */
  onPush?: () => void;
  /** Rail/slide-over only: the Popover's content. */
  popoverContent?: React.ReactNode;
}

function PickerFieldRow({
  variant,
  icon: Icon,
  label,
  value,
  sublabel,
  warning,
  locked = false,
  ariaLabel,
  onOpen,
  onPush,
  popoverContent,
}: PickerFieldRowProps) {
  const content = (
    <>
      <Icon
        className="size-4 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1">
        <span className="block text-xs text-muted-foreground">{label}</span>
        <span className="block truncate text-sm font-medium text-foreground">
          {value}
        </span>
        {sublabel ? (
          <span className="block truncate text-xs text-muted-foreground">
            {sublabel}
          </span>
        ) : null}
        {warning ? (
          <span className="block text-xs text-destructive">{warning}</span>
        ) : null}
      </span>
      {locked ? (
        <Lock
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-label="Locked to this conversation"
        />
      ) : (
        <ChevronRight
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
      )}
    </>
  );

  if (locked) {
    return (
      <div
        className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-1.5"
        data-locked="true"
      >
        {content}
      </div>
    );
  }

  const rowClass =
    "flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  if (variant === "drawer") {
    return (
      <button
        type="button"
        onClick={() => {
          onOpen?.();
          onPush?.();
        }}
        aria-label={ariaLabel}
        className={rowClass}
      >
        {content}
      </button>
    );
  }

  return (
    <Popover onOpenChange={(open) => (open ? onOpen?.() : undefined)}>
      <PopoverTrigger
        render={
          <button type="button" aria-label={ariaLabel} className={rowClass} />
        }
      >
        {content}
      </PopoverTrigger>
      <PopoverPopup align="start" className="max-h-96 w-80 overflow-y-auto p-2">
        {popoverContent}
      </PopoverPopup>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// SessionSettings
// ---------------------------------------------------------------------------

export interface SessionSettingsProps {
  variant: SessionSettingsVariant;
  agents: AgentOption[];
  repos: RepoOption[];
  environments: EnvironmentOption[];
  modelConfig: ResolvedTierCatalog;
  branches: string[] | null;
  branchesLoading: boolean;
  onLoadBranches: () => void;
  defaultBranch: string | null;
  walletBalanceUsd: number | null;
  onOpenAgentPicker?: () => void;
  onStartNewChat?: () => void;
  onOpenWallet?: () => void;
}

export function SessionSettings({
  variant,
  agents,
  repos,
  environments,
  modelConfig,
  branches,
  branchesLoading,
  onLoadBranches,
  defaultBranch,
  walletBalanceUsd,
  onOpenAgentPicker,
  onStartNewChat,
  onOpenWallet,
}: SessionSettingsProps) {
  const { state, locks, updateSession, resetToDefaults } = useChatSession();
  const [pushed, setPushed] = React.useState<PickerKind | null>(null);
  const [customBudgetOpen, setCustomBudgetOpen] = React.useState(false);

  const currentAgent = agents.find((a) => a.agentId === state.agentId) ?? null;
  const currentRepo = state.repoKey
    ? (repos.find((r) => r.key === state.repoKey) ?? null)
    : null;
  const currentEnv = state.envId
    ? (environments.find((e) => e.id === state.envId) ?? null)
    : null;
  const effectiveDefaultBranch =
    defaultBranch ?? currentRepo?.defaultBranch ?? null;

  const issues = React.useMemo(
    () => sessionSelectionIssues(state, { repos, environments, branches }),
    [state, repos, environments, branches],
  );
  const issueFor = (field: "repo" | "branch" | "environment") =>
    issues.find((i) => i.field === field)?.message ?? null;

  const modelLabel = state.model
    ? (getModel(state.model)?.name ?? state.model)
    : (TEXT_TIERS.find((t) => t.id === (state.tier ?? "fast"))?.name ??
      "Oxagen Fast");

  // This UI only exposes low/medium/high. An xhigh/max value (still valid in
  // ChatSessionState) displays as "high" without being written back until the
  // user picks a segment explicitly.
  const effortDisplay: "low" | "medium" | "high" =
    state.effort === "low"
      ? "low"
      : state.effort === "medium"
        ? "medium"
        : "high";

  const showCustomBudget =
    customBudgetOpen ||
    (state.budgetUsd !== null && !isPresetBudget(state.budgetUsd));

  /** Shared list content for a picker kind. `onSelected` fires after a pick
   * (used to pop the drawer's pushed page back to the main list); the
   * popover variant omits it so a pick doesn't force-close the popup. */
  function pickerContentFor(
    kind: PickerKind,
    onSelected?: () => void,
  ): React.ReactNode {
    switch (kind) {
      case "model":
        return (
          <ModelPickerRows
            modelConfig={modelConfig}
            tier={state.tier}
            model={state.model}
            onSelectTier={(tier) => {
              updateSession({ tier });
              onSelected?.();
            }}
            onSelectModel={(id) => {
              updateSession({ model: id });
              onSelected?.();
            }}
          />
        );
      case "org":
        return (
          <SessionPickerList
            groups={[buildOrgGroup(repos)]}
            selectedId={state.org}
            onSelect={(id) => {
              updateSession({ org: id });
              onSelected?.();
            }}
            searchPlaceholder="Search organizations"
            emptyMessage="No organizations available"
          />
        );
      case "repo":
        return (
          <SessionPickerList
            groups={[buildRepoGroup(repos, state.org)]}
            selectedId={state.repoKey}
            onSelect={(id) => {
              updateSession({ repoKey: id });
              onSelected?.();
            }}
            searchPlaceholder="Search repositories"
            emptyMessage="No repositories available"
          />
        );
      case "branch":
        return branchesLoading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Spinner size="sm" label="Loading branches" />
            Loading branches…
          </div>
        ) : (
          <SessionPickerList
            groups={[buildBranchGroup(branches, effectiveDefaultBranch)]}
            selectedId={state.branch ?? DEFAULT_BRANCH_ROW_ID}
            onSelect={(id) => {
              updateSession({
                branch: id === DEFAULT_BRANCH_ROW_ID ? null : id,
              });
              onSelected?.();
            }}
            searchPlaceholder="Search branches"
            emptyMessage="No branches found"
          />
        );
      case "environment":
        return (
          <SessionPickerList
            groups={[buildEnvironmentGroup(environments)]}
            selectedId={state.envId}
            onSelect={(id) => {
              updateSession({ envId: id });
              onSelected?.();
            }}
            searchPlaceholder="Search environments"
            emptyMessage="No environments available"
          />
        );
    }
  }

  // ── Mobile full-screen pushed picker page (replaces the whole surface) ──
  if (pushed && variant === "drawer") {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-1 border-b border-border px-1 pb-2">
          <button
            type="button"
            aria-label="Back"
            onClick={() => setPushed(null)}
            className="flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronLeft className="size-5" aria-hidden="true" />
          </button>
          <h3 className="text-sm font-semibold text-foreground">
            {PICKER_TITLES[pushed]}
          </h3>
        </div>
        <div className="flex-1 overflow-y-auto pt-2">
          {pickerContentFor(pushed, () => setPushed(null))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Session */}
      <section className="flex flex-col gap-1">
        <h3 className="px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Session
        </h3>
        <AgentRow
          agent={currentAgent}
          locked={locks.agent}
          onOpen={onOpenAgentPicker}
          onStartNewChat={onStartNewChat}
        />
        <PickerFieldRow
          variant={variant}
          icon={Sparkles}
          label="Model"
          value={modelLabel}
          ariaLabel={`Model: ${modelLabel}`}
          onPush={() => setPushed("model")}
          popoverContent={pickerContentFor("model")}
        />
        <div className="flex flex-col gap-1.5 px-2 py-1.5">
          <span className="text-xs text-muted-foreground">
            Reasoning effort
          </span>
          <SegmentedControl
            className="h-11 sm:h-8"
            value={effortDisplay}
            onValueChange={(v) => updateSession({ effort: v as EffortLevel })}
          >
            <SegmentedControlItem value="low">Low</SegmentedControlItem>
            <SegmentedControlItem value="medium">Medium</SegmentedControlItem>
            <SegmentedControlItem value="high">High</SegmentedControlItem>
          </SegmentedControl>
        </div>
        <div className="flex flex-col gap-1.5 px-2 py-1.5">
          <span className="text-xs text-muted-foreground">Per-turn budget</span>
          <div
            className="flex flex-wrap gap-1.5"
            role="group"
            aria-label="Per-turn budget"
          >
            <BudgetChip
              label="No cap"
              pressed={state.budgetUsd === null}
              onClick={() => {
                setCustomBudgetOpen(false);
                updateSession({ budgetUsd: null });
              }}
            />
            {BUDGET_PRESETS_USD.map((amount) => (
              <BudgetChip
                key={amount}
                label={formatBudgetChip(amount)}
                pressed={state.budgetUsd === amount}
                onClick={() => {
                  setCustomBudgetOpen(false);
                  updateSession({ budgetUsd: amount });
                }}
              />
            ))}
            <BudgetChip
              label="Custom"
              pressed={showCustomBudget}
              onClick={() => {
                setCustomBudgetOpen(true);
                if (
                  state.budgetUsd === null ||
                  isPresetBudget(state.budgetUsd)
                ) {
                  updateSession({
                    budgetUsd: Math.max(BUDGET_MIN_USD, state.budgetUsd ?? 3),
                  });
                }
              }}
            />
          </div>
          {showCustomBudget ? (
            <Input
              type="number"
              min={BUDGET_MIN_USD}
              step={BUDGET_STEP_USD}
              value={state.budgetUsd ?? BUDGET_MIN_USD}
              onChange={(e) => {
                const v = Number.parseFloat(e.target.value);
                if (Number.isNaN(v)) return;
                updateSession({ budgetUsd: Math.max(BUDGET_MIN_USD, v) });
              }}
              aria-label="Custom per-turn budget in dollars"
              className="w-28"
            />
          ) : null}
          <p className="text-xs text-muted-foreground">
            Pauses and asks before a reply exceeds the cap.
          </p>
        </div>
      </section>

      {/* Code */}
      <section className="flex flex-col gap-1">
        <h3 className="px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Code
        </h3>
        <PickerFieldRow
          variant={variant}
          icon={Building2}
          label="Organization"
          value={state.org ?? "Not set"}
          locked={locks.code}
          ariaLabel={`Organization: ${state.org ?? "not set"}`}
          onPush={() => setPushed("org")}
          popoverContent={pickerContentFor("org")}
        />
        <PickerFieldRow
          variant={variant}
          icon={FolderGit2}
          label="Repository"
          value={currentRepo ? currentRepo.name : "Not set"}
          sublabel={currentRepo ? currentRepo.owner : null}
          warning={issueFor("repo")}
          locked={locks.code}
          ariaLabel={`Repository: ${currentRepo ? `${currentRepo.owner}/${currentRepo.name}` : "not set"}`}
          onPush={() => setPushed("repo")}
          popoverContent={pickerContentFor("repo")}
        />
        <PickerFieldRow
          variant={variant}
          icon={GitBranch}
          label="Branch"
          value={
            state.branch ??
            (effectiveDefaultBranch
              ? `Default (${effectiveDefaultBranch})`
              : "Repository default")
          }
          warning={issueFor("branch")}
          ariaLabel={`Branch: ${state.branch ?? "repository default"}`}
          onOpen={onLoadBranches}
          onPush={() => setPushed("branch")}
          popoverContent={pickerContentFor("branch")}
        />
        <PickerFieldRow
          variant={variant}
          icon={Server}
          label="Environment"
          value={currentEnv ? currentEnv.name : "Not set"}
          warning={issueFor("environment")}
          locked={locks.code}
          ariaLabel={`Environment: ${currentEnv?.name ?? "not set"}`}
          onPush={() => setPushed("environment")}
          popoverContent={pickerContentFor("environment")}
        />
      </section>

      {/* No "Output" section: image/video generation is inferred from the
          prompt server-side (see infer-media-intent.ts) — there is no manual
          "Generate image / video" toggle. Just ask ("make me a logo", "create
          a short video of …") and the turn routes to media generation. */}

      {/* Footer */}
      <div className="flex flex-col gap-2 border-t border-border pt-3">
        {variant === "drawer" && walletBalanceUsd !== null ? (
          <button
            type="button"
            onClick={onOpenWallet}
            aria-label="Add funds"
            className={cn(
              "flex min-h-11 w-full items-center justify-between rounded-md px-2 text-sm",
              walletBalanceUsd < 5 ? "text-warning" : "text-foreground",
            )}
          >
            <span className="flex items-center gap-2">
              <Wallet className="size-4 shrink-0" aria-hidden="true" />
              Wallet balance
            </span>
            <span className="flex items-center gap-1 font-medium">
              {formatUsd(walletBalanceUsd)}
              <ChevronRight className="size-4" aria-hidden="true" />
            </span>
          </button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          onClick={resetToDefaults}
          className="self-start"
        >
          Reset to defaults
        </Button>
      </div>
    </div>
  );
}
