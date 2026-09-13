"use client";
import * as React from "react";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-media-query";
import { Button } from "@/components/ui/button";
import { Popover, PopoverTrigger, PopoverPopup } from "@/components/ui/popover";
import {
  Sheet,
  SheetPopup,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { AgentAvatar } from "./agent-avatar";
import { prettifyRef } from "./capability-strip";
import type { AgentOption } from "./agent-picker-types";

/**
 * agent-info-button.tsx — the chat_ux_v2 agent picker row's "About {name}"
 * ghost affordance: a small info icon that opens the agent's full
 * description + complete skill list (names only, never raw ids/slugs) with a
 * "Chat with {name}" CTA that applies the selection — an anchored Popover on
 * desktop, the same bottom-sheet chrome `SessionSettingsDrawer` uses on a
 * phone-width viewport (reusing shared primitives rather than a bespoke
 * overlay per surface).
 */

export interface AgentInfoButtonProps {
  agent: AgentOption;
  /** Applies this agent as the selection (the details CTA's action). */
  onChat: () => void;
  className?: string;
}

function AgentInfoBody({
  agent,
  onChat,
  onDone,
}: {
  agent: AgentOption;
  onChat: () => void;
  onDone: () => void;
}) {
  const description = agent.description ?? agent.summary;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <AgentAvatar
          avatarUrl={agent.avatarUrl}
          name={agent.name}
          slug={agent.slug}
          size="md"
          shape="square"
        />
        <span className="text-sm font-medium text-foreground">
          {agent.name}
        </span>
      </div>
      {description ? (
        <p className="text-sm text-muted-foreground">{description}</p>
      ) : null}
      {agent.toolRefs.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Skills
          </span>
          <ul className="flex flex-col gap-1">
            {agent.toolRefs.map((t, i) => (
              <li
                key={`${t.type}:${t.ref}:${i}`}
                className="text-sm text-foreground"
              >
                {prettifyRef(t.ref)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <Button
        type="button"
        variant="primary"
        size="sm"
        onClick={() => {
          onChat();
          onDone();
        }}
        className="w-full"
      >
        Chat with {agent.name}
      </Button>
    </div>
  );
}

export function AgentInfoButton({
  agent,
  onChat,
  className,
}: AgentInfoButtonProps) {
  const isMobile = useIsMobile();
  const [open, setOpen] = React.useState(false);
  const ariaLabel = `About ${agent.name}`;

  if (isMobile) {
    return (
      <>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={ariaLabel}
          onClick={(e) => {
            e.stopPropagation();
            setOpen(true);
          }}
          className={className}
        >
          <Info className="size-3.5" aria-hidden="true" />
        </Button>
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetPopup
            side="bottom"
            className={cn("max-h-[80dvh] overflow-y-auto")}
          >
            <SheetHeader>
              <SheetTitle>{agent.name}</SheetTitle>
            </SheetHeader>
            <div className="px-4 pb-4">
              <AgentInfoBody
                agent={agent}
                onChat={onChat}
                onDone={() => setOpen(false)}
              />
            </div>
          </SheetPopup>
        </Sheet>
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={ariaLabel}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
            className={className}
          />
        }
      >
        <Info className="size-3.5" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-72 p-3">
        <AgentInfoBody
          agent={agent}
          onChat={onChat}
          onDone={() => setOpen(false)}
        />
      </PopoverPopup>
    </Popover>
  );
}
