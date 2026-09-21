// The shell renders for the context the organization layout resolved with
// requireViewer: signed in, a member, MFA satisfied, on the canonical slug. The
// person's name and email come from the same request's session; the
// organizations and workspaces the switchers list come from `shell.context`;
// the zone the chrome's dates render in comes from `shell.preferences`.
import "server-only";
import { createHash } from "node:crypto";
import { DEFAULT_TIME_ZONE } from "@oxagen/oxagen/contracts/user.preferences.read";
import type { DataSource } from "@/data/ports";
import { getAuthUser } from "@/features/auth";
import type { OrgCtx } from "@/server/viewer";
import type { ShellData } from "./shell-data";

export async function shellSource(
  ctx: OrgCtx,
  source: DataSource,
): Promise<ShellData> {
  const [user, context, preferences] = await Promise.all([
    getAuthUser(),
    source.shell.context(ctx),
    source.shell.preferences(ctx),
  ]);
  // requireViewer admitted this request, so its memoized session is present;
  // a missing one is a programming error, never a signed-out render.
  if (user === null) throw new Error("shell_without_session");
  return {
    org: {
      key: createHash("sha256").update(`account:${ctx.orgId}`).digest("hex"),
      slug: ctx.orgSlug,
      name: ctx.orgName,
    },
    viewer: {
      name: user.name || null,
      email: user.email,
      avatarUrl: user.avatarUrl,
      id: user.id,
      orgRole: ctx.orgRole,
      emailVerified: user.emailVerified,
      twoFactorEnabled: user.twoFactorEnabled,
      // A clock is not worth an empty shell: a refused or failed preference
      // read falls back to the default zone, and the read's own refusal is
      // already reported by the kernel seam.
      timeZone: preferences.ok ? preferences.value.timeZone : DEFAULT_TIME_ZONE,
    },
    context,
    fleetWaiting: null,
  };
}
