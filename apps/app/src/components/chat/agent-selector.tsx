"use client";
import * as React from "react";
import { Bot, Check, ChevronDown, Code2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuGroupLabel,
  MenuSeparator,
} from "@/components/ui/menu";

/**
 * One selectable agent in the composer's agent picker. Defined here (the
 * client component that consumes it) so the server loader
 * (`agent-options-data.ts`) can import it as a TYPE — the same pattern
 * `repo-selector`/`code-mode-data` use for `RepoOption`, keeping a single
 * source of truth for the shape without pulling server code into the bundle.
 */
export interface AgentOption {
  /** Public identifier (`agt_…`) forwarded to the stream route as `agentId`. */
  agentId: string;
  slug: string;
  name: string;
  description: string | null;
  /** Free-form type discriminator (`custom`, `interactive_chat`, `code`, …). */
  agentType: string;
  /** True for a code agent — reveals the repo/code tooling + UI. */
  isCode: boolean;
}

export interface AgentSelectorProps {
  /** The workspace's selectable agents (empty ⇒ the picker is hidden). */
  agents: AgentOption[];
  /** The selected agent's `agentId`, or null for the default (generic chat) agent. */
  value: string | null;
  /** Fires with the chosen `agentId`, or null when "Default chat" is picked. */
  onChange: (agentId: string | null) => void;
}

/** Small pill marking an agent as code- or chat-capable. */
function KindBadge({ isCode }: { isCode: boolean }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none",
        isCode
          ? "border-primary/30 bg-primary/10 text-primary"
          : "border-border bg-background text-muted-foreground",
      )}
    >
      {isCode ? "code" : "chat"}
    </span>
  );
}

/**
 * Agent picker for the composer toolbar. Selecting a code agent
 * (`isCode`) is what tells the composer to reveal the repo/code tooling + UI
 * (the parent gates on the selected agent's `isCode`); a chat agent — or the
 * "Default chat" option — keeps the plain composer. Renders nothing when the
 * workspace has no selectable agents, so a workspace that never created one is
 * unaffected.
 */
export function AgentSelector({ agents, value, onChange }: AgentSelectorProps) {
  if (agents.length === 0) return null;

  const selected = value ? agents.find((a) => a.agentId === value) ?? null : null;
  const triggerLabel = selected?.name ?? "Default chat";
  const TriggerIcon = selected?.isCode ? Code2 : Bot;

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Agent: ${triggerLabel}`}
            className="h-8 gap-1.5 px-2 text-xs font-medium"
          />
        }
      >
        <TriggerIcon className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="max-w-[140px] truncate">{triggerLabel}</span>
        <ChevronDown className="h-3 w-3 text-muted-foreground" />
      </MenuTrigger>

      <MenuPopup sideOffset={8} align="start" className="w-72 p-0">
        <MenuGroupLabel className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
          Choose an agent
        </MenuGroupLabel>
        <div className="max-h-80 overflow-y-auto p-1">
          {/* Default (no agent) — plain chat, no repo/code tooling. */}
          <MenuItem
            onClick={() => onChange(null)}
            className="flex items-center gap-2 px-3 py-2"
          >
            <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-sm font-medium">Default chat</span>
                {value === null && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                General assistant — no repository tools
              </span>
            </span>
          </MenuItem>

          <MenuSeparator />

          {agents.map((a) => {
            const isActive = a.agentId === value;
            const Icon = a.isCode ? Code2 : Bot;
            return (
              <MenuItem
                key={a.agentId}
                onClick={() => onChange(a.agentId)}
                className="flex items-center gap-2 px-3 py-2"
              >
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{a.name}</span>
                    <KindBadge isCode={a.isCode} />
                    {isActive && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                  </span>
                  {a.description && (
                    <span className="block truncate text-xs text-muted-foreground">
                      {a.description}
                    </span>
                  )}
                </span>
              </MenuItem>
            );
          })}
        </div>
      </MenuPopup>
    </Menu>
  );
}
