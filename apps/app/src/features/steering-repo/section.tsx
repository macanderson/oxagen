// The steering repo card as the repositories page mounts it: it reads the
// workspace's steering repo and decides who may act. An org Owner or Admin,
// or the workspace's Owner or Admin (#5228), may set it up and retry a failed
// step. The connection belongs to the organization, so only an org Owner or
// Admin picks or changes it, connects GitHub or authorizes Oxagen again.
// Re-authorize and Connect GitHub return the person to this page with the
// setup dialog open.
import "server-only";
import type { DataSource } from "@/data/ports";
import { routes } from "@/shared/safe-path";
import { mayActInWorkspace } from "@/shared/workspace-authority";
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
      canAct={mayActInWorkspace(ctx.orgRole, ctx.wsRole, ["owner", "admin"])}
      canChangeConnection={ctx.orgRole === "owner" || ctx.orgRole === "admin"}
      returnTo={routes.steeringSetup(ctx.orgSlug, ctx.wsSlug)}
      setupOpen={setupOpen}
    />
  );
}
