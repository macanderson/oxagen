"use client";

/**
 * sandboxes-client.tsx — the Workbench → Sandboxes list.
 *
 * Redesigned for calm: creation lives behind a single "New sandbox" primary
 * action (see sandbox-create-dialog.tsx) instead of an always-open form, and
 * each session is one compact row — name + status first, everything else demoted
 * to a single muted metadata line — so the list reads as a list, not a wall of
 * chips.
 *
 * Two truthfulness rules still drive it: (1) a sandbox's user-assigned name is
 * its primary on-screen label — the sbx_ id is never the headline (an unlabeled
 * session reads as "Untitled sandbox"); (2) the default view shows ONLY sessions
 * the provider currently agrees are running/idle — an Active / All segmented
 * filter opts into the full history. A ~8s visibility-paused poll keeps the list
 * truthful without a manual refresh, and every mutation re-polls immediately.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Boxes, GitBranch, Pencil, Plus, Square } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusDot } from "@/components/ui/status-dot";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/segmented-control";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogPanel,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { workspace } from "@/lib/routes";
import type { SandboxSummary, SandboxStatus } from "@/lib/workbench/sandboxes";
import type { RepoOption } from "@/components/chat/repo-selector";
import type { SandboxTemplateSummary } from "./sandbox-template-actions";
import { SandboxCreateDialog } from "./sandbox-create-dialog";
import {
  stopSandboxAction,
  renameSandboxAction,
  refreshSandboxesAction,
} from "./actions";

/** StatusDot tone per provider state; running pulses to read as "live". */
const STATUS_DOT: Record<
  SandboxStatus,
  "success" | "warning" | "error" | "info" | "neutral" | "primary"
> = {
  running: "success",
  idle: "warning",
  stopped: "neutral",
  gone: "neutral",
};

const POLL_MS = 8_000;

/** Sessions the provider currently agrees are live — everything else is "inactive". */
function isActiveStatus(status: SandboxStatus): boolean {
  return status === "running" || status === "idle";
}

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86_400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86_400)}d ago`;
}

export interface SandboxesClientProps {
  orgSlug: string;
  workspaceSlug: string;
  initialSandboxes: SandboxSummary[];
  canManage: boolean;
  unavailable: boolean;
  /** Saved sandbox templates (Settings → Environments), selectable in the create flow. */
  templates: SandboxTemplateSummary[];
  /** The workspace's usable GitHub repos, for the create flow's repo picker. */
  repoOptions: RepoOption[];
}

export function SandboxesClient({
  orgSlug,
  workspaceSlug,
  initialSandboxes,
  canManage,
  unavailable,
  templates,
  repoOptions,
}: SandboxesClientProps) {
  const router = useRouter();
  const scope = useMemo(
    () => ({ orgSlug, workspaceSlug }),
    [orgSlug, workspaceSlug],
  );

  // ── Create dialog ───────────────────────────────────────────────────────────
  const [creating, setCreating] = useState(false);

  // ── Session list — truthful (default active-only) + live-tail poll ──────────
  const [sandboxes, setSandboxes] = useState<SandboxSummary[]>(() =>
    initialSandboxes.filter((s) => isActiveStatus(s.status)),
  );
  const [filter, setFilter] = useState<"active" | "all">("active");
  const [listError, setListError] = useState<string | null>(null);
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  const showInactive = filter === "all";

  const refresh = useCallback(
    async (activeOnly: boolean) => {
      try {
        const res = await refreshSandboxesAction({ ...scope, activeOnly });
        if (res.ok) {
          setSandboxes(res.sandboxes);
          setListError(null);
        } else {
          setListError(res.error);
        }
      } catch (err) {
        // A transient poll failure should never crash the surface — the list
        // just stays at its last-known-good state until the next success.
        console.error("sandboxes: refresh failed", err);
      }
    },
    [scope],
  );

  useEffect(() => {
    void refresh(!showInactive);
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void refresh(!showInactive);
    }, POLL_MS);
    return () => clearInterval(id);
  }, [refresh, showInactive]);

  // ── Rename dialog ────────────────────────────────────────────────────────────
  const [renameTarget, setRenameTarget] = useState<SandboxSummary | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renamePending, setRenamePending] = useState(false);

  const openRename = (s: SandboxSummary) => {
    setRenameTarget(s);
    setRenameValue(s.label ?? "");
    setRenameError(null);
  };

  const submitRename = async () => {
    if (!renameTarget) return;
    const label = renameValue.trim();
    if (!label) {
      setRenameError("Name your sandbox.");
      return;
    }
    setRenamePending(true);
    const res = await renameSandboxAction({
      ...scope,
      sessionId: renameTarget.sessionId,
      label,
    });
    setRenamePending(false);
    if (res.ok) {
      setRenameTarget(null);
      await refresh(!showInactive);
    } else {
      setRenameError(res.error);
    }
  };

  const onStop = async (sessionId: string) => {
    setStoppingId(sessionId);
    const res = await stopSandboxAction({ ...scope, sessionId });
    setStoppingId(null);
    if (res.ok) {
      await refresh(!showInactive);
    } else {
      setListError(res.error);
    }
  };

  const onWarmed = (sessionId: string) => {
    setCreating(false);
    router.push(workspace.workbench.sandbox(scope, sessionId));
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-baseline gap-2 text-lg font-semibold">
          Sessions
          {sandboxes.length > 0 ? (
            <span className="text-sm font-normal tabular-nums text-muted-foreground">
              {sandboxes.length}
            </span>
          ) : null}
        </h2>
        <div className="flex items-center gap-2">
          <SegmentedControl
            value={filter}
            onValueChange={(v) => setFilter(v === "all" ? "all" : "active")}
            aria-label="Filter sandboxes"
          >
            <SegmentedControlItem value="active">Active</SegmentedControlItem>
            <SegmentedControlItem value="all">All</SegmentedControlItem>
          </SegmentedControl>
          {canManage ? (
            <Button
              type="button"
              size="sm"
              onClick={() => setCreating(true)}
              className="gap-1"
              data-testid="sandbox-new"
            >
              <Plus className="h-4 w-4" aria-hidden />
              New sandbox
            </Button>
          ) : null}
        </div>
      </div>

      {listError ? (
        <p role="alert" className="text-sm text-error">
          {listError}
        </p>
      ) : null}

      {sandboxes.length === 0 ? (
        <EmptyState
          variant="dashed"
          icon={<Boxes />}
          title={
            showInactive ? "No sandbox sessions yet" : "No active sandboxes"
          }
          description={
            canManage
              ? "Warm one to give an agent a ready workspace — its terminal, files, and packages live here."
              : "No sandboxes are running in this workspace right now."
          }
          action={
            canManage ? (
              <Button
                type="button"
                size="sm"
                onClick={() => setCreating(true)}
                className="gap-1"
              >
                <Plus className="h-4 w-4" aria-hidden />
                New sandbox
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {sandboxes.map((s) => {
            const active = isActiveStatus(s.status);
            const repoCount = s.repos?.length ?? 0;
            return (
              <li
                key={s.sessionId}
                data-status={s.status}
                className="group flex items-center gap-3 rounded-xl border border-border bg-background p-3.5 transition-colors hover:border-ring hover:bg-muted/20"
              >
                <StatusDot
                  status={STATUS_DOT[s.status]}
                  pulse={s.status === "running"}
                  size="sm"
                  label={s.status}
                  className="shrink-0"
                />
                <Link
                  href={workspace.workbench.sandbox(scope, s.sessionId)}
                  className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="flex items-center gap-2">
                    <span
                      className={
                        "truncate text-sm font-medium " +
                        (active ? "text-foreground" : "text-muted-foreground")
                      }
                    >
                      {s.label ?? "Untitled sandbox"}
                    </span>
                    {s.recoveryStatus === "failed" ? (
                      <Badge variant="error" size="sm" className="shrink-0">
                        recovery failed
                      </Badge>
                    ) : null}
                  </span>
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                    <span className="capitalize">{s.status}</span>
                    <span aria-hidden>·</span>
                    <span className="font-mono">{s.image}</span>
                    <span aria-hidden>·</span>
                    <span>{relativeTime(s.lastUsedAt)}</span>
                    {repoCount > 0 ? (
                      <>
                        <span aria-hidden>·</span>
                        <span className="inline-flex items-center gap-1">
                          <GitBranch className="h-3 w-3" aria-hidden />
                          {repoCount} repo{repoCount === 1 ? "" : "s"}
                        </span>
                      </>
                    ) : null}
                  </span>
                </Link>
                {canManage ? (
                  <div className="flex shrink-0 items-center gap-0.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Rename sandbox"
                      onClick={() => openRename(s)}
                    >
                      <Pencil className="size-3.5" aria-hidden />
                    </Button>
                    {active ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Stop sandbox"
                        onClick={() => void onStop(s.sessionId)}
                        disabled={stoppingId === s.sessionId}
                      >
                        <Square className="size-3.5" aria-hidden />
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {/* Create flow */}
      <SandboxCreateDialog
        open={creating}
        onOpenChange={setCreating}
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        canManage={canManage}
        unavailable={unavailable}
        templates={templates}
        repoOptions={repoOptions}
        onWarmed={onWarmed}
      />

      {/* Rename dialog */}
      <Dialog
        open={renameTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Rename sandbox</DialogTitle>
            <DialogDescription>
              This is the name shown in the list — it doesn&apos;t need to be
              unique.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Label htmlFor="sandbox-rename-input">Name</Label>
            <Input
              id="sandbox-rename-input"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              maxLength={80}
              autoComplete="off"
              onKeyDown={(e) => {
                if (e.key === "Enter") void submitRename();
              }}
            />
            {renameError ? (
              <p role="alert" className="text-sm text-error">
                {renameError}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setRenameTarget(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void submitRename()}
              disabled={renamePending || renameValue.trim().length === 0}
            >
              {renamePending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

export default SandboxesClient;
