// auth.cli.authorize.ts — handler for the authorize_cli capability.
//
// Mints the single-use authorization code that completes a CLI login
// (RFC 8252 loopback + PKCE S256). The code is bound to the approving user,
// the org and workspace the kernel entered, the slugs the CLI stores, and the
// CLI's code challenge; the CLI redeems it at POST /v1/auth/cli/token.
//
// Flow:
//   1. Principal guard — a user session is required: the code records the
//      approving user as the minted key's creator, and an API key cannot
//      consent on a person's behalf.
//   2. Role gate — assertOrgRole: org Owner or Admin. The kernel's IAM check
//      allows every capability for a non-enterprise org, so the handler owns
//      this check (apps/app/ARCHITECTURE.md §3.2, INV-29). The guard above
//      admits a session only, so the acting user resolveActingUserId returns
//      is the signed-in user, never an API key's creator.
//   3. Loopback guard — the redirect target is validated by the one rule in
//      @oxagen/auth/cli-auth; anything else is refused as invalid_input and
//      no code exists to leak (RFC 8252 §7.3).
//   4. Resolve the scope's slugs — the workspace must belong to the org the
//      kernel entered.
//   5. Mint and store the code.
//
// The kernel's capability.invoke_* audit records the invocation, the actor and
// the input (the code challenge is public under PKCE; the code itself is only
// in the output).

import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { authCliAuthorize } from "@oxagen/oxagen/contracts/auth.cli.authorize";
import {
  createCliAuthCode,
  generateCliAuthCode,
  isLoopbackRedirectUri,
} from "@oxagen/auth/cli-auth";
import { schema, withTenantDb } from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";

export const authCliAuthorizeHandler: CapabilityHandler<
  typeof authCliAuthorize
> = async (input, ctx) => {
  // ── Principal guard ─────────────────────────────────────────────────────
  if (!ctx.userId) {
    logger.warn(
      { orgId: ctx.orgId },
      "auth.cli.authorize: rejected — a user session is required to consent",
    );
    throw new HandlerError({
      code: "forbidden",
      reason: "user_session_required",
      message: "A signed-in user must approve a CLI login",
    });
  }
  const { userId, orgId, workspaceId } = ctx;

  // ── Role gate ───────────────────────────────────────────────────────────
  await assertOrgRole(
    { ...ctx, userId: await resolveActingUserId(ctx) },
    { org: ["Owner", "Admin"] },
  );

  // ── Loopback guard ──────────────────────────────────────────────────────
  if (!isLoopbackRedirectUri(input.redirectUri)) {
    logger.warn(
      { orgId, userId },
      "auth.cli.authorize: rejected — redirectUri is not a loopback listener",
    );
    throw new CapabilityError(
      "authorize_cli",
      "invalid_input",
      "redirectUri must be a loopback http URL with an explicit port",
    );
  }

  // ── Scope slugs ─────────────────────────────────────────────────────────
  const scope = await withTenantDb(async (tx) => {
    const [org] = await tx
      .select({ slug: schema.organizations.slug })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, orgId))
      .limit(1);
    const [workspace] = await tx
      .select({ slug: schema.workspaces.slug })
      .from(schema.workspaces)
      .where(
        and(
          eq(schema.workspaces.id, workspaceId),
          eq(schema.workspaces.orgId, orgId),
        ),
      )
      .limit(1);
    return org && workspace
      ? { orgSlug: org.slug, workspaceSlug: workspace.slug }
      : null;
  });
  if (!scope) {
    throw new HandlerError({
      code: "not_found",
      reason: "workspace_not_found",
      message: "The workspace is not in this organization",
    });
  }

  // ── Mint ────────────────────────────────────────────────────────────────
  const code = generateCliAuthCode();
  await createCliAuthCode(
    code,
    {
      userId,
      orgId,
      workspaceId,
      orgSlug: scope.orgSlug,
      workspaceSlug: scope.workspaceSlug,
      codeChallenge: input.codeChallenge,
      redirectUri: input.redirectUri,
      label: input.label,
    },
    Date.now(),
  );
  logger.info(
    { orgId, workspaceId, userId },
    "auth.cli.authorize: authorization code minted",
  );
  return { code };
};
