"use client";
/**
 * child-drawer.tsx — full input/output payload viewer for one subagent child
 * run, plus its siblings (when running) and a "download markdown logfile"
 * action. Opens from a per-child row click in <FleetDetailClient>.
 *
 * Data is lazy: the result payload fetches on open (GET
 * /api/v1/agent/subagent/result); siblings fetch on demand only for a
 * running child, since a completed/failed child has no "parallel conflict"
 * to investigate.
 *
 * The "download markdown logfile" action is genuinely fanout-scoped —
 * get_subagent_logs takes a fanoutId, not a runId, and produces one markdown
 * document covering every child. It's exposed here (per the Fleet spec's
 * "Child detail" bullet) labeled honestly as covering the whole fan-out; the
 * same action also lives in the fan-out detail header for discoverability.
 */
import { useEffect, useState } from "react";
import { Download, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { Drawer } from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";
import { CopyableId } from "@/components/knowledge/graph-explorer/copyable-id";
import { formatBytes } from "@/lib/utils";
import { formatDuration, formatTimestamp } from "@/components/activity/format";
import { runStatusVariant } from "./status";

export interface ChildDrawerRun {
  runId: string;
  capabilityName: string;
  status: string;
  errorReason: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  inputBytes: number;
  outputBytes: number;
  outputPreview: string | null;
}

export interface ChildDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  run: ChildDrawerRun;
  fanoutId: string;
  workspaceId: string;
}

interface SubagentResult {
  runId: string;
  fanoutId: string;
  capabilityName: string;
  status: string;
  summary: string | null;
  input: unknown;
  output: unknown;
  errorReason: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

interface Sibling {
  runId: string;
  capabilityName: string;
  status: string;
  summary: string | null;
  attempts: number;
  errorReason: string | null;
}

function jsonPreview(value: unknown): string {
  if (value === null || value === undefined) return "null";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function ChildDrawer({
  open,
  onOpenChange,
  run,
  fanoutId,
  workspaceId,
}: ChildDrawerProps) {
  const { add: toast } = useToast();
  const [result, setResult] = useState<SubagentResult | null>(null);
  const [resultLoading, setResultLoading] = useState(true);
  const [resultError, setResultError] = useState<string | null>(null);

  const [siblings, setSiblings] = useState<Sibling[] | null>(null);
  const [siblingsLoading, setSiblingsLoading] = useState(false);
  const [siblingsError, setSiblingsError] = useState<string | null>(null);

  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setResultLoading(true);
    setResultError(null);
    fetch(
      `/api/v1/agent/subagent/result?workspaceId=${encodeURIComponent(workspaceId)}&runId=${encodeURIComponent(run.runId)}`,
    )
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load payload (${res.status})`);
        return (await res.json()) as SubagentResult;
      })
      .then((data) => {
        if (!cancelled) setResult(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setResultError(
            err instanceof Error ? err.message : "Failed to load payload.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setResultLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, run.runId, workspaceId]);

  async function loadSiblings() {
    setSiblingsLoading(true);
    setSiblingsError(null);
    try {
      const res = await fetch(
        `/api/v1/agent/subagent/siblings?workspaceId=${encodeURIComponent(workspaceId)}&runId=${encodeURIComponent(run.runId)}`,
      );
      if (!res.ok) throw new Error(`Failed to load siblings (${res.status})`);
      const data = (await res.json()) as { siblings: Sibling[] };
      setSiblings(data.siblings);
    } catch (err) {
      setSiblingsError(
        err instanceof Error ? err.message : "Failed to load siblings.",
      );
    } finally {
      setSiblingsLoading(false);
    }
  }

  async function handleDownloadLogs() {
    setDownloading(true);
    try {
      const res = await fetch("/api/v1/agent/subagent/logs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, fanoutId }),
      });
      if (!res.ok) throw new Error(`Logfile generation failed (${res.status})`);
      const out = (await res.json()) as { serveUrl?: string; url?: string };
      const href = out.serveUrl ?? out.url;
      if (!href) throw new Error("Logfile response had no URL.");
      window.open(href, "_blank", "noopener,noreferrer");
    } catch (err) {
      toast({
        title: "Couldn't generate logfile",
        description: err instanceof Error ? err.message : "Unknown error.",
        type: "error",
      });
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title={run.capabilityName}
      description="Child run detail"
    >
      <div className="flex flex-col gap-4" data-testid="child-drawer">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={runStatusVariant(run.status)} size="sm">
            {run.status}
          </Badge>
          <CopyableId value={run.runId} label="Run" max={24} />
        </div>

        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-xs text-muted-foreground">Duration</dt>
            <dd className="font-mono text-xs">
              {formatDuration(run.durationMs)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Started</dt>
            <dd className="text-xs">
              {run.startedAt ? formatTimestamp(run.startedAt) : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Input size</dt>
            <dd className="font-mono text-xs">{formatBytes(run.inputBytes)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Output size</dt>
            <dd className="font-mono text-xs">
              {formatBytes(run.outputBytes)}
            </dd>
          </div>
        </dl>

        {run.errorReason ? (
          <p
            className="rounded-md bg-destructive/10 p-2 text-xs text-destructive"
            data-testid="child-drawer-error"
          >
            {run.errorReason}
          </p>
        ) : null}

        <Button
          size="sm"
          variant="outline"
          onClick={handleDownloadLogs}
          disabled={downloading}
          data-testid="child-drawer-download-logs-btn"
        >
          <Download className="size-3.5" aria-hidden="true" />
          {downloading ? "Generating…" : "Download fan-out logfile"}
        </Button>

        <div>
          <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Input
          </p>
          {resultLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : resultError ? (
            <p
              className="text-xs text-destructive"
              data-testid="child-drawer-result-error"
            >
              {resultError}
            </p>
          ) : (
            <pre
              className="max-h-56 overflow-auto rounded-md bg-muted p-2 text-xs"
              data-testid="child-drawer-input"
            >
              {jsonPreview(result?.input)}
            </pre>
          )}
        </div>

        <div>
          <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Output
          </p>
          {resultLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : resultError ? null : (
            <pre
              className="max-h-56 overflow-auto rounded-md bg-muted p-2 text-xs"
              data-testid="child-drawer-output"
            >
              {jsonPreview(result?.output)}
            </pre>
          )}
        </div>

        {run.status === "running" ? (
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Siblings
              </p>
              {siblings === null ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={loadSiblings}
                  disabled={siblingsLoading}
                  data-testid="child-drawer-load-siblings-btn"
                >
                  <Users className="size-3.5" aria-hidden="true" />
                  {siblingsLoading ? "Loading…" : "Load siblings"}
                </Button>
              ) : null}
            </div>
            {siblingsError ? (
              <p
                className="text-xs text-destructive"
                data-testid="child-drawer-siblings-error"
              >
                {siblingsError}
              </p>
            ) : null}
            {siblings ? (
              siblings.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No other children in this fan-out.
                </p>
              ) : (
                <ul
                  className="flex flex-col gap-1.5"
                  data-testid="child-drawer-siblings-list"
                >
                  {siblings.map((sib) => (
                    <li
                      key={sib.runId}
                      className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-xs"
                    >
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="truncate font-medium">
                          {sib.capabilityName}
                        </span>
                        {sib.summary ? (
                          <span className="truncate text-muted-foreground">
                            {sib.summary}
                          </span>
                        ) : null}
                      </span>
                      <Badge variant={runStatusVariant(sib.status)} size="sm">
                        {sib.status}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )
            ) : null}
          </div>
        ) : null}
      </div>
    </Drawer>
  );
}
