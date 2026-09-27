// The steering repo health banner as the workspace layout mounts it, above
// every workspace page. It renders nothing while the repo is healthy, before
// its first health read, and while no capability backs the read, because a
// banner on every page is for a repo that needs repair.
import "server-only";
import { routes } from "@/shared/safe-path";
import type { WsCtx } from "@/server/viewer";
import { SteeringRepoHealthBannerView } from "./health-banner-view";
import { readSteeringRepo } from "./read";

export async function SteeringRepoHealthBanner({ ctx }: { ctx: WsCtx }) {
  const read = await readSteeringRepo(ctx);
  if (read.kind === "not_backed") return null;
  const { health, provider, differences } = read.view;
  if (health === null || health === "healthy") return null;
  return (
    <SteeringRepoHealthBannerView
      org={ctx.orgSlug}
      ws={ctx.wsSlug}
      provider={provider}
      health={health}
      differences={differences}
      canAct={ctx.orgRole === "owner" || ctx.orgRole === "admin"}
      returnTo={routes.repositories(ctx.orgSlug, ctx.wsSlug)}
    />
  );
}
