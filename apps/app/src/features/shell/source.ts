// The shell renders for the context the organization layout resolved with
// requireViewer: signed in, a member, MFA satisfied, on the canonical slug. The
// person's name and email come from the same request's session; the
// organizations and workspaces the switchers list come from `shell.context`.
import "server-only";
import type { DataSource } from "@/data/ports";
import { getAuthUser } from "@/features/auth";
import type { OrgCtx } from "@/server/viewer";
import type { ShellData } from "./shell-data";

export async function shellSource(
  ctx: OrgCtx,
  source: DataSource,
): Promise<ShellData> {
  const [user, context] = await Promise.all([
    getAuthUser(),
    source.shell.context(ctx),
  ]);
  // requireViewer admitted this request, so its memoized session is present;
  // a missing one is a programming error, never a signed-out render.
  if (user === null) throw new Error("shell_without_session");
  return {
    org: { slug: ctx.orgSlug, name: ctx.orgName },
    viewer: {
      name: user.name || null,
      email: user.email,
      avatarUrl: user.avatarUrl,
    },
    context,
    fleetWaiting: null,
  };
}
