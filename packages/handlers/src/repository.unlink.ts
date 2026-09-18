// repository.unlink.ts — `unlink_repository` (Mission Control spec §10.1;
// ADR-091).
//
// Flow:
//   1. Role gate — assertOrgRole: org Owner or Admin, or the workspace's Owner
//      (INV-29).
//   2. One transaction under the workspace's repository lock: the head whose
//      current binding carries this `rpb_…` id in THIS workspace (RLS and the
//      explicit org/workspace predicates both bound the read). None is
//      `not_found: repository_not_linked`; a main head is
//      `conflict: main_repo_unlink_refused`, because a workspace without a
//      main repo cannot exist; a linked head is deleted.
//
// Only the head goes. It is a pointer, not evidence; the binding versions it
// pointed at stay, because admitted runs cite them. Re-linking the repository
// writes the next version through `writeRepositoryHead`.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import {
  repositoryUnlink,
  type RepositoryUnlinkOutput,
} from "@oxagen/oxagen/contracts/repository.unlink";
import { schema, withTenantDb } from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";
import { workspaceRepositoriesLock } from "./repository.main.bind";

export const repositoryUnlinkHandler: CapabilityHandler<
  typeof repositoryUnlink
> = async (input, ctx): Promise<RepositoryUnlinkOutput> => {
  const actingUserId = await resolveActingUserId(ctx);
  await assertOrgRole(
    { ...ctx, userId: actingUserId },
    { org: ["Owner", "Admin"], workspace: ["Owner"] },
  );
  const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };

  const fullName = await withTenantDb(async (tx) => {
    await tx.execute(workspaceRepositoriesLock(scope.workspaceId));
    const [head] = await tx
      .select({
        id: schema.repositoryBindingHeads.id,
        role: schema.repositoryBindingHeads.role,
        fullName: schema.repositoryBindings.providerFullName,
      })
      .from(schema.repositoryBindingHeads)
      .innerJoin(
        schema.repositoryBindings,
        eq(
          schema.repositoryBindings.id,
          schema.repositoryBindingHeads.currentBindingId,
        ),
      )
      .where(
        and(
          eq(schema.repositoryBindingHeads.orgId, scope.orgId),
          eq(schema.repositoryBindingHeads.workspaceId, scope.workspaceId),
          eq(schema.repositoryBindings.publicId, input.bindingId),
        ),
      )
      .limit(1);
    if (!head) {
      throw new HandlerError({
        code: "not_found",
        reason: "repository_not_linked",
        message: `No repository with binding ${input.bindingId} is linked to this workspace`,
      });
    }
    if (head.role === "main") {
      throw new HandlerError({
        code: "conflict",
        reason: "main_repo_unlink_refused",
        message: `${head.fullName} is this workspace's main repository and cannot be unlinked; a workspace without a main repo cannot exist`,
      });
    }
    await tx
      .delete(schema.repositoryBindingHeads)
      .where(eq(schema.repositoryBindingHeads.id, head.id));
    return head.fullName;
  });

  logger.info(
    { ...scope, repository: fullName, bindingId: input.bindingId },
    "repository.unlink: repository unlinked",
  );

  return {
    bindingId: input.bindingId,
    fullName,
    unlinkedAt: new Date().toISOString(),
  };
};
