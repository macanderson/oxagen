/**
 * dispatch-picker.tsx — "pick a dispatch to inspect" surface for the
 * fleet-lineage explorer (issue #1078). Shown when the page has no
 * `?dispatchId=` yet, or when `query_lineage` fails to resolve one (not
 * found / denied).
 *
 * Server-rendered, zero client JS: recent dispatches (from
 * `list_subagent_fanouts`) are plain links to `?dispatchId=<id>`, and pasting
 * an arbitrary id is a native GET `<form>` — no fetch, no hydration required
 * to navigate. Never a dead end: even with zero recent fan-outs, the paste
 * form is always available.
 */
import { Workflow } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";
import { statusBadgeVariant, timeAgo } from "@/components/activity/format";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";
import type { AgentSubagentFanoutListOutput } from "@oxagen/oxagen/contracts/agent.subagent_fanout.list";

export interface DispatchPickerProps {
  ctx: Required<ScopeContext>;
  fanouts: AgentSubagentFanoutListOutput["fanouts"];
  /** Set when the caller arrived with a dispatchId that failed to resolve. */
  notFoundId?: string;
  /**
   * The actual `query_lineage` failure message (not-found, permission
   * denial, or an upstream error) — shown verbatim so a denied user sees
   * "you must be a workspace member…" rather than a misleading generic
   * "couldn't find" message.
   */
  errorMessage?: string;
}

export function DispatchPicker({
  ctx,
  fanouts,
  notFoundId,
  errorMessage,
}: DispatchPickerProps) {
  const actionHref = workspace.automations.lineage(ctx);

  return (
    <div className="flex flex-col gap-4">
      {notFoundId && (
        <div
          role="alert"
          className="rounded-md border border-error/25 bg-error/10 px-3 py-2 text-sm text-error"
        >
          {errorMessage ?? (
            <>
              Couldn’t find a dispatch with id{" "}
              <span className="font-mono">{notFoundId}</span>. Pick one below or
              check the id and try again.
            </>
          )}
        </div>
      )}

      <form action={actionHref} method="GET" className="flex items-end gap-2">
        <div className="flex-1">
          <label
            htmlFor="dispatchId"
            className="mb-1 block text-xs font-medium text-muted-foreground"
          >
            Dispatch ID
          </label>
          <Input
            id="dispatchId"
            name="dispatchId"
            placeholder="sfo_… (from dispatch_subagent, or a childFanoutId)"
            data-testid="dispatch-id-input"
          />
        </div>
        <Button type="submit" data-testid="dispatch-id-submit">
          View lineage
        </Button>
      </form>

      {fanouts.length === 0 ? (
        <EmptyState
          icon={Workflow}
          title="No fleet dispatches yet"
          description="Dispatch a subagent fan-out (agent.subagent.dispatch) to see its lineage here — or paste a dispatch id above."
        />
      ) : (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-muted-foreground">
            Recent dispatches
          </p>
          <div className="divide-y divide-border rounded-lg border border-border">
            {fanouts.map((f) => (
              <a
                key={f.fanoutId}
                href={workspace.automations.lineage(ctx, f.fanoutId)}
                data-testid={`recent-dispatch-${f.fanoutId}`}
                className="flex items-center gap-3 px-3 py-2.5 text-sm transition-colors hover:bg-muted/40"
              >
                <span className="font-mono text-xs text-muted-foreground">
                  {f.fanoutId}
                </span>
                <Badge variant={statusBadgeVariant(f.status)} size="sm">
                  {f.status}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {f.completedChildren}/{f.totalChildren} children
                </span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {timeAgo(f.createdAt)}
                </span>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
