"use client";
/**
 * ConversationList — the body of the history nav: a "New conversation" action,
 * the active conversations, and a collapsible "Archived" section with a
 * "Delete all" (purge) action. Rendered identically inside the desktop aside
 * and the mobile Sheet (ConversationNav owns the chrome).
 *
 * State model: server-rendered `initialActive` seeds local state and reseeds
 * whenever the server data changes (so a conversation created from the composer
 * appears here after revalidation). Mutations update local state optimistically
 * for instant feedback, then run the action — which revalidates the page — so
 * the server stays the source of truth. Archived rows are loaded lazily on the
 * client the first time the section opens.
 */
import { useCallback, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { Plus, ChevronRight, ChevronDown, Trash2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { ConversationItem } from "./conversation-item";
import { DeleteConfirmDialog } from "./delete-confirm-dialog";
import type { ConversationNavActions, ConversationSummary } from "./types";

export interface ConversationListProps {
  currentPublicId: string | null;
  initialActive: ConversationSummary[];
  initialActiveNextCursor: string | null;
  actions: ConversationNavActions;
  /** Called after a navigation so the mobile Sheet can close itself. */
  onNavigate?: () => void;
}

function removeById(list: ConversationSummary[], id: string) {
  return list.filter((c) => c.publicId !== id);
}

export function ConversationList({
  currentPublicId,
  initialActive,
  initialActiveNextCursor,
  actions,
  onNavigate,
}: ConversationListProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { add: toast } = useToast();

  const [active, setActive] = useState(initialActive);
  const [activeCursor, setActiveCursor] = useState(initialActiveNextCursor);
  const [loadingMore, setLoadingMore] = useState(false);

  const [archivedOpen, setArchivedOpen] = useState(false);
  const [archived, setArchived] = useState<ConversationSummary[] | null>(null);
  const [archivedCursor, setArchivedCursor] = useState<string | null>(null);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [purgePending, setPurgePending] = useState(false);

  // Reseed from the server whenever its active set changes (post-revalidation,
  // or a new conversation arriving from the composer). Keyed on id+updatedAt so
  // an identity-only prop change doesn't clobber optimistic state. This is the
  // "adjust state during render" pattern (react.dev) — not an effect — so it
  // settles before paint and satisfies the React Compiler lint.
  const serverKey = initialActive
    .map((c) => `${c.publicId}:${c.updatedAt}`)
    .join("|");
  const [seededKey, setSeededKey] = useState(serverKey);
  if (serverKey !== seededKey) {
    setSeededKey(serverKey);
    setActive(initialActive);
    setActiveCursor(initialActiveNextCursor);
  }

  const hrefFor = useCallback(
    (id: string) => `${pathname}?c=${id}`,
    [pathname],
  );

  // When the open conversation leaves the active list (archived or deleted),
  // route to the newest remaining one, or a fresh new-conversation state.
  const routeAwayIfOpen = useCallback(
    (ids: string[], remaining: ConversationSummary[]) => {
      if (currentPublicId && ids.includes(currentPublicId)) {
        const next = remaining[0];
        router.push(next ? hrefFor(next.publicId) : pathname);
        onNavigate?.();
      }
    },
    [currentPublicId, hrefFor, pathname, router, onNavigate],
  );

  const newConversation = useCallback(() => {
    // `?new=1` signals the server to render a blank slate even if active
    // conversations exist (without it, the page auto-resumes the most recent).
    // router.refresh() ensures the list reflects conversations created during
    // the previous session but not yet visible.
    router.push(`${pathname}?new=1`);
    router.refresh();
    onNavigate?.();
  }, [pathname, router, onNavigate]);

  const loadMoreActive = useCallback(async () => {
    if (!activeCursor || loadingMore) return;
    setLoadingMore(true);
    const res = await actions.list({ filter: "active", cursor: activeCursor });
    setLoadingMore(false);
    if (!res.ok) {
      toast({
        title: "Couldn’t load more",
        description: res.error,
        type: "error",
      });
      return;
    }
    setActive((prev) => [...prev, ...res.conversations]);
    setActiveCursor(res.nextCursor);
  }, [actions, activeCursor, loadingMore, toast]);

  const toggleArchived = useCallback(async () => {
    const next = !archivedOpen;
    setArchivedOpen(next);
    if (next && archived === null) {
      setArchivedLoading(true);
      const res = await actions.list({ filter: "archived" });
      setArchivedLoading(false);
      if (!res.ok) {
        toast({
          title: "Couldn’t load archived",
          description: res.error,
          type: "error",
        });
        setArchived([]);
        return;
      }
      setArchived(res.conversations);
      setArchivedCursor(res.nextCursor);
    }
  }, [actions, archived, archivedOpen, toast]);

  const loadMoreArchived = useCallback(async () => {
    if (!archivedCursor || archivedLoading) return;
    setArchivedLoading(true);
    const res = await actions.list({
      filter: "archived",
      cursor: archivedCursor,
    });
    setArchivedLoading(false);
    if (!res.ok) {
      toast({
        title: "Couldn’t load archived",
        description: res.error,
        type: "error",
      });
      return;
    }
    setArchived((prev) => [...(prev ?? []), ...res.conversations]);
    setArchivedCursor(res.nextCursor);
  }, [actions, archivedCursor, archivedLoading, toast]);

  // ── Per-row mutations (passed down to ConversationItem) ──────────────────

  const handleRename = useCallback(
    async (id: string, title: string) => {
      // Optimistic title swap in whichever list holds the row.
      const patch = (c: ConversationSummary) =>
        c.publicId === id ? { ...c, title } : c;
      setActive((prev) => prev.map(patch));
      setArchived((prev) => (prev ? prev.map(patch) : prev));
      const res = await actions.rename(id, title);
      if (!res.ok) {
        toast({
          title: "Rename failed",
          description: res.error,
          type: "error",
        });
        router.refresh();
      }
    },
    [actions, router, toast],
  );

  const handleArchiveToggle = useCallback(
    async (id: string, archive: boolean) => {
      if (archive) {
        // Active → archived. No confirm: archiving is reversible.
        const row = active.find((c) => c.publicId === id);
        const remaining = removeById(active, id);
        setActive(remaining);
        if (row) {
          const archivedRow = { ...row, archivedAt: new Date().toISOString() };
          setArchived((prev) => (prev ? [archivedRow, ...prev] : prev));
        }
        routeAwayIfOpen([id], remaining);
      } else {
        // Archived → active (restore).
        const row = archived?.find((c) => c.publicId === id);
        setArchived((prev) => (prev ? removeById(prev, id) : prev));
        if (row) {
          const activeRow = { ...row, archivedAt: null };
          setActive((prev) => [activeRow, ...prev]);
        }
      }
      const res = await actions.archive([id], archive);
      if (!res.ok) {
        toast({
          title: "Couldn’t update",
          description: res.error,
          type: "error",
        });
        router.refresh();
      }
    },
    [actions, active, archived, routeAwayIfOpen, router, toast],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      const remaining = removeById(active, id);
      setActive(remaining);
      setArchived((prev) => (prev ? removeById(prev, id) : prev));
      routeAwayIfOpen([id], remaining);
      const res = await actions.delete([id]);
      if (!res.ok) {
        toast({
          title: "Delete failed",
          description: res.error,
          type: "error",
        });
        router.refresh();
      }
    },
    [actions, active, routeAwayIfOpen, router, toast],
  );

  const handlePurge = useCallback(async () => {
    setPurgePending(true);
    const purgedIds = (archived ?? []).map((c) => c.publicId);
    const res = await actions.purge();
    setPurgePending(false);
    setPurgeOpen(false);
    if (!res.ok) {
      toast({
        title: "Couldn’t delete archived",
        description: res.error,
        type: "error",
      });
      return;
    }
    setArchived([]);
    setArchivedCursor(null);
    routeAwayIfOpen(purgedIds, active);
    toast({
      title: `Deleted ${res.count} archived conversation${res.count === 1 ? "" : "s"}`,
    });
  }, [actions, archived, active, routeAwayIfOpen, toast]);

  const archivedCount = archived?.length ?? 0;

  return (
    <div className="flex h-full flex-col">
      <div className="px-2 pb-2">
        <Button
          variant="outline"
          size="sm"
          className="w-full justify-start gap-2"
          onClick={newConversation}
        >
          <Plus className="size-4" />
          No session
        </Button>
      </div>

      <nav
        aria-label="Conversation history"
        className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2"
      >
        {active.length === 0 ? (
          <p className="px-2.5 py-6 text-center text-xs text-muted-foreground">
            No conversations yet. Start one above.
          </p>
        ) : (
          active.map((c) => (
            <ConversationItem
              key={c.publicId}
              conversation={c}
              href={hrefFor(c.publicId)}
              isActive={c.publicId === currentPublicId}
              onRename={handleRename}
              onArchiveToggle={handleArchiveToggle}
              onDelete={handleDelete}
            />
          ))
        )}

        {activeCursor ? (
          <Button
            variant="ghost"
            size="sm"
            className="mt-1 w-full text-muted-foreground"
            onClick={loadMoreActive}
            disabled={loadingMore}
          >
            {loadingMore ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              "Load more"
            )}
          </Button>
        ) : null}

        {/* Archived section */}
        <div className="mt-3 border-t border-border pt-2">
          <div className="flex items-center justify-between gap-1">
            <button
              type="button"
              onClick={toggleArchived}
              aria-expanded={archivedOpen}
              className="flex flex-1 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              {archivedOpen ? (
                <ChevronDown className="size-3.5" />
              ) : (
                <ChevronRight className="size-3.5" />
              )}
              Archived
              {archived !== null ? (
                <span className="text-muted-foreground/70">
                  ({archivedCount})
                </span>
              ) : null}
            </button>
            {archivedOpen && archivedCount > 0 ? (
              <Button
                variant="ghost"
                size="xs"
                className="gap-1 text-destructive data-[highlighted]:text-destructive"
                onClick={() => setPurgeOpen(true)}
              >
                <Trash2 className="size-3.5" />
                Delete all
              </Button>
            ) : null}
          </div>

          {archivedOpen ? (
            <div className="mt-0.5 flex flex-col gap-0.5">
              {archivedLoading && archived === null ? (
                <p className="flex items-center justify-center gap-2 px-2.5 py-4 text-xs text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  Loading…
                </p>
              ) : archivedCount === 0 ? (
                <p className="px-2.5 py-4 text-center text-xs text-muted-foreground">
                  No archived conversations.
                </p>
              ) : (
                archived!.map((c) => (
                  <ConversationItem
                    key={c.publicId}
                    conversation={c}
                    href={hrefFor(c.publicId)}
                    isActive={c.publicId === currentPublicId}
                    onRename={handleRename}
                    onArchiveToggle={handleArchiveToggle}
                    onDelete={handleDelete}
                  />
                ))
              )}
              {archivedCursor ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full text-muted-foreground"
                  onClick={loadMoreArchived}
                  disabled={archivedLoading}
                >
                  {archivedLoading ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    "Load more"
                  )}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </nav>

      <DeleteConfirmDialog
        open={purgeOpen}
        onOpenChange={setPurgeOpen}
        title="Delete all archived?"
        description={`This permanently removes ${archivedCount} archived conversation${
          archivedCount === 1 ? "" : "s"
        } from your history. This can’t be undone.`}
        confirmLabel="Delete all"
        pending={purgePending}
        onConfirm={handlePurge}
      />
    </div>
  );
}
