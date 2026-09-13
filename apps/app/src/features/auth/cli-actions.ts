"use server";
// Approve or cancel a CLI login (RFC 8252 loopback + PKCE). See cli-authorize.ts
// for the invariants. Approve mints a single-use code bound to the chosen scope
// and the CLI's PKCE challenge, then sends the browser to the loopback listener.
import { redirect } from "next/navigation";
import { isFixtureMode } from "@/server/fixture-session";
import { authorizeParamErrors, loadCliScopes } from "./cli-authorize";
import { ORG_ONLY_WORKSPACE } from "./kernel";
import { getAuthUser } from "./session";

export type CliErrorKey =
  | "notMember"
  | "notPermitted"
  | "notFound"
  | "fixture"
  | "failed"
  | "invalid";

export type CliActionState = { error: CliErrorKey } | null;

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

export async function approveCliAuth(
  _prev: CliActionState,
  form: FormData,
): Promise<CliActionState> {
  const user = await getAuthUser();
  if (!user) redirect("/login");

  const params = {
    redirectUri: field(form, "redirect_uri"),
    state: field(form, "state"),
    codeChallenge: field(form, "code_challenge"),
    codeChallengeMethod: field(form, "code_challenge_method"),
    label: field(form, "label") || "Oxagen CLI",
  };
  if (authorizeParamErrors(params).length > 0) return { error: "invalid" };
  const orgSlug = field(form, "org_slug");
  const workspaceSlug = field(form, "workspace_slug");
  if (!orgSlug || !workspaceSlug) return { error: "notFound" };
  if (isFixtureMode()) return { error: "fixture" };

  // Resolve the selection against the user's own memberships: an id the client
  // did not get from us, or a workspace they are not a member of, never resolves.
  const scopes = await loadCliScopes(user.id);
  const org = scopes.find((o) => o.slug === orgSlug);
  const workspace = org?.workspaces.find((w) => w.slug === workspaceSlug);
  if (!org || !workspace) return { error: "notMember" };

  let code: string;
  try {
    const [{ actorCanManageApiKeys }, { runInTenantScope }, cliAuth] =
      await Promise.all([
        import("@oxagen/handlers"),
        import("@oxagen/tenancy"),
        import("@oxagen/auth/cli-auth"),
      ]);
    const canManage = await runInTenantScope(
      { orgId: org.id, workspaceId: ORG_ONLY_WORKSPACE },
      () => actorCanManageApiKeys(org.id, user.id),
    );
    if (!canManage) return { error: "notPermitted" };
    code = cliAuth.generateCliAuthCode();
    await cliAuth.createCliAuthCode(
      code,
      {
        userId: user.id,
        orgId: org.id,
        workspaceId: workspace.id,
        orgSlug,
        workspaceSlug,
        codeChallenge: params.codeChallenge,
        redirectUri: params.redirectUri,
        label: params.label,
      },
      Date.now(),
    );
  } catch (err) {
    const { logger } = await import("@oxagen/handlers/logger");
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[cli-authorize] approve failed",
    );
    return { error: "failed" };
  }
  redirect(
    `${params.redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(params.state)}`,
  );
}

// Server actions must be async functions even when, like this one, they await nothing.
// eslint-disable-next-line @typescript-eslint/require-await -- a "use server" export has to be async
export async function cancelCliAuth(
  _prev: CliActionState,
  form: FormData,
): Promise<CliActionState> {
  const redirectUri = field(form, "redirect_uri");
  const state = field(form, "state");
  const errors = authorizeParamErrors({
    redirectUri,
    state,
    codeChallenge: field(form, "code_challenge"),
    codeChallengeMethod: field(form, "code_challenge_method"),
    label: "",
  });
  // Only a validated loopback URI is ever followed.
  if (errors.includes("redirectUri") || errors.includes("state"))
    return { error: "invalid" };
  redirect(
    `${redirectUri}?error=access_denied&state=${encodeURIComponent(state)}`,
  );
}
