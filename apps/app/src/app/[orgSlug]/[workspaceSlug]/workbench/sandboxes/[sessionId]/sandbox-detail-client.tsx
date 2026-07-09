"use client";

/**
 * sandbox-detail-client.tsx — the terminal + file browser for one sandbox.
 *
 * Left: the interactive SandboxTerminal, its runner wired to a
 * run_sandbox_command server action (unwrapped so a failed action surfaces as a
 * terminal error entry). Right: the WorkspaceContextPanel — the existing sandbox
 * file inspector (lazy tree via agent.sandbox_file.list + tap-to-open viewer via
 * agent.sandbox_file.read). Both panes stack on mobile and sit side-by-side on
 * large screens (reflow, no hidden content).
 */

import { useCallback, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Square } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { workspace } from "@/lib/routes";
import {
  SandboxTerminal,
  type RunCommandFn,
} from "@/components/sandbox/sandbox-terminal";
import WorkspaceContextPanel from "@/components/chat/registry-components/workspace-context-panel";
import type { SandboxSummary, SandboxStatus } from "@/lib/workbench/sandboxes";
import { runSandboxCommandAction, stopSandboxAction } from "../actions";

const STATUS_TONE: Record<SandboxStatus, "success" | "warning" | "secondary"> = {
  running: "success",
  idle: "warning",
  stopped: "secondary",
  gone: "secondary",
};

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

  const runCommand: RunCommandFn = useCallback(
    async (command) => {
      const res = await runSandboxCommandAction({
        orgSlug,
        workspaceSlug,
        sessionId,
        command,
      });
      if (!res.ok) throw new Error(res.error);
      return res.result;
    },
    [orgSlug, workspaceSlug, sessionId],
  );

  const onStop = () => {
    setStopError(null);
    startStop(async () => {
      const res = await stopSandboxAction({ orgSlug, workspaceSlug, sessionId });
      if (res.ok) {
        router.refresh();
        return;
      }
      setStopError(res.error);
    });
  };

  const runnable = canManage && summary.status !== "stopped" && summary.status !== "gone";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <Link
            href={workspace.workbench.sandboxes({ orgSlug, workspaceSlug })}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
            All sandboxes
          </Link>
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm">{sessionId}</span>
            <Badge variant={STATUS_TONE[summary.status]}>{summary.status}</Badge>
            <span className="text-xs text-muted-foreground">{summary.image}</span>
          </div>
        </div>
        {canManage && summary.status !== "stopped" && summary.status !== "gone" ? (
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

      {stopError ? (
        <p role="alert" className="text-sm text-error">
          {stopError}
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Terminal</h3>
          <p className="text-xs text-muted-foreground">
            The shell an agent drives — run commands directly against this
            sandbox and watch the CLI output.
          </p>
          <SandboxTerminal
            sessionId={sessionId}
            runCommand={runCommand}
            disabled={!runnable}
            welcome={
              runnable
                ? undefined
                : "This sandbox isn't runnable (stopped or you lack manage rights). Files remain browsable."
            }
          />
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Files</h3>
          <p className="text-xs text-muted-foreground">
            Inspect the sandbox filesystem — expand directories and tap a file to
            view its contents.
          </p>
          <WorkspaceContextPanel
            sessionId={sessionId}
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
            title="Sandbox files"
          />
        </div>
      </div>
    </div>
  );
}

export default SandboxDetailClient;
