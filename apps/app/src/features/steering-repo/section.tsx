// The steering repo card as the repositories page mounts it: it reads the
// workspace's steering repo and decides who may act. An owner or admin may
// retry a failed step. Re-authorize returns the person to this page.
import "server-only";
import { routes } from "@/shared/safe-path";
import type { WsCtx } from "@/server/viewer";
import { SteeringRepoCard } from "./card";
import { readSteeringRepo } from "./read";

export async function SteeringRepoSection({ ctx }: { ctx: WsCtx }) {
  const read = await readSteeringRepo(ctx);
  return (
    <SteeringRepoCard
      org={ctx.orgSlug}
      ws={ctx.wsSlug}
      read={read}
      canAct={ctx.orgRole === "owner" || ctx.orgRole === "admin"}
      returnTo={routes.repositories(ctx.orgSlug, ctx.wsSlug)}
    />
  );
}
