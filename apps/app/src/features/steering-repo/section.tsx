// The steering repo card as the repositories page mounts it: it reads the
// workspace's steering repo and decides who may act. An owner or admin may
// set it up and retry a failed step. Re-authorize and Connect GitHub return
// the person to this page with the setup dialog open.
import "server-only";
import type { DataSource } from "@/data/ports";
import { routes } from "@/shared/safe-path";
import type { WsCtx } from "@/server/viewer";
import { SteeringRepoCard } from "./card";
import { readSteeringRepo } from "./read";

export async function SteeringRepoSection({
  ctx,
  source,
  setupOpen = false,
}: {
  ctx: WsCtx;
  source: DataSource;
  /** The address asked for the setup dialog (`?setup=steering`). */
  setupOpen?: boolean;
}) {
  const read = await readSteeringRepo(source, ctx);
  return (
    <SteeringRepoCard
      org={ctx.orgSlug}
      ws={ctx.wsSlug}
      read={read}
      canAct={ctx.orgRole === "owner" || ctx.orgRole === "admin"}
      returnTo={routes.steeringSetup(ctx.orgSlug, ctx.wsSlug)}
      setupOpen={setupOpen}
    />
  );
}
