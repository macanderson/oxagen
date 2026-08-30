"use client";

import * as React from "react";
import type { SlashCommand } from "@oxagen/ai/slash-commands";
import { cn } from "@/lib/utils";

interface SlashCommandMenuProps {
  commands: readonly SlashCommand[];
  activeIndex: number;
  onSelect: (command: SlashCommand) => void;
  onHoverIndex: (index: number) => void;
}

/**
 * Autocomplete overlay for composer slash commands. Presentational only —
 * the composer owns the open/query/active-index state and the keyboard
 * navigation (so it can intercept Enter before the form submits). Rendered
 * above the textarea when the input is a lone slash token.
 */
export function SlashCommandMenu({
  commands,
  activeIndex,
  onSelect,
  onHoverIndex,
}: SlashCommandMenuProps) {
  if (commands.length === 0) return null;
  return (
    <div
      role="listbox"
      aria-label="Slash commands"
      className="absolute bottom-full left-0 z-20 mb-2 w-72 overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg"
      data-testid="slash-command-menu"
    >
      {/* `option` must be an owned child of the `listbox`, so the list chrome
          in between is marked presentational — otherwise the implicit
          list/listitem roles break the required parent-child relationship and
          screen readers stop announcing the options. */}
      <ul role="presentation" className="max-h-64 overflow-y-auto py-1">
        {commands.map((command, index) => (
          <li role="presentation" key={command.name}>
            <button
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              // Prevent the textarea from losing focus (and the menu from
              // closing on blur) before onClick fires.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => onHoverIndex(index)}
              onClick={() => onSelect(command)}
              className={cn(
                "flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left",
                index === activeIndex ? "bg-muted" : "hover:bg-muted/60",
              )}
            >
              <span className="font-mono text-xs font-medium">
                /{command.name}
                {command.args ? (
                  <span className="text-muted-foreground"> {command.args}</span>
                ) : null}
              </span>
              <span className="text-xs text-muted-foreground">
                {command.summary}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
