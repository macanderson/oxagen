"use client";
import * as React from "react";
import { Bot, ChevronDown, Code2, Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Popover, PopoverTrigger, PopoverPopup } from "@/components/ui/popover";
import { AgentAvatar } from "./agent-avatar";
import { AgentPickerPanel } from "./agent-picker-panel";
import type { RepoOption } from "../repo-selector";
import type { EnvironmentOption } from "../environment-selector";
import type { AgentOption } from "./agent-picker-types";
import type { AgentSelectionApply } from "./chat-selection-context";

/**
 * agent-context-chip.tsx — the composer's compact agent affordance. Shows the
 * selected agent's avatar + name (or an "Assistant" ghost state), a code badge
 * when the agent governs code mode, and opens the
 * `AgentPickerPanel` in a popover. Fully controlled: selection + apply flow
 * through props so it shares the composer's single selection store (it must not
 * instantiate its own).
 */
export interface AgentContextChipProps {
  agents: AgentOption[];
  repos: RepoOption[];
  environments: EnvironmentOption[];
  defaultRepoKey: string | null;
  defaultEnvId: string | null;
  defaultAgentId: string | null;
  onSetDefaultAgent?: (agentId: string | null) => void;
  selectedAgentId: string | null;
  selectedRepoKey: string | null;
  selectedEnvId: string | null;
  /** Current branch (null = the repo's default) — preselects the setup step. */
  selectedBranch?: string | null;
  onApply: (sel: AgentSelectionApply) => void;
  /**
   * When true the conversation's agent is LOCKED (its coding target was claimed
   * on the first code turn). The chip renders read-only — the selected agent is
   * shown but the picker can't be opened. Start a new conversation to change.
   */
  locked?: boolean;
  /** Scope for the picker's branch fetch. Omit ⇒ the setup step has no branch row. */
  orgSlug?: string;
  workspaceSlug?: string;
  className?: string;
}

/** Human hint shown on the locked chip / pickers. */
const LOCK_HINT =
  "Locked for this conversation — start a new conversation to change";

export function AgentContextChip({
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
  locked = false,
  orgSlug,
  workspaceSlug,
  className,
}: AgentContextChipProps) {
  const [open, setOpen] = React.useState(false);

  // A workspace with no agents keeps the plain composer — no chip to show.
  if (agents.length === 0) return null;

  const selected = selectedAgentId
    ? (agents.find((a) => a.agentId === selectedAgentId) ?? null)
    : null;
  const label = selected?.name ?? "Assistant";

  // Locked: render the chip read-only — the bound agent is visible but the
  // picker can't open. A disabled button carries a native `title` tooltip and a
  // lock glyph so the state is legible without a portal (which also keeps this
  // robust under tests that stub the popover).
  if (locked) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled
        aria-label={`Agent locked: ${label}`}
        title={LOCK_HINT}
        data-testid="agent-context-chip-locked"
        className={cn("h-8 gap-1.5 px-2 text-xs font-medium", className)}
      >
        {selected ? (
          <AgentAvatar
            avatarUrl={selected.avatarUrl}
            name={selected.name}
            slug={selected.slug}
            size="sm"
            shape="square"
          />
        ) : (
          <Bot className="size-3.5 text-muted-foreground" />
        )}
        <span className="max-w-[140px] truncate">{label}</span>
        {selected?.isCode ? <Code2 className="size-3 text-primary" /> : null}
        <Lock className="size-3 text-muted-foreground" aria-hidden="true" />
      </Button>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Agent: ${label}`}
            className={cn("h-8 gap-1.5 px-2 text-xs font-medium", className)}
          />
        }
      >
        {selected ? (
          <AgentAvatar
            avatarUrl={selected.avatarUrl}
            name={selected.name}
            slug={selected.slug}
            size="sm"
            shape="square"
          />
        ) : (
          <Bot className="size-3.5 text-muted-foreground" />
        )}
        <span className="max-w-[140px] truncate">{label}</span>
        {selected?.isCode ? <Code2 className="size-3 text-primary" /> : null}
        <ChevronDown className="size-3 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverPopup sideOffset={8} align="start" className="p-0">
        <AgentPickerPanel
          variant="popover"
          agents={agents}
          repos={repos}
          environments={environments}
          defaultRepoKey={defaultRepoKey}
          defaultEnvId={defaultEnvId}
          defaultAgentId={defaultAgentId}
          onSetDefaultAgent={onSetDefaultAgent}
          selectedAgentId={selectedAgentId}
          selectedRepoKey={selectedRepoKey}
          selectedEnvId={selectedEnvId}
          selectedBranch={selectedBranch}
          onApply={onApply}
          onDismiss={() => setOpen(false)}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
        />
      </PopoverPopup>
    </Popover>
  );
}
