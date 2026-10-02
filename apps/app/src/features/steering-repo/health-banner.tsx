// The steering repo health banner as the workspace layout mounts it, above
// every workspace page. It renders nothing while the repo is healthy, before
// its first health read, and when the read fails, because a banner on every
// page is for a repo that needs repair. The Repositories card shows a failed
// read in its own place. Repair is the workspace's Owner's or Admin's too
// (#5228); authorizing Oxagen again writes the organization's connection, so
// it stays with an org Owner or Admin.
import "server-only";
import type { DataSource } from "@/data/ports";
import { routes } from "@/shared/safe-path";
import { mayActInWorkspace } from "@/shared/workspace-authority";
import type { WsCtx } from "@/server/viewer";
import { SteeringRepoHealthBannerView } from "./health-banner-view";
import { readSteeringRepo } from "./read";

export async function SteeringRepoHealthBanner({
  ctx,
  source,
}: {
  ctx: WsCtx;
  source: DataSource;
}) {
  const read = await readSteeringRepo(source, ctx);
  if (read.kind === "failed") return null;
  const { health, provider, differences } = read.view;
  if (health === null || health === "healthy") return null;
  return (
    <SteeringRepoHealthBannerView
      org={ctx.orgSlug}
      ws={ctx.wsSlug}
      provider={provider}
      health={health}
      differences={differences}
      canAct={mayActInWorkspace(ctx.orgRole, ctx.wsRole, ["owner", "admin"])}
      canChangeConnection={ctx.orgRole === "owner" || ctx.orgRole === "admin"}
      returnTo={routes.repositories(ctx.orgSlug, ctx.wsSlug)}
    />
  );
}
