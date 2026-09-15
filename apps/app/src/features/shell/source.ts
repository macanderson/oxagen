// The shell renders for the context the organization layout resolved with
// requireViewer: signed in, a member, MFA satisfied, on the canonical slug. The
// person's name and email come from the same request's session. No read runs
// here: `shell.context` (org and workspace lists) is bound in WL-11 as the
// kernel seam's first production caller.
import "server-only";
import { getAuthUser } from "@/features/auth";
import type { OrgCtx } from "@/server/viewer";
import type { ShellData } from "./shell-data";

export async function shellSource(ctx: OrgCtx): Promise<ShellData> {
  // requireViewer admitted this request, so its memoized session is present;
  // a missing one is a programming error, never a signed-out render.
  const user = await getAuthUser();
  if (user === null) throw new Error("shell_without_session");
  return {
    org: { slug: ctx.orgSlug, name: ctx.orgName },
    viewer: { name: user.name || null, email: user.email },
  };
}
