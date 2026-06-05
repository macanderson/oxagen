"use client";
/**
 * ConversationNav — responsive chrome around ConversationList.
 *
 * Desktop: a persistent vertical secondary-nav aside to the left of the chat.
 * Mobile: a slide-in left Sheet opened from a compact trigger bar above the
 * chat, so the conversation history stays a vertical, thumb-navigable list
 * without stealing chat space on small screens.
 *
 * Returns a fragment of two blocks (mobile trigger, desktop aside); the parent
 * lays them out with `flex flex-col md:flex-row` so the right one shows per
 * breakpoint.
 */
import { useState } from "react";
import { MessagesSquare } from "lucide-react";
import {
  Sheet,
  SheetTrigger,
  SheetPopup,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { ConversationList } from "./conversation-list";
import type { ConversationNavActions, ConversationSummary } from "./types";

export interface ConversationNavProps {
  currentPublicId: string | null;
  initialActive: ConversationSummary[];
  initialActiveNextCursor: string | null;
  actions: ConversationNavActions;
}

export function ConversationNav(props: ConversationNavProps) {
  const [sheetOpen, setSheetOpen] = useState(false);

  return (
    <>
      {/* Mobile: trigger bar + slide-in Sheet. */}
      <div className="md:hidden">
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetTrigger
            render={
              <Button variant="outline" size="sm" className="gap-2" />
            }
          >
            <MessagesSquare className="size-4" />
            Conversations
          </SheetTrigger>
          <SheetPopup side="left" className="flex w-80 flex-col p-0">
            <SheetHeader className="border-b border-border px-4 py-3">
              <SheetTitle>Conversations</SheetTitle>
            </SheetHeader>
            <div className="min-h-0 flex-1 py-2">
              <ConversationList {...props} onNavigate={() => setSheetOpen(false)} />
            </div>
          </SheetPopup>
        </Sheet>
      </div>

      {/* Desktop: persistent vertical secondary nav. */}
      <aside className="hidden w-64 shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-background md:flex">
        <header className="shrink-0 px-4 py-3">
          <h2 className="text-sm font-semibold">Conversations</h2>
        </header>
        <div className="min-h-0 flex-1">
          <ConversationList {...props} />
        </div>
      </aside>
    </>
  );
}
