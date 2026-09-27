// tacho.host.enroll.ts — `enroll_host` (#2967): a machine presents the
// single-use token `create_enrollment_token` minted and becomes that agent's
// host. The host row and its scoped key come from lib/tacho-host-enroll.ts,
// shared with the operator's `create_tacho_enrollment`.
//
// Flow:
//   1. The token, by digest, outside any tenant scope (the call carries no
//      credential but the token). Unknown → not_found. Expired or already
//      used → conflict, and the refusal is counted on the row, including a
//      presentation that waited on the row lock and found the token used.
//   2. Inside the token's tenant scope, one transaction: lock the token row
//      (a second presenter waits here and then reads it as used), resolve the
//      agent and its key (it refuses a deleted or retired agent with
//      `agent_retired`; one live host per key; a revoked host gives its key
//      up), mint the host bound to the agent and its principal,
//      mark the token used by that host, and record the git remote the host
//      reported while the gate is still open.
//   3. One security event for the key, and the document returned once.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError, isHandlerError } from "@oxagen/oxagen";
import { tachoHostEnroll } from "@oxagen/oxagen/contracts/tacho.host.enroll";
import { schema, withSystemDb, withTenantDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { assertNotManaged, assertNotRetired } from "./lib/agent-identity";
import { hashEnrollmentToken, parseRepositoryRemote } from "./lib/onboarding";
import {
  enrollmentDocument,
  mintHostEnrollment,
  requireEnrollmentSigning,
} from "./lib/tacho-host-enroll";
import { logger } from "./logger";

const CAPABILITY = "enroll_host";

/** Count a refused presentation on the token row; the installer's "token rejected" screen reads it. */
async function countRejection(tokenId: string): Promise<void> {
  await withSystemDb((tx) =>
    tx
      .update(schema.tachoEnrollmentTokens)
      .set({
        rejectedCount: sql`${schema.tachoEnrollmentTokens.rejectedCount} + 1`,
      })
      .where(eq(schema.tachoEnrollmentTokens.id, tokenId)),
  );
}

function tokenRefusal(
  reason: "token_used" | "token_expired",
  message: string,
): HandlerError {
  return new HandlerError({ code: "conflict", reason, message });
}

export const tachoHostEnrollHandler: CapabilityHandler<
  typeof tachoHostEnroll
> = async (input, _ctx) => {
  const now = new Date();
  const tokenHash = hashEnrollmentToken(input.token);

  // tenancy: system bypass via withSystemDb (the token is the only credential
  // on the call; the tenant it names is not known until it is read) (see
  // docs/specs/tenancy-rls/spec.md)
  const token = await withSystemDb(async (tx) => {
    const [row] = await tx
      .select({
        id: schema.tachoEnrollmentTokens.id,
        orgId: schema.tachoEnrollmentTokens.orgId,
        workspaceId: schema.tachoEnrollmentTokens.workspaceId,
        issuedToUserId: schema.tachoEnrollmentTokens.issuedToUserId,
        expiresAt: schema.tachoEnrollmentTokens.expiresAt,
        usedAt: schema.tachoEnrollmentTokens.usedAt,
      })
      .from(schema.tachoEnrollmentTokens)
      .where(eq(schema.tachoEnrollmentTokens.tokenHash, tokenHash))
      .limit(1);
    return row ?? null;
  });
  if (!token) {
    throw new HandlerError({
      code: "not_found",
      reason: "token_unknown",
      message: "No enrollment token matches",
    });
  }
  if (token.usedAt !== null) {
    await countRejection(token.id);
    throw tokenRefusal(
      "token_used",
      `This enrollment token was used at ${token.usedAt.toISOString()}; enrollment tokens are single use`,
    );
  }
  if (token.expiresAt.getTime() <= now.getTime()) {
    await countRejection(token.id);
    throw tokenRefusal(
      "token_expired",
      `This enrollment token expired at ${token.expiresAt.toISOString()}`,
    );
  }

  const signing = requireEnrollmentSigning(CAPABILITY);

  const minted = await runInTenantScope(
    {
      orgId: token.orgId,
      workspaceId: token.workspaceId,
      userId: token.issuedToUserId,
      capabilityName: CAPABILITY,
    },
    () =>
      withTenantDb(async (tx) => {
        // The row lock serialises two presentations of one token: the second
        // waits for the first to commit and then reads its used_at.
        const [locked] = await tx
          .select({
            usedAt: schema.tachoEnrollmentTokens.usedAt,
            agentId: schema.tachoEnrollmentTokens.agentId,
          })
          .from(schema.tachoEnrollmentTokens)
          .where(eq(schema.tachoEnrollmentTokens.id, token.id))
          .for("update");
        if (!locked) {
          throw new HandlerError({
            code: "not_found",
            reason: "token_unknown",
            message: "No enrollment token matches",
          });
        }
        if (locked.usedAt !== null) {
          throw tokenRefusal(
            "token_used",
            `This enrollment token was used at ${locked.usedAt.toISOString()}; enrollment tokens are single use`,
          );
        }

        const [agent] = await tx
          .select({
            id: schema.agents.id,
            publicId: schema.agents.publicId,
            slug: schema.agents.slug,
            agentType: schema.agents.agentType,
            status: schema.agents.status,
            principalId: schema.agents.principalId,
            orgNamespace: schema.organizations.namespace,
            orgSlug: schema.organizations.slug,
            workspaceNamespace: schema.workspaces.namespace,
            workspaceSlug: schema.workspaces.slug,
          })
          .from(schema.agents)
          .innerJoin(
            schema.organizations,
            eq(schema.organizations.id, schema.agents.orgId),
          )
          .innerJoin(
            schema.workspaces,
            eq(schema.workspaces.id, schema.agents.workspaceId),
          )
          .where(
            and(
              eq(schema.agents.id, locked.agentId),
              isNull(schema.agents.deletedAt),
            ),
          )
          .limit(1);
        if (!agent) {
          throw new HandlerError({
            code: "conflict",
            reason: "agent_retired",
            message: "The agent this token was issued for no longer exists",
          });
        }
        // `retire_agent` archives the row and leaves `deleted_at` unset, so a
        // token issued before the retirement still finds it. The refusal
        // rolls back the transaction, which leaves the token unused.
        assertNotRetired(agent);
        // A token minted for the built-in assistant before
        // create_enrollment_token refused it binds no host to it (#4350).
        assertNotManaged(agent);
        const agentKey = `${agent.orgNamespace}.${agent.workspaceNamespace}.${agent.slug}`;

        const [existingHost] = await tx
          .select({ id: schema.tachoHosts.id })
          .from(schema.tachoHosts)
          .where(
            and(
              eq(schema.tachoHosts.orgId, token.orgId),
              eq(schema.tachoHosts.agentKey, agentKey),
              ne(schema.tachoHosts.status, "revoked"),
            ),
          )
          .limit(1);
        if (existingHost) {
          throw new HandlerError({
            code: "conflict",
            reason: "agent_has_host",
            message: `A host is already enrolled as ${agentKey}`,
          });
        }

        const host = await mintHostEnrollment(tx, {
          orgId: token.orgId,
          workspaceId: token.workspaceId,
          userId: token.issuedToUserId,
          agentKey,
          agent: { id: agent.id, principalId: agent.principalId },
          facts: input,
          signing,
          issuedAt: now,
        });

        await tx
          .update(schema.tachoEnrollmentTokens)
          .set({ usedAt: now, usedByHostId: host.host.id })
          .where(eq(schema.tachoEnrollmentTokens.id, token.id));

        const detected =
          input.repositoryRemote !== undefined
            ? parseRepositoryRemote(input.repositoryRemote)
            : null;
        if (detected !== null) {
          await tx
            .update(schema.onboardingState)
            .set({ detectedRepository: detected, updatedAt: now })
            .where(
              and(
                eq(schema.onboardingState.orgId, token.orgId),
                ne(schema.onboardingState.step, "unlocked"),
                isNull(schema.onboardingState.detectedRepository),
              ),
            );
        }

        return {
          ...host,
          agentId: agent.publicId,
          orgSlug: agent.orgSlug,
          workspaceSlug: agent.workspaceSlug,
        };
      }),
  ).catch(async (err: unknown) => {
    // The losing presentation of a race reads the token as unused, waits on
    // the row lock, and is refused inside the transaction, which rolls back;
    // it is counted here so every refused presentation is counted once.
    if (isHandlerError(err) && err.reason === "token_used") {
      await countRejection(token.id);
    }
    throw err;
  });

  emitSecurityEvent({
    eventType: "api_key.created",
    actorUserId: token.issuedToUserId,
    orgId: token.orgId,
    workspaceId: token.workspaceId,
    capability: CAPABILITY,
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: _ctx.requestId ?? null,
  });
  logger.info(
    {
      orgId: token.orgId,
      workspaceId: token.workspaceId,
      hostEnrollmentId: minted.hostEnrollmentId,
      agentId: minted.agentId,
      agentKey: minted.host.agentKey,
    },
    "tacho.host.enroll: host enrolled with a one-time token",
  );

  return {
    ...enrollmentDocument(minted, signing, now),
    agentId: minted.agentId,
    orgSlug: minted.orgSlug,
    workspaceSlug: minted.workspaceSlug,
  };
};
