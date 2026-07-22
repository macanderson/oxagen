/**
 * lineage-section.tsx — async server component that loads the fleet-lineage
 * data (query_lineage or, absent a dispatchId, list_subagent_fanouts) via the
 * server actions in ./actions.ts, and renders the right client surface for
 * every state. Sits inside the page's Suspense boundary so the header + tab
 * strip paint first (mirrors AutomationsSection / WorkflowsSection).
 *
 * State coverage (issue #1078's "no dead ends" requirement):
 *   - no dispatchId            → DispatchPicker (recent list + paste-id form)
 *   - queryLineageAction fails → DispatchPicker with a not-found/error banner
 *   - resolves but nodeCount=0 → an honest "no runs yet" panel with the root
 *                                 fan-out's own status (not a blank page)
 *   - resolves with nodes      → LineageExplorer (canvas + tree list; the
 *                                 violation banner is itself the "violation
 *                                 state" — handled inside LineageExplorer)
 *
 * Never throws: an unexpected action failure renders inline via the ok:false
 * branches above, never bubbling to the route error boundary.
 */
import { AlertCircle } from "lucide-react";
import { DispatchPicker } from "@/components/lineage/dispatch-picker";
import { LineageExplorer } from "@/components/lineage/lineage-explorer";
import { Badge } from "@/components/ui/badge";
import { statusBadgeVariant } from "@/components/activity/format";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";
import { queryLineageAction, listRecentFanoutsAction } from "./actions";

export interface LineageSectionProps {
  ctx: Required<ScopeContext>;
  orgSlug: string;
  workspaceSlug: string;
  dispatchId?: string;
  maxDepth?: number;
  maxNodes?: number;
}

export async function LineageSection({
  ctx,
  orgSlug,
  workspaceSlug,
  dispatchId,
  maxDepth,
  maxNodes,
}: LineageSectionProps) {
  if (!dispatchId) {
    const res = await listRecentFanoutsAction({
      orgSlug,
      workspaceSlug,
      limit: 20,
    });
    if (!res.ok) {
      return <ErrorBanner message={res.error} />;
    }
    return <DispatchPicker ctx={ctx} fanouts={res.fanouts} />;
  }

  const args: {
    orgSlug: string;
    workspaceSlug: string;
    dispatchId: string;
    maxDepth?: number;
    maxNodes?: number;
  } = { orgSlug, workspaceSlug, dispatchId };
  if (maxDepth !== undefined) args.maxDepth = maxDepth;
  if (maxNodes !== undefined) args.maxNodes = maxNodes;
  const res = await queryLineageAction(args);

  if (!res.ok) {
    // Not-found / denied / degraded — never a dead end: fall back to the
    // picker with the failing id named and the REAL failure reason (never a
    // generic "not found" for e.g. a permission denial), so the user can
    // correct it or pick a different recent dispatch.
    const pickerRes = await listRecentFanoutsAction({
      orgSlug,
      workspaceSlug,
      limit: 20,
    });
    const fanouts = pickerRes.ok ? pickerRes.fanouts : [];
    return (
      <DispatchPicker
        ctx={ctx}
        fanouts={fanouts}
        notFoundId={dispatchId}
        errorMessage={res.error}
      />
    );
  }

  if (res.data.nodeCount === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-border bg-card px-6 py-10 text-center">
        <Badge variant={statusBadgeVariant(res.data.rootStatus)} size="sm">
          {res.data.rootStatus}
        </Badge>
        <p className="text-sm font-medium text-foreground">
          No runs recorded for this dispatch yet
        </p>
        <p className="max-w-sm text-sm text-muted-foreground">
          Dispatch <span className="font-mono">{res.data.dispatchId}</span>{" "}
          exists but has no child runs — it may still be starting up.
        </p>
        <a
          href={workspace.automations.lineage(ctx)}
          className="mt-2 text-xs font-medium text-primary hover:underline"
        >
          Choose a different dispatch
        </a>
      </div>
    );
  }

  const pickerHref = workspace.automations.lineage(ctx);
  const deeperHref = res.data.maxDepthReached
    ? workspace.automations.lineage(ctx, dispatchId) +
      `&maxDepth=${Math.min((maxDepth ?? 5) + 3, 10)}`
    : undefined;
  const moreNodesHref = res.data.truncated
    ? workspace.automations.lineage(ctx, dispatchId) +
      `&maxNodes=${Math.min((maxNodes ?? 200) + 200, 500)}`
    : undefined;

  return (
    <LineageExplorer
      data={res.data}
      pickerHref={pickerHref}
      {...(deeperHref ? { deeperHref } : {})}
      {...(moreNodesHref ? { moreNodesHref } : {})}
    />
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      className="flex items-center gap-2 rounded-md border border-error/25 bg-error/10 p-3 text-sm text-error"
      role="alert"
    >
      <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
      {message}
    </div>
  );
}
