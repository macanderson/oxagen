"use client";

/**
 * sandbox-detail-client.tsx — the terminal + files + state/logs for one sandbox.
 *
 * The terminal is the hero: full content width, wired to a run_sandbox_command
 * server action (unwrapped so a failed action surfaces as a terminal error
 * entry). Files live in a right-side drawer (SandboxFilesDrawer) backed by
 * direct capability invokes — no cross-service fetch. The state panel and log
 * console sit below the terminal.
 *
 * Identity: the header shows the sandbox's human LABEL (never the raw sbx_ id as
 * the title — a UUID is meaningless to a user), with the id as a small copyable
 * chip and a live status badge. The label is inline-editable via rename_sandbox.
 */

import {
  useCallback,
  useState,
  useTransition,
  type KeyboardEvent,
} from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Check, Pencil, Square, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CopyableId } from "@/components/knowledge/graph-explorer/copyable-id";
import { workspace } from "@/lib/routes";
import {
  SandboxTerminal,
  type RunCommandFn,
} from "@/components/sandbox/sandbox-terminal";
import {
  SandboxFilesDrawer,
  type ListSandboxFilesFn,
  type ReadSandboxFileFn,
} from "@/components/sandbox/sandbox-files-drawer";
import { SandboxEnvPanel } from "@/components/sandbox/sandbox-env-panel";
import type { SandboxSummary, SandboxStatus } from "@/lib/workbench/sandboxes";
import {
  listSandboxLogsAction,
  runSandboxCommandAction,
  stopSandboxAction,
} from "../actions";
import {
  listSandboxFilesAction,
  readSandboxFileAction,
  renameSandboxAction,
} from "./actions";
import { SandboxStatePanel } from "./sandbox-state-panel";
import { SandboxLogsConsole, type LoadLogsFn } from "./sandbox-logs-console";

const STATUS_TONE: Record<SandboxStatus, "success" | "warning" | "secondary"> =
  {
    running: "success",
    idle: "warning",
    stopped: "secondary",
    gone: "secondary",
  };

/**
 * The canonical workspace root inside every durable sandbox — mirrors
 * `WORKSPACE_ROOT` in `@oxagen/sandbox` (a server-only module). The terminal is
 * seeded here so a first `ls` lands where cloned repos + the warm scaffold live
 * and where the file browser lists; keep the two in lockstep.
 */
const WORKSPACE_ROOT = "/work";

export interface SandboxDetailClientProps {
  orgSlug: string;
  workspaceSlug: string;
  sessionId: string;
  summary: SandboxSummary;
  canManage: boolean;
}

export function SandboxDetailClient({
  orgSlug,
  workspaceSlug,
  sessionId,
  summary,
  canManage,
}: SandboxDetailClientProps) {
  const router = useRouter();
  const [stopping, startStop] = useTransition();
  const [stopError, setStopError] = useState<string | null>(null);

  // Inline rename state.
  const [editing, setEditing] = useState(false);
  const [nameInput, setNameInput] = useState(summary.label ?? "");
  const [renaming, startRename] = useTransition();
  const [renameError, setRenameError] = useState<string | null>(null);

  // Bumped after every command so the files drawer re-reads the sandbox — a
  // `mkdir`/`rm`/clone in the terminal shows up immediately (drives the drawer's
  // refreshSignal) instead of waiting for a manual refresh.
  const [filesRefresh, setFilesRefresh] = useState(0);

  const runCommand: RunCommandFn = useCallback(
    async (command, opts) => {
      const res = await runSandboxCommandAction({
        orgSlug,
        workspaceSlug,
        sessionId,
        command,
        cwd: opts?.cwd,
      });
      if (!res.ok) throw new Error(res.error);
      // The command may have mutated the filesystem; nudge the file tree.
      setFilesRefresh((n) => n + 1);
      return res.result;
    },
    [orgSlug, workspaceSlug, sessionId],
  );

  const listFiles: ListSandboxFilesFn = useCallback(
    async ({ path, depth }) => {
      const res = await listSandboxFilesAction({
        orgSlug,
        workspaceSlug,
        sessionId,
        path,
        depth,
      });
      if (!res.ok) throw new Error(res.error);
      return res.entries;
    },
    [orgSlug, workspaceSlug, sessionId],
  );

  const readFile: ReadSandboxFileFn = useCallback(
    async (path) => {
      const res = await readSandboxFileAction({
        orgSlug,
        workspaceSlug,
        sessionId,
        path,
      });
      if (!res.ok) throw new Error(res.error);
      return res.file;
    },
    [orgSlug, workspaceSlug, sessionId],
  );

  const loadLogs: LoadLogsFn = useCallback(
    async ({ level, limit }) => {
      const res = await listSandboxLogsAction({
        orgSlug,
        workspaceSlug,
        sessionId,
        level,
        limit,
      });
      if (!res.ok) throw new Error(res.error);
      return res.lines;
    },
    [orgSlug, workspaceSlug, sessionId],
  );

  const onStop = () => {
    setStopError(null);
    startStop(async () => {
      const res = await stopSandboxAction({
        orgSlug,
        workspaceSlug,
        sessionId,
      });
      if (res.ok) {
        // A stopped sandbox disappears from the UI by design — return to the list.
        router.push(workspace.workbench.sandboxes({ orgSlug, workspaceSlug }));
        return;
      }
      setStopError(res.error);
    });
  };

  const startEditing = () => {
    setRenameError(null);
    setNameInput(summary.label ?? "");
    setEditing(true);
  };

  const submitRename = () => {
    const label = nameInput.trim();
    if (label.length === 0) {
      setRenameError("Name your sandbox.");
      return;
    }
    if (label === (summary.label ?? "")) {
      setEditing(false);
      return;
    }
    setRenameError(null);
    startRename(async () => {
      const res = await renameSandboxAction({
        orgSlug,
        workspaceSlug,
        sessionId,
        label,
      });
      if (res.ok) {
        setEditing(false);
        router.refresh();
        return;
      }
      setRenameError(res.error);
    });
  };

  const onRenameKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submitRename();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setEditing(false);
      setRenameError(null);
    }
  };

  const runnable =
    canManage && summary.status !== "stopped" && summary.status !== "gone";
  const stoppable =
    canManage && summary.status !== "stopped" && summary.status !== "gone";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <Link
            href={workspace.workbench.sandboxes({ orgSlug, workspaceSlug })}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
            All sandboxes
          </Link>

          {editing ? (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <Input
                  autoFocus
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  onKeyDown={onRenameKeyDown}
                  maxLength={80}
                  aria-label="Sandbox name"
                  data-testid="sandbox-rename-input"
                  className="h-8 w-64 text-sm"
                  disabled={renaming}
                />
                <Button
                  type="button"
                  size="icon"
                  variant="default"
                  className="size-8"
                  onClick={submitRename}
                  disabled={renaming}
                  aria-label="Save name"
                  data-testid="sandbox-rename-save"
                >
                  <Check className="h-4 w-4" aria-hidden />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-8"
                  onClick={() => {
                    setEditing(false);
                    setRenameError(null);
                  }}
                  disabled={renaming}
                  aria-label="Cancel rename"
                >
                  <X className="h-4 w-4" aria-hidden />
                </Button>
              </div>
              {renameError ? (
                <p role="alert" className="text-xs text-error">
                  {renameError}
                </p>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {summary.label ? (
                <h1 className="truncate text-lg font-semibold text-foreground">
                  {summary.label}
                </h1>
              ) : (
                <h1 className="text-lg font-semibold italic text-muted-foreground">
                  Untitled sandbox
                </h1>
              )}
              <Badge variant={STATUS_TONE[summary.status]}>
                {summary.status}
              </Badge>
              {canManage ? (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-7 text-muted-foreground"
                  onClick={startEditing}
                  aria-label="Rename sandbox"
                  data-testid="sandbox-rename-open"
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden />
                </Button>
              ) : null}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <CopyableId value={sessionId} label="ID" max={18} />
            <span className="font-mono text-xs text-muted-foreground">
              {summary.image}
            </span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <SandboxFilesDrawer
            sessionId={sessionId}
            status={summary.status}
            listFiles={listFiles}
            readFile={readFile}
            refreshSignal={filesRefresh}
            disabled={!canManage}
          />
          {stoppable ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onStop}
              disabled={stopping}
            >
              <Square className="h-3.5 w-3.5" aria-hidden />
              {stopping ? "Stopping…" : "Stop"}
            </Button>
          ) : null}
        </div>
      </div>

      {stopError ? (
        <p role="alert" className="text-sm text-error">
          {stopError}
        </p>
      ) : null}

      {/* Attribute bar — the top full-width row: status / image / driver /
          started / reap at a glance, above everything else. */}
      <SandboxStatePanel summary={summary} />

      {/* Workbench: terminal (5/8) on the left, the environment + logs rail
          (3/8) on the right at lg+; everything stacks to one column on mobile. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-8 lg:items-start">
        {/* Terminal — the hero, 5/8 on the left. */}
        <section className="flex min-w-0 flex-col gap-2 lg:col-span-5">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-sm font-semibold">Terminal</h2>
            <p className="text-xs text-muted-foreground">
              The shell an agent drives — run commands directly against this
              sandbox and watch the CLI output.
            </p>
          </div>
          <SandboxTerminal
            sessionId={sessionId}
            runCommand={runCommand}
            initialCwd={WORKSPACE_ROOT}
            disabled={!runnable}
            welcome={
              runnable
                ? undefined
                : "This sandbox isn't runnable (stopped or you lack manage rights). Open Files to browse the workspace."
            }
          />
        </section>

        {/* Right rail — environment + logs, 3/8 on the right. */}
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-3">
          <SandboxEnvPanel
            image={summary.image}
            runCommand={runCommand}
            disabled={!runnable}
          />

          <section className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-col gap-0.5">
              <h2 className="text-sm font-semibold">Logs</h2>
              <p className="text-xs text-muted-foreground">
                Captured output — flip Debug for command echoes, timings, and
                lifecycle notes.
              </p>
            </div>
            <SandboxLogsConsole
              sessionId={sessionId}
              loadLogs={loadLogs}
              disabled={!canManage}
            />
          </section>
        </div>
      </div>
    </div>
  );
}

export default SandboxDetailClient;
