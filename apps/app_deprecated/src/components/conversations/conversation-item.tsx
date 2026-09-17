"use client";
/**
 * ConversationItem — one row in the history nav.
 *
 * Opening the per-row action menu (rename / archive / delete) is bound to the
 * platform-idiomatic gestures: long-press on touch (useLongPress), double-click
 * and right-click on desktop. An always-visible "⋯" button exposes the same
 * menu for discoverability and keyboard/AT users — the gestures are an
 * accelerator, never the only path.
 *
 * Archive / restore fire immediately (reversible). Delete always opens the
 * confirm dialog first (irreversible from the user's view).
 */
import { useState } from "react";
import Link from "next/link";
import {
  MoreHorizontal,
  Pencil,
  Archive,
  ArchiveRestore,
  Trash2,
} from "lucide-react";
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuSeparator,
} from "@/components/ui/menu";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ConversationSummary } from "./types";
import { useLongPress } from "./use-long-press";
import { RenameDialog } from "./rename-dialog";
import { DeleteConfirmDialog } from "./delete-confirm-dialog";

export interface ConversationItemProps {
  conversation: ConversationSummary;
  href: string;
  isActive: boolean;
  onRename: (id: string, title: string) => Promise<void>;
  onArchiveToggle: (id: string, archived: boolean) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

// Compact relative time for the row subtitle. Coarse buckets are enough here —
// the nav is a glanceable index, not a precise timeline.
function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function ConversationItem({
  conversation,
  href,
  isActive,
  onRename,
  onArchiveToggle,
  onDelete,
}: ConversationItemProps) {
  const archived = conversation.archivedAt != null;
  const title = conversation.title?.trim() || "No session";

  const [menuOpen, setMenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [renamePending, setRenamePending] = useState(false);
  const [deletePending, setDeletePending] = useState(false);

  const { handlers, firedRef } = useLongPress(() => setMenuOpen(true));

  async function handleRename(value: string) {
    setRenamePending(true);
    try {
      await onRename(conversation.publicId, value);
      setRenameOpen(false);
    } finally {
      setRenamePending(false);
    }
  }

  async function handleDelete() {
    setDeletePending(true);
    try {
      await onDelete(conversation.publicId);
      setDeleteOpen(false);
    } finally {
      setDeletePending(false);
    }
  }

  return (
    <>
      <div
        className={cn(
          "group/item relative flex items-center rounded-md text-sm transition-all border",
          isActive
            ? "bg-accent border-border text-foreground"
            : "border-transparent hover:bg-muted",
        )}
      >
        <Link
          href={href}
          {...handlers}
          onClickCapture={(e) => {
            // Swallow the click touch devices emit on pointer-up after a
            // long-press, so opening the menu doesn't also navigate the row.
            if (firedRef.current) {
              e.preventDefault();
              e.stopPropagation();
              firedRef.current = false;
            }
          }}
          onDoubleClick={(e) => {
            e.preventDefault();
            setMenuOpen(true);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenuOpen(true);
          }}
          className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-md px-2.5 py-2 pr-8 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="truncate font-medium leading-tight">{title}</span>
          <span className="truncate text-xs text-muted-foreground">
            {formatRelative(conversation.updatedAt)}
          </span>
        </Link>

        <Menu open={menuOpen} onOpenChange={setMenuOpen}>
          <MenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Actions for ${title}`}
                className={cn(
                  "absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground",
                  // Always reachable, but only visually surfaces on hover/focus
                  // or while its menu is open — keeps the resting list clean.
                  "opacity-0 focus-visible:opacity-100 group-hover/item:opacity-100",
                  menuOpen && "opacity-100",
                )}
              />
            }
          >
            <MoreHorizontal className="size-4" />
          </MenuTrigger>
          <MenuPopup align="end" className="w-44">
            <MenuItem onClick={() => setRenameOpen(true)}>
              <Pencil className="size-4" />
              Rename
            </MenuItem>
            <MenuItem
              onClick={() =>
                void onArchiveToggle(conversation.publicId, !archived)
              }
            >
              {archived ? (
                <>
                  <ArchiveRestore className="size-4" />
                  Restore
                </>
              ) : (
                <>
                  <Archive className="size-4" />
                  Archive
                </>
              )}
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              onClick={() => setDeleteOpen(true)}
              className="text-destructive data-[highlighted]:text-destructive"
            >
              <Trash2 className="size-4" />
              Delete
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>

      <RenameDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        initialTitle={conversation.title?.trim() ?? ""}
        pending={renamePending}
        onSubmit={handleRename}
      />
      <DeleteConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete conversation?"
        description="This conversation will be permanently removed from your history and can’t be restored."
        pending={deletePending}
        onConfirm={handleDelete}
      />
    </>
  );
}
