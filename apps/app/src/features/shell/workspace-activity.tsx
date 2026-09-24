// The workspace layer's share of the chrome: the sidebar's counts and the
// bell's feed for the workspace in the URL. Read here, by the workspace
// layout, and published to the chrome through `activity-store.ts`, because
// `get_nav_counts` and `list_notifications` answer one workspace and the
// chrome (in the organization layout) does not know which one is open.
//
// The reads run when the workspace layout renders: on a full load, on the
// first visit to a workspace, and on the refresh a governed write ends with.
// Nothing polls (#3805).
import "server-only";
import type { DataSource } from "@/data/ports";
import type { WsCtx } from "@/server/viewer";
import { WorkspaceActivitySync } from "./activity-store";

export async function ShellWorkspace({
  ctx,
  source,
}: {
  ctx: WsCtx;
  source: Pick<DataSource, "shell">;
}) {
  const [counts, feed] = await Promise.all([
    source.shell.counts(ctx),
    source.shell.notifications(ctx),
  ]);
  return (
    <WorkspaceActivitySync activity={{ slug: ctx.wsSlug, counts, feed }} />
  );
}
