"use client";
import * as React from "react";
import { motion, useReducedMotion } from "motion/react";
import { Bot, Check, Shield, Star } from "lucide-react";
import { fadeInUp, staggerContainer, transition } from "@oxagen/ui/lib/motion";
import { cn } from "@/lib/utils";
import { SearchInput } from "@/components/ui/search-input";
import { AgentAvatar } from "./agent-avatar";
import { AgentInfoButton } from "./agent-info-button";
import { FOCUS_COMPOSER_EVENT } from "./focus-composer-event";
import {
  pushRecentAgentId,
  readRecentAgentIds,
} from "../session/recent-agents";
import { useChatSessionContext } from "../session/session-store";
import { CapabilityStrip } from "./capability-strip";
import type { AgentOption } from "./agent-picker-types";
import type { AgentSelectionApply } from "./chat-selection-context";

/**
 * agent-picker-panel.tsx — the shared agent-selection surface, presented either
 * as a composer popover (`variant="popover"`) or as an empty-state gallery hero
 * (`variant="gallery"`). Lists the workspace's agents with avatar, a one-line
 * description, and a capability strip; a star per row sets the user's default.
 * Every pick applies immediately — ADR-043 removed the code-agent setup step
 * (repository → branch → sandbox environment), because a conversation is no
 * longer grounded in a repository.
 *
 * chat_ux_v2 (`useChatSessionContext() !== null`) changes two things, both
 * gated on the same `v2` boolean: (1) a "Recent" row of up to 5 avatars for
 * quick re-pick, persisted per workspace (`session/recent-agents.ts`); (2) each
 * row gets an "About {name}" info affordance. Flag off keeps every existing
 * behavior byte-identical.
 */

export interface AgentPickerPanelProps {
  agents: AgentOption[];
  /** The workspace user's current default agent (agt_… public id), or null. */
  defaultAgentId: string | null;
  /** Toggle the default agent. Omitted ⇒ the star affordance is hidden. */
  onSetDefaultAgent?: (agentId: string | null) => void;
  /** The currently selected agent (from the shared store). */
  selectedAgentId: string | null;
  /** Apply an agent to the composer. */
  onApply: (sel: AgentSelectionApply) => void;
  /** Called after a selection is applied — popover closes / gallery collapses. */
  onDismiss?: () => void;
  variant: "popover" | "gallery";
  /** Scopes the v2 "Recent" row's persisted recency to this workspace. */
  workspaceSlug?: string;
  className?: string;
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
  defaultAgentId,
  onSetDefaultAgent,
  selectedAgentId,
  onApply,
  onDismiss,
  variant,
  workspaceSlug,
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
      onApply({ agentId: agent?.agentId ?? null });
      // v2 additionally records recency and hands focus back to the composer.
      if (v2) {
        if (agent) {
          pushRecentAgentId(workspaceSlug, agent.agentId);
          setRecentIds(readRecentAgentIds(workspaceSlug));
        }
        window.dispatchEvent(new CustomEvent(FOCUS_COMPOSER_EVENT));
      }
      onDismiss?.();
    },
    [v2, workspaceSlug, onApply, onDismiss],
  );

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

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col",
        variant === "popover" ? "w-[22rem] max-w-[92vw]" : "w-full",
        className,
      )}
      data-agent-picker={variant}
    >
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
          <div
            className="border-b border-border px-2.5 py-2"
            data-testid="recent-agents-row"
          >
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
            description="General chat — workspace defaults, no agent binding"
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
                managed={agent.managed}
                toolRefs={agent.toolRefs}
                isSelected={selectedAgentId === agent.agentId}
                isDefault={isDefault}
                onSelect={() => applyAgent(agent)}
                onToggleDefault={
                  onSetDefaultAgent
                    ? () => onSetDefaultAgent(isDefault ? null : agent.agentId)
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
    </div>
  );
}

interface AgentRowProps {
  reduce: boolean | null;
  avatar?: React.ReactNode;
  icon?: React.ReactNode;
  name: string;
  description: string | null;
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
