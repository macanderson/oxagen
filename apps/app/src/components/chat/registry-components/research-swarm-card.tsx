"use client";
import * as React from "react";
import { Radar, Loader2, CheckCircle2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { safeHref } from "@/lib/safe-url";
import { TruncatedText } from "@/components/ui/truncated-text";

/**
 * research-swarm-card — renders research.swarm.start and research.swarm.status.
 * Shows a LIVE progress indicator (completed / total tasks) and, once results
 * land, the per-query breakdown. This is the surface the user watches while the
 * swarm runs.
 *
 * research.swarm.start is fire-and-forget: it returns `{ status: "running",
 * completed: 0 }` and dispatches the fan-out asynchronously. The card therefore
 * cannot be a static projection of that one snapshot — it must poll
 * research.swarm.status until the swarm reaches a terminal state. Without this
 * the bar renders at 0% and never updates or completes (the reported bug).
 *
 * Polling needs the tenant slugs (the status route is org+workspace scoped);
 * translate-stream / resolveRenderDirective inject orgSlug + workspaceSlug into
 * the component props, alongside the tool `output`.
 *
 * componentId: "research-swarm-card"
 */

// Poll cadence + ceiling. Web-search swarms finish in seconds; the ceiling only
// bounds a tab left open on a genuinely stuck swarm so we never poll forever.
const POLL_INTERVAL_MS = 2_000;
const MAX_POLLS = 180; // ~6 min at 2s — safely past the aggregate staleness window

function isTerminal(status: string): boolean {
  return status === "complete" || status === "failed";
}

interface SwarmHit {
  title: string;
  url: string;
  snippet: string;
}

interface SwarmResult {
  query: string;
  resultCount: number;
  hits: SwarmHit[];
}

interface ResearchSwarmCardProps {
  capability?: string;
  output?: unknown;
  /** Tenant slugs injected by the chat stream so the card can poll the
   *  org+workspace-scoped research.swarm.status route. */
  orgSlug?: string;
  workspaceSlug?: string;
}

interface SwarmShape {
  swarmId?: string;
  status: "running" | "complete" | "failed" | string;
  completed: number;
  total: number;
  results: SwarmResult[];
}

function readSwarm(output: unknown): SwarmShape {
  const o =
    typeof output === "object" && output !== null
      ? (output as Record<string, unknown>)
      : {};
  const total =
    typeof o.totalTasks === "number"
      ? o.totalTasks
      : typeof o.estimatedTasks === "number"
        ? o.estimatedTasks
        : 0;
  const results = Array.isArray(o.results)
    ? o.results.flatMap((r): SwarmResult[] => {
        if (typeof r !== "object" || r === null) return [];
        const rr = r as Record<string, unknown>;
        if (typeof rr.query !== "string") return [];
        const hits = Array.isArray(rr.hits)
          ? rr.hits.flatMap((h): SwarmHit[] => {
              if (typeof h !== "object" || h === null) return [];
              const hh = h as Record<string, unknown>;
              if (typeof hh.title !== "string" || typeof hh.url !== "string")
                return [];
              return [
                {
                  title: hh.title,
                  url: hh.url,
                  snippet: typeof hh.snippet === "string" ? hh.snippet : "",
                },
              ];
            })
          : [];
        return [
          {
            query: rr.query,
            resultCount:
              typeof rr.resultCount === "number" ? rr.resultCount : hits.length,
            hits,
          },
        ];
      })
    : [];
  return {
    swarmId: typeof o.swarmId === "string" ? o.swarmId : undefined,
    status: typeof o.status === "string" ? o.status : "running",
    completed: typeof o.completedTasks === "number" ? o.completedTasks : 0,
    total,
    results,
  };
}

function StatusBadge({ status }: { status: string }): React.ReactElement {
  if (status === "complete") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
        <CheckCircle2 className="size-3" aria-hidden="true" /> Complete
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-destructive">
        <XCircle className="size-3" aria-hidden="true" /> Failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
      <Loader2 className="size-3 animate-spin" aria-hidden="true" /> Running
    </span>
  );
}

export default function ResearchSwarmCard(
  props: ResearchSwarmCardProps,
): React.ReactElement {
  const initial = readSwarm(props.output);
  const orgSlug = typeof props.orgSlug === "string" ? props.orgSlug : "";
  const workspaceSlug =
    typeof props.workspaceSlug === "string" ? props.workspaceSlug : "";

  // Live state overrides the initial snapshot once polling returns. Null until
  // the first successful poll, so the very first paint uses the tool output.
  const [live, setLive] = React.useState<SwarmShape | null>(null);
  const s = live ?? initial;

  const swarmId = initial.swarmId;
  // Only poll when we have everything required to build the scoped URL and the
  // initial snapshot isn't already terminal (a direct status call may arrive
  // complete — nothing left to watch).
  const shouldPoll =
    swarmId !== undefined &&
    orgSlug !== "" &&
    workspaceSlug !== "" &&
    !isTerminal(initial.status);

  React.useEffect(() => {
    if (!shouldPoll || swarmId === undefined) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    const url =
      `/api/v1/${encodeURIComponent(orgSlug)}/${encodeURIComponent(workspaceSlug)}` +
      `/research/swarm/status?swarmId=${encodeURIComponent(swarmId)}`;

    async function poll(): Promise<void> {
      polls += 1;
      try {
        const res = await fetch(url, {
          headers: { "Content-Type": "application/json" },
        });
        // 404 → the swarmId is unknown (never existed or cross-tenant).  Stop
        // polling immediately — retrying will never produce a different result.
        if (res.status === 404) {
          if (!cancelled) setLive({ ...readSwarm(null), status: "failed" });
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json: unknown = await res.json();
        if (cancelled) return;
        const next = readSwarm(json);
        setLive(next);
        if (!isTerminal(next.status) && polls < MAX_POLLS) {
          timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
        }
      } catch {
        // Transient (the fan-out row may not be queryable for a beat after
        // dispatch, or a network blip). Back off and retry until the ceiling.
        if (!cancelled && polls < MAX_POLLS) {
          timer = setTimeout(() => void poll(), POLL_INTERVAL_MS * 2);
        }
      }
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [shouldPoll, swarmId, orgSlug, workspaceSlug]);

  const pct =
    s.total > 0
      ? Math.round((s.completed / s.total) * 100)
      : s.status === "complete"
        ? 100
        : 0;

  return (
    <div
      className="my-2 overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-sm"
      data-component="research-swarm-card"
      data-status={s.status}
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
        <Radar className="size-4 shrink-0 text-primary" aria-hidden="true" />
        <span className="text-sm font-semibold">Research swarm</span>
        <span className="ml-auto">
          <StatusBadge status={s.status} />
        </span>
      </div>

      <div className="space-y-3 px-4 py-3">
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {s.completed} / {s.total || "?"} tasks
            </span>
            <span className="tabular-nums">{pct}%</span>
          </div>
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className={cn(
                "h-full rounded-full transition-[width] duration-500",
                s.status === "failed" ? "bg-error" : "bg-primary",
              )}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>

        {s.results.length > 0 ? (
          <ul className="space-y-2">
            {s.results.slice(0, 20).map((r, i) => (
              <li
                key={i}
                className="rounded-md bg-muted/30 px-2.5 py-2 text-xs"
              >
                <div className="flex items-center justify-between gap-3">
                  <span
                    className="min-w-0 truncate font-medium"
                    title={r.query}
                  >
                    {r.query}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {r.resultCount} result{r.resultCount === 1 ? "" : "s"}
                  </span>
                </div>
                {r.hits.length > 0 ? (
                  <ul className="mt-1 space-y-0.5">
                    {r.hits.slice(0, 3).map((h, j) => {
                      // h.url is untrusted swarm/model output — validate scheme.
                      const safe = safeHref(h.url);
                      return (
                        <li key={j}>
                          {safe ? (
                            <a
                              href={safe}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="block truncate text-primary hover:underline"
                              title={h.snippet || h.title}
                            >
                              {h.title}
                            </a>
                          ) : (
                            <span
                              className="block truncate text-foreground"
                              title={h.snippet || h.title}
                            >
                              {h.title}
                            </span>
                          )}
                          {h.snippet ? (
                            <p className="text-muted-foreground/80">
                              <TruncatedText text={h.snippet} lines={1} />
                            </p>
                          ) : null}
                        </li>
                      );
                    })}
                    {r.hits.length > 3 ? (
                      <li className="text-muted-foreground">
                        +{r.hits.length - 3} more
                      </li>
                    ) : null}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        ) : s.status === "running" ? (
          <p className="text-xs text-muted-foreground">
            Searching across {s.total || "several"} queries in parallel…
          </p>
        ) : null}

        {s.swarmId ? (
          <p
            className="font-mono text-[11px] text-muted-foreground"
            title={s.swarmId}
          >
            {s.swarmId}
          </p>
        ) : null}
      </div>
    </div>
  );
}
