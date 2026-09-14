"use client";
import * as React from "react";
import { Bot, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Popover, PopoverTrigger, PopoverPopup } from "@/components/ui/popover";
import { AgentAvatar } from "./agent-avatar";
import { AgentPickerPanel } from "./agent-picker-panel";
import type { AgentOption } from "./agent-picker-types";
import type { AgentSelectionApply } from "./chat-selection-context";

/**
 * agent-context-chip.tsx — the composer's compact agent affordance. Shows the
 * selected agent's avatar + name (or an "Assistant" ghost state) and opens the
 * `AgentPickerPanel` in a popover. Fully controlled: selection + apply flow
 * through props so it shares the composer's single selection store (it must not
 * instantiate its own).
 *
 * The chip has no locked/read-only variant. It used to render one after a code
 * turn claimed the conversation's durable coding target, but ADR-043 removed
 * that binding and made `agentId` a per-turn parameter — so the chip stays a
 * live control for the whole conversation (see chat-selection-context.tsx).
 */
export interface AgentContextChipProps {
  agents: AgentOption[];
  defaultAgentId: string | null;
  onSetDefaultAgent?: (agentId: string | null) => void;
  selectedAgentId: string | null;
  onApply: (sel: AgentSelectionApply) => void;
  workspaceSlug?: string;
  className?: string;
}

export function AgentContextChip({
  agents,
  defaultAgentId,
  onSetDefaultAgent,
  selectedAgentId,
  onApply,
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
        <ChevronDown className="size-3 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverPopup sideOffset={8} align="start" className="p-0">
        <AgentPickerPanel
          variant="popover"
          agents={agents}
          defaultAgentId={defaultAgentId}
          onSetDefaultAgent={onSetDefaultAgent}
          selectedAgentId={selectedAgentId}
          onApply={onApply}
          onDismiss={() => setOpen(false)}
          workspaceSlug={workspaceSlug}
        />
      </PopoverPopup>
    </Popover>
  );
}
