// repository.list.ts — `list_repositories` (Mission Control spec §10.1).
//
// Every binding head in this workspace joined to the binding version it points
// at, and left-joined to its connection so a retired connection reads as
// `connectionLive: false` instead of dropping the repository from the list —
// the same judgement `get_main_repository` makes, through the same predicate.
// No GitHub call: a settings read renders while GitHub is down.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  repositoryList,
  type RepositoryListOutput,
} from "@oxagen/oxagen/contracts/repository.list";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import { isLiveConnectionRow } from "./repository.github-connection";

export const repositoryListHandler: CapabilityHandler<
  typeof repositoryList
> = async (_input, ctx): Promise<RepositoryListOutput> => {
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        bindingId: schema.repositoryBindings.publicId,
        role: schema.repositoryBindingHeads.role,
        owner: schema.repositoryBindings.providerOwner,
        name: schema.repositoryBindings.providerName,
        fullName: schema.repositoryBindings.providerFullName,
        defaultRef: schema.repositoryBindings.configuredDefaultRef,
        boundAt: schema.repositoryBindingHeads.createdAt,
        connectionStatus: schema.sourceConnections.status,
        connectionDeletedAt: schema.sourceConnections.deletedAt,
      })
      .from(schema.repositoryBindingHeads)
      .innerJoin(
        schema.repositoryBindings,
        eq(
          schema.repositoryBindings.id,
          schema.repositoryBindingHeads.currentBindingId,
        ),
      )
      .leftJoin(
        schema.sourceConnections,
        eq(
          schema.sourceConnections.id,
          schema.repositoryBindingHeads.connectionId,
        ),
      )
      .where(
        and(
          eq(schema.repositoryBindingHeads.orgId, ctx.orgId),
          eq(schema.repositoryBindingHeads.workspaceId, ctx.workspaceId),
        ),
      ),
  );

  const repositories = rows
    .map((r) => ({
      bindingId: r.bindingId,
      // The table's CHECK admits only these two; anything else is a schema
      // the contract does not know, and its output parse refuses it.
      role: r.role as "main" | "linked",
      owner: r.owner,
      name: r.name,
      fullName: r.fullName,
      defaultRef: r.defaultRef,
      htmlUrl: `https://github.com/${r.fullName}`,
      boundAt: r.boundAt.toISOString(),
      connectionLive: isLiveConnectionRow({
        status: r.connectionStatus,
        deletedAt: r.connectionDeletedAt,
      }),
    }))
    .sort((a, b) =>
      a.role === b.role
        ? a.fullName.localeCompare(b.fullName)
        : a.role === "main"
          ? -1
          : 1,
    );

  return { repositories };
};
