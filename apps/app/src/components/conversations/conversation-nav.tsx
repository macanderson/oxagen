"use client";
/**
 * ConversationNav — responsive chrome around ConversationList.
 *
 * Desktop: a persistent, COLLAPSIBLE vertical secondary-nav aside to the left of
 * the chat. Expanded it shows the full history list; collapsed it shrinks to a
 * slim icon rail (the expand affordance stays visible so the panel is always
 * re-openable — never a dead, hidden control). Collapse state is an in-memory
 * flag (so the toggle works even when storage is blocked) that starts expanded —
 * matching the server render, so there is no hydration mismatch — then restores
 * the last-used preference from localStorage on mount, so it survives navigations
 * and reloads. See `useCollapsed` below.
 *
 * Mobile: a slide-in left Sheet opened from a compact trigger bar above the
 * chat, so the conversation history stays a vertical, thumb-navigable list
 * without stealing chat space on small screens.
 *
 * Returns a fragment of two blocks (mobile trigger, desktop aside); the parent
 * lays them out with `flex flex-col md:flex-row` so the right one shows per
 * breakpoint.
 */
import { useCallback, useEffect, useState } from "react";
import { MessagesSquare, PanelLeftClose } from "lucide-react";
import {
  Sheet,
  SheetTrigger,
  SheetPopup,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipPopup } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ConversationList } from "./conversation-list";
import type { ConversationNavActions, ConversationSummary } from "./types";

// ---------------------------------------------------------------------------
// Persisted collapse state (desktop aside)
// ---------------------------------------------------------------------------

const STORAGE_KEY = "oxagen.conversation-nav.collapsed";

/** Read the persisted collapse flag; false if storage is unavailable. */
function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Persist the collapse flag; best-effort only (storage may be blocked). */
function writeCollapsed(next: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
  } catch {
    // Non-fatal — the in-memory flag still drives the UI for this session.
  }
}

/**
 * Collapse flag for the desktop aside.
 *
 * In-memory state is the SOURCE OF TRUTH, so the toggle always works even when
 * localStorage is blocked (private mode, disabled storage) — persistence is a
 * best-effort enhancement, never a dependency. Initial state is `false`
 * (expanded) so the server render and the first client paint agree (no
 * hydration mismatch); the persisted preference is restored once on mount,
 * after hydration, so it survives reloads without risking a mismatch.
 */
function useCollapsed(): [boolean, (next: boolean) => void] {
  const [collapsed, setCollapsedState] = useState(false);

  useEffect(() => {
    if (readCollapsed()) setCollapsedState(true);
  }, []);

  const setCollapsed = useCallback((next: boolean) => {
    setCollapsedState(next);
    writeCollapsed(next);
  }, []);

  return [collapsed, setCollapsed];
}

export interface ConversationNavProps {
  currentPublicId: string | null;
  initialActive: ConversationSummary[];
  initialActiveNextCursor: string | null;
  actions: ConversationNavActions;
}

export function ConversationNav(props: ConversationNavProps) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [collapsed, setCollapsed] = useCollapsed();

  // chat_ux_v2 mobile: the chat header's conversations button opens this
  // sheet via a window event — its own trigger bar is CSS-hidden while the
  // v2 chat chrome is mounted (see globals.css), so the sheet stays the one
  // implementation of "browse conversations" on mobile.
  useEffect(() => {
    const open = () => setSheetOpen(true);
    window.addEventListener("oxagen:open-conversations", open);
    return () => window.removeEventListener("oxagen:open-conversations", open);
  }, []);

  return (
    <>
      {/* Mobile: a compact trigger that FLOATS over the top-left of the
          conversation (never a full-width bar that steals a row of height) +
          slide-in Sheet. Absolutely positioned so it overlays the transcript
          instead of pushing it down — the parent page flex is `relative` (see
          conversation-page.tsx). The transcript's own scroll leaves top room
          for it (mobile top padding). The v2 mobile chat header owns its own
          conversations entry point, so this element is CSS-hidden under
          `body[data-chat-ux-v2-mobile]` (globals.css). */}
      <div
        className="absolute left-2 top-2 z-30 md:hidden"
        data-conversation-nav-trigger
      >
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetTrigger
            render={
              <Button
                variant="outline"
                size="sm"
                aria-label="Conversations"
                className="h-9 gap-1.5 rounded-full border-border/60 bg-background/95 px-3 shadow-sm backdrop-blur"
              />
            }
          >
            <MessagesSquare className="size-4" />
            <span className="text-xs font-medium">Conversations</span>
          </SheetTrigger>
          <SheetPopup side="left" className="flex w-80 flex-col p-0">
            <SheetHeader className="border-b border-border px-4 py-3">
              <SheetTitle>Conversations</SheetTitle>
            </SheetHeader>
            <div className="min-h-0 flex-1 py-2">
              <ConversationList
                {...props}
                onNavigate={() => setSheetOpen(false)}
              />
            </div>
          </SheetPopup>
        </Sheet>
      </div>

      {/* Desktop: persistent, collapsible vertical secondary nav. Width animates
          between the full list (w-64) and a slim icon rail (w-12). */}
      <aside
        aria-label="Conversations"
        className={cn(
          "hidden shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-background transition-[width] duration-200 ease-in-out md:flex",
          collapsed ? "w-12" : "w-64",
        )}
      >
        {collapsed ? (
          // Collapsed rail: a single expand affordance, kept discoverable with
          // the same MessagesSquare glyph the mobile trigger uses.
          <div className="flex flex-col items-center p-2">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Show conversations"
                    aria-expanded={false}
                    onClick={() => setCollapsed(false)}
                  />
                }
              >
                <MessagesSquare className="size-4" />
              </TooltipTrigger>
              <TooltipPopup side="right">Show conversations</TooltipPopup>
            </Tooltip>
          </div>
        ) : (
          <>
            <header className="flex shrink-0 items-center justify-between gap-2 px-4 py-3">
              <h2 className="text-sm font-semibold">Conversations</h2>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      className="-mr-1 size-7"
                      aria-label="Collapse conversations"
                      aria-expanded
                      aria-controls="conversation-history-panel"
                      onClick={() => setCollapsed(true)}
                    />
                  }
                >
                  <PanelLeftClose className="size-4" />
                </TooltipTrigger>
                <TooltipPopup side="right">Collapse</TooltipPopup>
              </Tooltip>
            </header>
            <div id="conversation-history-panel" className="min-h-0 flex-1">
              <ConversationList {...props} />
            </div>
          </>
        )}
      </aside>
    </>
  );
}
