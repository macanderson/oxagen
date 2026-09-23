import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import { scimRequest } from "@oxagen/oxagen/contracts/scim.request";
import { schema, withSystemDb } from "@oxagen/database";
import { OwnerRemovalRefused } from "@oxagen/database/member-lifecycle";
import { emitSecurityEvent } from "@oxagen/database/security";
import { and, eq, isNull } from "drizzle-orm";
import { ssoAuthBaseUrl, ssoEntitled } from "./lib/sso";
import { createPgScimStore } from "./lib/scim/pg-store";
import {
  isUniqueViolation,
  ScimError,
  scimErrorBody,
} from "./lib/scim/protocol";
import { serveScim } from "./lib/scim/service";
import { scimBaseUrl } from "./lib/scim/token-store";
import { logger } from "./logger";

/**
 * execute_scim_request: answer one SCIM request for the organization whose token
 * the route authenticated (#3734). See the contract for what it serves.
 *
 * Authorization, in order:
 *   1. The call carries no user and no API key. The SCIM route invokes with
 *      neither; a caller that has one is some other surface reaching for a
 *      capability that is not theirs.
 *   2. The token is live and belongs to `ctx.orgId`. The route resolved it a
 *      moment earlier; this re-reads it inside the kernel call, so a token
 *      revoked in between is refused and a mismatched organization cannot be
 *      forged by an in-process caller.
 *   3. The organization's plan includes SSO. SCIM is part of single sign-on,
 *      which is the Enterprise plan (ADR-145).
 *
 * Every refusal the endpoint gives for authority rather than syntax (a bad
 * token, the wrong organization, no entitlement, an Owner, a domain the
 * organization has not verified) is a `scim.request_denied` row. The request
 * itself runs in one withSystemDb transaction fenced on `ctx.orgId`, so a
 * refusal part-way through writes nothing.
 */
export const scimRequestHandler: CapabilityHandler<typeof scimRequest> = async (
  input,
  ctx,
) => {
  if (ctx.userId !== null || ctx.apiKeyId !== null) {
    throw new HandlerError({
      code: "forbidden",
      reason: "scim_caller_only",
      message: "execute_scim_request is invoked only by the SCIM endpoint",
    });
  }

  const deny = (
    reason:
      | "invalid_token"
      | "not_entitled"
      | "owner_protected"
      | "domain_not_verified"
      | "identity_not_owned"
      | "cross_organization",
    err: ScimError,
  ): { status: number; body: unknown } => {
    // ScimRequestDeniedDetail in @oxagen/compliance.
    const detail = { reason, method: input.method, path: input.path };
    emitSecurityEvent({
      eventType: "scim.request_denied",
      actorUserId: null,
      orgId: ctx.orgId,
      workspaceId: null,
      capability: scimRequest.name,
      outcome: "deny",
      ip: ctx.clientIp ?? null,
      userAgent: null,
      requestId: ctx.requestId ?? null,
      detail,
    });
    logger.warn(
      { orgId: ctx.orgId, reason, method: input.method, path: input.path },
      "scim.request: refused",
    );
    return { status: err.status, body: scimErrorBody(err) };
  };

  // tenancy: the token row is filtered by its id and by orgId = ctx.orgId, the organization the route authenticated from the token's hash.
  const token = await withSystemDb(async (tx) => {
    const [row] = await tx
      .select({ orgId: schema.scimTokens.orgId })
      .from(schema.scimTokens)
      .where(
        and(
          eq(schema.scimTokens.id, input.tokenId),
          isNull(schema.scimTokens.revokedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  });
  if (!token) {
    return deny(
      "invalid_token",
      new ScimError(401, "The SCIM token is not valid"),
    );
  }
  if (token.orgId !== ctx.orgId) {
    return deny(
      "cross_organization",
      new ScimError(401, "The SCIM token is not valid"),
    );
  }
  if (!(await ssoEntitled(ctx))) {
    return deny(
      "not_entitled",
      new ScimError(
        403,
        "SCIM provisioning is part of single sign-on on the Enterprise plan",
      ),
    );
  }

  const baseUrl = scimBaseUrl(ssoAuthBaseUrl());
  try {
    // tenancy: every statement in the SCIM store is filtered by orgId = ctx.orgId, the organization the verified token names.
    const response = await withSystemDb((tx) =>
      serveScim(
        createPgScimStore(tx, ctx.orgId, ctx.requestId ?? null),
        {
          method: input.method,
          path: input.path,
          query: input.query,
          body: input.body,
        },
        baseUrl,
      ),
    );
    logger.info(
      {
        orgId: ctx.orgId,
        method: input.method,
        path: input.path,
        status: response.status,
      },
      "scim.request: served",
    );
    return {
      status: response.status,
      body: response.body ?? null,
      ...(response.location ? { location: response.location } : {}),
    };
  } catch (err) {
    if (err instanceof OwnerRemovalRefused) {
      return deny(
        "owner_protected",
        new ScimError(403, err.message, "mutability", "owner_protected"),
      );
    }
    if (err instanceof ScimError) {
      if (
        err.denial === "owner_protected" ||
        err.denial === "domain_not_verified" ||
        err.denial === "identity_not_owned"
      ) {
        return deny(err.denial, err);
      }
      return { status: err.status, body: scimErrorBody(err) };
    }
    if (isUniqueViolation(err)) {
      const conflict = new ScimError(
        409,
        "The resource already exists",
        "uniqueness",
      );
      return { status: 409, body: scimErrorBody(conflict) };
    }
    throw err;
  }
};
