"use client";
import * as React from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ListOrdered,
  Pencil,
  Send,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * A queued prompt waiting to be sent once the current stream completes.
 *
 * The component is intentionally generic over the per-item payload: the
 * composer attaches an opaque `id` and the user-visible `content`, and keeps
 * the model snapshot in its own parallel state. MessageQueue only ever needs
 * `id` + `content` to render, reorder, edit, and remove rows.
 */
export interface QueuedItem {
  /** Stable identity used as the React key and for edit/remove/reorder ops. */
  id: string;
  /** The text content the user typed while a stream was in flight. */
  content: string;
}

/**
 * Claude-Code-style queue panel.
 *
 * Renders the pending prompts as an ordered, vertical list (not just a count)
 * with per-row controls to:
 *   - reorder (move up / move down),
 *   - edit the content inline,
 *   - remove the item,
 *   - send it now (jump the queue — promote to the front and drain immediately).
 *
 * Fully keyboard-accessible: every control is a real <button> with an
 * aria-label, the list is an ordered <ol>, and inline edit is a labelled
 * textarea that commits on Enter / blur and cancels on Escape.
 */
export function MessageQueue({
  items,
  isStreaming,
  onRemove,
  onReorder,
  onEdit,
  onSendNow,
}: {
  items: QueuedItem[];
  /** Whether a stream is currently in flight (drives the header copy). */
  isStreaming: boolean;
  /** Remove the item with the given id from the queue. */
  onRemove: (id: string) => void;
  /** Move the item at `index` in the given direction (clamped at the ends). */
  onReorder: (index: number, direction: "up" | "down") => void;
  /** Commit edited content for the item with the given id. */
  onEdit: (id: string, content: string) => void;
  /**
   * Promote the item to the front of the queue so it drains first. When the
   * current turn has already finished (no stream in flight) the parent drains
   * immediately; otherwise it waits for the active turn to complete.
   */
  onSendNow: (id: string) => void;
}) {
  // Which row (if any) is being edited inline, plus its draft text.
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState("");
  const editRef = React.useRef<HTMLTextAreaElement>(null);

  // Focus the textarea when an edit begins.
  React.useEffect(() => {
    if (editingId !== null) editRef.current?.focus();
  }, [editingId]);

  if (items.length === 0) return null;

  const beginEdit = (item: QueuedItem) => {
    setEditingId(item.id);
    setDraft(item.content);
  };

  const commitEdit = () => {
    if (editingId === null) return;
    const trimmed = draft.trim();
    // Empty edit removes the item — matches Claude Code (clearing a queued
    // prompt drops it) and avoids leaving a blank, un-sendable row.
    if (trimmed.length === 0) {
      onRemove(editingId);
    } else {
      onEdit(editingId, trimmed);
    }
    setEditingId(null);
    setDraft("");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraft("");
  };

  return (
    <section
      aria-label="Queued messages"
      className="flex flex-col gap-1.5 rounded-xl border border-border bg-muted/30 p-2"
    >
      <header className="flex items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground">
        <ListOrdered className="h-3.5 w-3.5" />
        <span>
          {items.length} {items.length === 1 ? "message" : "messages"} queued
        </span>
        <span className="ml-auto font-normal text-muted-foreground/70">
          {isStreaming ? "Sends when this turn finishes" : "Draining…"}
        </span>
      </header>

      <ol className="flex flex-col gap-1">
        {items.map((item, idx) => {
          const isEditing = editingId === item.id;
          return (
            <li
              key={item.id}
              className="flex items-start gap-1.5 rounded-lg border border-border bg-card px-2 py-1.5 text-sm"
            >
              {/* Position badge */}
              <span
                aria-hidden="true"
                className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium tabular-nums text-muted-foreground"
              >
                {idx + 1}
              </span>

              {isEditing ? (
                <textarea
                  ref={editRef}
                  aria-label={`Edit queued message ${idx + 1}`}
                  value={draft}
                  rows={2}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitEdit}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      commitEdit();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      cancelEdit();
                    }
                  }}
                  className="min-w-0 flex-1 resize-none rounded-md border border-input bg-background px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              ) : (
                <button
                  type="button"
                  aria-label={`Edit queued message ${idx + 1}: ${item.content}`}
                  onClick={() => beginEdit(item)}
                  className="min-w-0 flex-1 truncate text-left text-foreground hover:text-foreground/80"
                  title={item.content}
                >
                  {item.content}
                </button>
              )}

              {/* Row controls — hidden while editing to keep the row focused. */}
              {!isEditing ? (
                <div className="flex shrink-0 items-center gap-0.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Send queued message ${idx + 1} now`}
                    onClick={() => onSendNow(item.id)}
                    className="h-6 w-6 p-0"
                  >
                    <Send className="h-3 w-3" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Edit queued message ${idx + 1}`}
                    onClick={() => beginEdit(item)}
                    className="h-6 w-6 p-0"
                  >
                    <Pencil className="h-3 w-3" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Move queued message ${idx + 1} up`}
                    disabled={idx === 0}
                    onClick={() => onReorder(idx, "up")}
                    className="h-6 w-6 p-0"
                  >
                    <ArrowUp className="h-3 w-3" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Move queued message ${idx + 1} down`}
                    disabled={idx === items.length - 1}
                    onClick={() => onReorder(idx, "down")}
                    className="h-6 w-6 p-0"
                  >
                    <ArrowDown className="h-3 w-3" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove queued message ${idx + 1}`}
                    onClick={() => onRemove(item.id)}
                    className="h-6 w-6 p-0"
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              ) : (
                <div className="flex shrink-0 items-center gap-0.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Save queued message ${idx + 1}`}
                    // preventDefault on mousedown keeps focus in the textarea so
                    // its onBlur doesn't fire (and double-commit) before onClick.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={commitEdit}
                    className={cn("h-6 w-6 p-0 text-primary")}
                  >
                    <Check className="h-3 w-3" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Cancel editing queued message ${idx + 1}`}
                    // preventDefault on mousedown stops the textarea from blurring
                    // (which would commit) before the cancel click is handled.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={cancelEdit}
                    className="h-6 w-6 p-0"
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
