"use client";
import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowLeft,
  Bot,
  Check,
  Code2,
  GitBranch,
  MessageSquare,
  Shield,
  Star,
} from "lucide-react";
import { fadeInUp, staggerContainer, transition } from "@oxagen/ui/lib/motion";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import {
  Select,
  SelectPopup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AgentAvatar } from "./agent-avatar";
import { AgentInfoButton } from "./agent-info-button";
import { FOCUS_COMPOSER_EVENT } from "./focus-composer-event";
import { pushRecentAgentId, readRecentAgentIds } from "../session/recent-agents";
import { useChatSessionContext } from "../session/session-store";
import { useRepoBranches } from "../session/use-session-settings-data";
import { RepoSelector, type RepoOption } from "../repo-selector";
import {
  EnvironmentSelector,
  type EnvironmentOption,
} from "../environment-selector";
import { CapabilityStrip } from "./capability-strip";
import type { AgentOption } from "./agent-picker-types";
import type { AgentSelectionApply } from "./chat-selection-context";

/**
 * agent-picker-panel.tsx — the shared agent-selection surface, presented either
 * as a composer popover (`variant="popover"`) or as an empty-state gallery hero
 * (`variant="gallery"`). Lists the workspace's agents with avatar, type, a
 * one-line description, and a capability strip; a star per row sets the user's
 * default. Choosing a code agent slides in an inline setup step that picks the
 * agent's whole target up front — repository → branch → environment — so the
 * conversation starts fully bound; choosing a chat agent (or the Default
 * assistant) applies immediately.
 *
 * The branch row needs `orgSlug` + `workspaceSlug` to fetch a branch list (see
 * `useRepoBranches`); without them the setup step degrades to repo +
 * environment rather than showing a picker it can't populate. Branch is always
 * OPTIONAL: null means "the repository's default branch", the convention the
 * whole session model uses.
 *
 * chat_ux_v2 (`useChatSessionContext() !== null`) changes three things, all
 * gated on the same `v2` boolean: (1) a "Recent" row of up to 5 avatars for
 * quick re-pick, persisted per workspace (`session/recent-agents.ts`); (2)
 * EVERY pick — a Recent avatar or a list row, code agent or chat agent —
 * applies immediately (no repo/env setup step: a code agent's session is
 * prefilled from its remembered code context, see `session-store.tsx`'s
 * agent-switch overlay) and focuses the composer (`FOCUS_COMPOSER_EVENT`);
 * (3) each row gets an "About {name}" info affordance. Flag off keeps every
 * existing behavior byte-identical.
 */

export interface AgentPickerPanelProps {
  agents: AgentOption[];
  repos: RepoOption[];
  environments: EnvironmentOption[];
  /** Prefill for a code agent's repo session (a `RepoOption.key`). */
  defaultRepoKey: string | null;
  /** Prefill for a code agent's environment session. */
  defaultEnvId: string | null;
  /** The workspace user's current default agent (agt_… public id), or null. */
  defaultAgentId: string | null;
  /** Toggle the default agent. Omitted ⇒ the star affordance is hidden. */
  onSetDefaultAgent?: (agentId: string | null) => void;
  /** The currently selected agent (from the shared store). */
  selectedAgentId: string | null;
  /** Current code-session repo/env selection, to preselect the setup step. */
  selectedRepoKey: string | null;
  selectedEnvId: string | null;
  /** Current branch selection (null = the repo's default), to preselect. */
  selectedBranch?: string | null;
  /** Apply an agent (+ optional repo/branch/env) to the composer. */
  onApply: (sel: AgentSelectionApply) => void;
  /** Called after a selection is applied — popover closes / gallery collapses. */
  onDismiss?: () => void;
  variant: "popover" | "gallery";
  /**
   * Scopes the v2 "Recent" row's persisted recency to this workspace, and (with
   * `orgSlug`) scopes the setup step's branch fetch. Omit both ⇒ no branch row.
   */
  workspaceSlug?: string;
  /** Org scope for the setup step's branch fetch. Omitted ⇒ no branch row. */
  orgSlug?: string;
  className?: string;
}

/**
 * Sentinel `<SelectItem>` value for "use the repository's default branch"
 * (branch: null) — a Select can't carry null. Matches the equivalent sentinel
 * in `session/session-settings.tsx`.
 */
const DEFAULT_BRANCH_VALUE = "__repo_default__";

/** The "Repository default (main)" row/placeholder label. */
function defaultBranchLabel(defaultBranch: string | null): string {
  return defaultBranch
    ? `Repository default (${defaultBranch})`
    : "Repository default";
}

/** Small pill marking an agent as code- or chat-capable. */
function KindBadge({ isCode }: { isCode: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none",
        isCode
          ? "border-primary/30 bg-primary/10 text-primary"
          : "border-border bg-background text-muted-foreground",
      )}
    >
      {isCode ? (
        <Code2 className="size-2.5" />
      ) : (
        <MessageSquare className="size-2.5" />
      )}
      {isCode ? "code" : "chat"}
    </span>
  );
}

/** Pill marking a platform-managed agent (vs. a user-authored one). */
function ManagedBadge() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground">
      <Shield className="size-2.5" />
      managed
    </span>
  );
}

function agentMatches(agent: AgentOption, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    agent.name.toLowerCase().includes(q) ||
    (agent.description?.toLowerCase().includes(q) ?? false) ||
    (agent.summary?.toLowerCase().includes(q) ?? false)
  );
}

export function AgentPickerPanel({
  agents,
  repos,
  environments,
  defaultRepoKey,
  defaultEnvId,
  defaultAgentId,
  onSetDefaultAgent,
  selectedAgentId,
  selectedRepoKey,
  selectedEnvId,
  selectedBranch = null,
  onApply,
  onDismiss,
  variant,
  workspaceSlug,
  orgSlug,
  className,
}: AgentPickerPanelProps) {
  const reduce = useReducedMotion();
  const [query, setQuery] = React.useState("");
  // chat_ux_v2: the unified session provider is mounted — see the module doc
  // for the three behavior changes this flips on.
  const v2 = useChatSessionContext() !== null;
  const [recentIds, setRecentIds] = React.useState<string[]>([]);
  React.useEffect(() => {
    if (v2) setRecentIds(readRecentAgentIds(workspaceSlug));
  }, [v2, workspaceSlug]);
  const recentAgents = React.useMemo(
    () =>
      recentIds
        .map((id) => agents.find((a) => a.agentId === id))
        .filter((a): a is AgentOption => a !== undefined)
        .slice(0, 5),
    [recentIds, agents],
  );
  // Inline code-agent setup step: when set, the repo/env sub-view is shown for
  // the pending agent instead of the list.
  const [setupAgent, setSetupAgent] = React.useState<AgentOption | null>(null);
  const [setupRepoKey, setSetupRepoKey] = React.useState<string | null>(null);
  // null = the repository's default branch — never force a choice.
  const [setupBranch, setSetupBranch] = React.useState<string | null>(null);
  const [setupEnvId, setSetupEnvId] = React.useState<string | null>(null);

  // The setup step's branch list, fetched from the SAME machinery the
  // SessionSettings hosts use (`list_branches` via `listRepoBranchesAction`).
  // It keys off the step's PENDING repo, not the session's — the panel can
  // render outside a ChatSessionProvider, so it can't read the store.
  const setupRepo = React.useMemo(
    () => (setupRepoKey ? (repos.find((r) => r.key === setupRepoKey) ?? null) : null),
    [repos, setupRepoKey],
  );
  const { branches, branchesLoading, defaultBranch, onLoadBranches } =
    useRepoBranches({ repo: setupRepo, orgSlug, workspaceSlug });
  // Without an org+workspace scope there is nothing to fetch — degrade to
  // repo + environment rather than render a picker that can never populate.
  const showBranchRow = Boolean(orgSlug && workspaceSlug);

  // Cascade (the law in `session-state.ts`): changing the repo resets the
  // branch — a branch belongs to the repo you picked it from.
  const selectSetupRepo = React.useCallback(
    (repo: RepoOption) => {
      if (repo.key !== setupRepoKey) setSetupBranch(null);
      setSetupRepoKey(repo.key);
    },
    [setupRepoKey],
  );

  // The workspace default agent surfaces first (right after the Default
  // assistant row), so a user's preferred agent leads the list; the filled star
  // + "Default" label on its row carries the visual distinction.
  const filtered = React.useMemo(() => {
    const matched = agents.filter((a) => agentMatches(a, query));
    if (!defaultAgentId) return matched;
    return [...matched].sort((a, b) => {
      if (a.agentId === defaultAgentId) return -1;
      if (b.agentId === defaultAgentId) return 1;
      return 0;
    });
  }, [agents, query, defaultAgentId]);

  // Roving focus over the rows (index 0 = Default assistant, 1..N = agents).
  const rowRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const focusRow = React.useCallback((index: number) => {
    const rows = rowRefs.current.filter(Boolean) as HTMLButtonElement[];
    if (rows.length === 0) return;
    const clamped = ((index % rows.length) + rows.length) % rows.length;
    rows[clamped]?.focus();
  }, []);

  const applyAgent = React.useCallback(
    (agent: AgentOption | null) => {
      // v2: every pick applies immediately — no embedded repo/env setup step.
      // A code agent's session prefills from its remembered code context (the
      // session store's agent-switch overlay); the rail/drawer is the adjust
      // surface. Record recency and hand focus to the composer.
      if (v2) {
        onApply({ agentId: agent?.agentId ?? null });
        if (agent) {
          pushRecentAgentId(workspaceSlug, agent.agentId);
          setRecentIds(readRecentAgentIds(workspaceSlug));
        }
        window.dispatchEvent(new CustomEvent(FOCUS_COMPOSER_EVENT));
        onDismiss?.();
        return;
      }
      if (agent && agent.isCode) {
        // Prefill the setup step from the live selection, else workspace defaults.
        setSetupAgent(agent);
        setSetupRepoKey(selectedRepoKey ?? defaultRepoKey);
        // No workspace default branch exists — null is the repo's default.
        setSetupBranch(selectedBranch);
        setSetupEnvId(selectedEnvId ?? defaultEnvId);
        return;
      }
      onApply({ agentId: agent?.agentId ?? null });
      onDismiss?.();
    },
    [
      v2,
      workspaceSlug,
      onApply,
      onDismiss,
      selectedRepoKey,
      selectedEnvId,
      selectedBranch,
      defaultRepoKey,
      defaultEnvId,
    ],
  );

  const confirmSetup = React.useCallback(() => {
    if (!setupAgent) return;
    // The whole target, atomically: repo → branch → environment. `branch: null`
    // is meaningful (the repo's default), so it's always sent rather than
    // omitted — the conversation starts fully bound either way.
    onApply({
      agentId: setupAgent.agentId,
      repoKey: setupRepoKey,
      branch: setupBranch,
      envId: setupEnvId,
    });
    // Return to the list (the popover also closes via onDismiss); the gallery
    // has no dismiss, so without this it would stay stuck on the setup step.
    setSetupAgent(null);
    onDismiss?.();
  }, [setupAgent, setupRepoKey, setupBranch, setupEnvId, onApply, onDismiss]);

  const handleListKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const rows = rowRefs.current.filter(Boolean) as HTMLButtonElement[];
      const activeIndex = rows.indexOf(
        document.activeElement as HTMLButtonElement,
      );
      if (e.key === "ArrowDown") {
        e.preventDefault();
        focusRow(activeIndex < 0 ? 0 : activeIndex + 1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        focusRow(activeIndex < 0 ? rows.length - 1 : activeIndex - 1);
      }
    },
    [focusRow],
  );

  const setupBusy = setupAgent !== null;
  const canConfirm = Boolean(setupRepoKey && setupEnvId);

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col",
        variant === "popover" ? "w-[22rem] max-w-[92vw]" : "w-full",
        className,
      )}
      data-agent-picker={variant}
    >
      <AnimatePresence mode="wait" initial={false}>
        {setupBusy ? (
          <motion.div
            key="setup"
            initial={reduce ? undefined : { opacity: 0, x: 8 }}
            animate={reduce ? undefined : { opacity: 1, x: 0 }}
            exit={reduce ? undefined : { opacity: 0, x: 8 }}
            transition={transition.base}
            className="flex flex-col gap-3 p-3"
          >
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Back to agent list"
                onClick={() => setSetupAgent(null)}
              >
                <ArrowLeft className="size-4" />
              </Button>
              <div className="flex min-w-0 items-center gap-2">
                <AgentAvatar
                  avatarUrl={setupAgent.avatarUrl}
                  name={setupAgent.name}
                  slug={setupAgent.slug}
                  size="md"
                  shape="square"
                />
                <span className="truncate text-sm font-medium">
                  {setupAgent.name}
                </span>
                <KindBadge isCode />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Where should{" "}
              <span className="font-medium text-foreground">
                {setupAgent.name}
              </span>{" "}
              work?{" "}
              {showBranchRow
                ? "Pick the repository, branch, and environment for this session."
                : "Pick the repository and environment for this session."}
            </p>
            <div className="flex flex-col gap-2">
              <RepoSelector
                repositories={repos}
                selectedKey={setupRepoKey}
                onSelectRepo={selectSetupRepo}
                className="w-full sm:w-full"
                ariaLabel="Session repository"
              />
              {showBranchRow ? (
                <div
                  className="flex w-full min-w-0 items-center gap-2"
                  data-testid="setup-branch-row"
                >
                  <GitBranch className="size-4 shrink-0 text-muted-foreground" />
                  <Select
                    value={setupBranch ?? DEFAULT_BRANCH_VALUE}
                    onValueChange={(value) =>
                      setSetupBranch(
                        value === DEFAULT_BRANCH_VALUE ? null : value,
                      )
                    }
                    // Fetch lazily, on first open — opening the setup step must
                    // not spend a GitHub call on a branch list nobody looked at.
                    onOpenChange={(open) => {
                      if (open) onLoadBranches();
                    }}
                    disabled={!setupRepoKey}
                  >
                    <SelectTrigger
                      className="min-h-11 w-full sm:min-h-0 sm:w-full"
                      aria-label="Session branch"
                    >
                      {/* Function child: the value is set programmatically (and
                          the items aren't mounted until the popup first opens),
                          so resolve the label here — the sentinel must read as
                          "Repository default", never as its raw id. */}
                      <SelectValue placeholder={defaultBranchLabel(defaultBranch)}>
                        {(value: string | null) =>
                          value && value !== DEFAULT_BRANCH_VALUE
                            ? value
                            : defaultBranchLabel(defaultBranch)
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value={DEFAULT_BRANCH_VALUE}>
                        {defaultBranchLabel(defaultBranch)}
                      </SelectItem>
                      {branchesLoading ? (
                        <p className="px-3 py-2 text-xs text-muted-foreground">
                          Loading branches…
                        </p>
                      ) : null}
                      {/* The default branch is already the sentinel row —
                          listing it again would be two rows that do the same
                          thing for a target that's immutable once the
                          conversation starts. */}
                      {(branches ?? [])
                        .filter((name) => name !== defaultBranch)
                        .map((name) => (
                          <SelectItem key={name} value={name}>
                            {name}
                          </SelectItem>
                        ))}
                    </SelectPopup>
                  </Select>
                </div>
              ) : null}
              <EnvironmentSelector
                environments={environments}
                selectedEnvId={setupEnvId}
                onSelectEnv={(id) => setSetupEnvId(id)}
                className="w-full sm:w-full"
                ariaLabel="Session environment"
              />
            </div>
            {repos.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Connect a GitHub repository to run this agent against your code.
              </p>
            ) : null}
            <Button
              variant="primary"
              size="sm"
              disabled={!canConfirm}
              onClick={confirmSetup}
              className="w-full"
            >
              Chat with {setupAgent.name}
            </Button>
          </motion.div>
        ) : (
          <motion.div
            key="list"
            initial={reduce ? undefined : { opacity: 0 }}
            animate={reduce ? undefined : { opacity: 1 }}
            exit={reduce ? undefined : { opacity: 0 }}
            transition={transition.base}
            className="flex min-h-0 flex-col"
          >
            <div className="border-b border-border p-2">
              <SearchInput
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onClear={() => setQuery("")}
                placeholder="Search agents"
                aria-label="Search agents"
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    focusRow(0);
                  }
                }}
              />
            </div>
            {v2 && recentAgents.length > 0 ? (
              <div className="border-b border-border px-2.5 py-2" data-testid="recent-agents-row">
                <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">
                  Recent
                </p>
                <div className="flex items-center gap-2">
                  {recentAgents.map((agent) => (
                    <button
                      key={agent.agentId}
                      type="button"
                      aria-label={`Chat with ${agent.name}`}
                      title={agent.name}
                      onClick={() => applyAgent(agent)}
                      className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <AgentAvatar
                        avatarUrl={agent.avatarUrl}
                        name={agent.name}
                        slug={agent.slug}
                        size="md"
                        shape="square"
                      />
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            <motion.div
              role="listbox"
              aria-label="Agents"
              onKeyDown={handleListKeyDown}
              variants={reduce ? undefined : staggerContainer}
              initial={reduce ? undefined : "hidden"}
              animate={reduce ? undefined : "visible"}
              className={cn(
                "flex min-h-0 flex-col gap-0.5 overflow-y-auto p-1.5",
                variant === "popover" ? "max-h-[24rem]" : "max-h-[26rem]",
              )}
            >
              <AgentRow
                ref={(el) => {
                  rowRefs.current[0] = el;
                }}
                reduce={reduce}
                icon={<Bot className="size-5 text-muted-foreground" />}
                name="Default assistant"
                description="General chat — no repository tools"
                isSelected={selectedAgentId === null}
                onSelect={() => applyAgent(null)}
              />
              {filtered.map((agent, i) => {
                const isDefault = defaultAgentId === agent.agentId;
                return (
                  <AgentRow
                    key={agent.agentId}
                    ref={(el) => {
                      rowRefs.current[i + 1] = el;
                    }}
                    reduce={reduce}
                    avatar={
                      <AgentAvatar
                        avatarUrl={agent.avatarUrl}
                        name={agent.name}
                        slug={agent.slug}
                        size={variant === "gallery" ? "md" : "sm"}
                        shape="square"
                      />
                    }
                    name={agent.name}
                    description={agent.summary ?? agent.description}
                    isCode={agent.isCode}
                    managed={agent.managed}
                    toolRefs={agent.toolRefs}
                    isSelected={selectedAgentId === agent.agentId}
                    isDefault={isDefault}
                    onSelect={() => applyAgent(agent)}
                    onToggleDefault={
                      onSetDefaultAgent
                        ? () =>
                            onSetDefaultAgent(isDefault ? null : agent.agentId)
                        : undefined
                    }
                    infoSlot={
                      v2 ? (
                        <AgentInfoButton
                          agent={agent}
                          onChat={() => applyAgent(agent)}
                        />
                      ) : undefined
                    }
                  />
                );
              })}
              {filtered.length === 0 ? (
                <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                  No agents match “{query}”.
                </p>
              ) : null}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

interface AgentRowProps {
  reduce: boolean | null;
  avatar?: React.ReactNode;
  icon?: React.ReactNode;
  name: string;
  description: string | null;
  isCode?: boolean;
  managed?: boolean;
  toolRefs?: AgentOption["toolRefs"];
  isSelected: boolean;
  isDefault?: boolean;
  onSelect: () => void;
  onToggleDefault?: () => void;
  /** v2 "About {name}" affordance rendered after the row body. */
  infoSlot?: React.ReactNode;
}

const AgentRow = React.forwardRef<HTMLButtonElement, AgentRowProps>(
  function AgentRow(
    {
      reduce,
      avatar,
      icon,
      name,
      description,
      isCode,
      managed,
      toolRefs,
      isSelected,
      isDefault,
      onSelect,
      onToggleDefault,
      infoSlot,
    },
    ref,
  ) {
    const Row = reduce ? "div" : motion.div;
    return (
      <Row
        {...(reduce ? {} : { variants: fadeInUp })}
        className="group relative flex items-start gap-2 rounded-lg"
      >
        <button
          ref={ref}
          type="button"
          role="option"
          aria-selected={isSelected}
          onClick={onSelect}
          className={cn(
            "flex min-w-0 flex-1 items-start gap-3 rounded-lg px-2.5 py-2 text-left transition-colors duration-[var(--motion-micro)]",
            "hover:bg-muted focus-visible:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            isSelected && "bg-muted/60",
          )}
        >
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center">
            {avatar ?? icon}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-sm font-medium text-foreground">
                {name}
              </span>
              {isCode !== undefined && <KindBadge isCode={isCode} />}
              {managed && <ManagedBadge />}
              {isSelected && (
                <Check className="size-3.5 shrink-0 text-primary" />
              )}
            </span>
            {description ? (
              <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                {description}
              </span>
            ) : null}
            {toolRefs && toolRefs.length > 0 ? (
              <CapabilityStrip toolRefs={toolRefs} className="mt-1" />
            ) : null}
          </span>
        </button>
        {infoSlot}
        {onToggleDefault ? (
          <button
            type="button"
            aria-pressed={Boolean(isDefault)}
            aria-label={
              isDefault
                ? `Remove ${name} as default assistant`
                : `Set ${name} as default assistant`
            }
            onClick={(e) => {
              e.stopPropagation();
              onToggleDefault();
            }}
            className={cn(
              "absolute right-2 top-2 inline-flex items-center gap-1 rounded px-1.5 py-1 text-[10px] font-medium leading-none transition-opacity duration-[var(--motion-micro)]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              isDefault
                ? "text-primary opacity-100"
                : "text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100",
            )}
          >
            <Star className={cn("size-3.5", isDefault && "fill-current")} />
            {isDefault ? "Default" : null}
          </button>
        ) : null}
      </Row>
    );
  },
);
