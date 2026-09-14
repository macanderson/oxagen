// workspace-bootstrap.ts — the one place a workspace's rows are written.
// `create_workspace` calls it inside its tenant transaction; `create_org`
// calls it inside the system transaction that creates the org, so the first
// workspace, its owner membership, the built-in agent, the default MCP registry
// and the default environment commit with the org or not at all.
import { schema, deriveNamespace } from "@oxagen/database";
import type { Tx } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { bootstrapWorkspaceAgents } from "./workspace-agents";
import { seedWorkspaceDefaultRegistry } from "./workspace-registry-seed";
import { seedWorkspaceDefaultEnvironment } from "./workspace-environment-seed";

export interface BootstrapWorkspaceArgs {
  tx: Tx;
  orgId: string;
  /** The creator: owner of the workspace and the audit actor on every row. */
  userId: string;
  name: string;
  slug: string;
}

export interface BootstrappedWorkspace {
  id: string;
  publicId: string;
  name: string;
  slug: string;
  createdAt: Date;
}

/**
 * Inserts the workspace and everything a workspace needs to be usable, on the
 * caller's transaction. The namespace is derived from the slug and unique
 * within the org; the `(org_id, namespace)` and `(org_id, slug)` unique
 * indexes are the authoritative guards against a concurrent-create race, so a
 * unique violation surfaces to the caller unchanged.
 */
export async function bootstrapWorkspace(
  args: BootstrapWorkspaceArgs,
): Promise<BootstrappedWorkspace> {
  const { tx, orgId, userId, name, slug } = args;

  const takenNamespaces = new Set(
    (
      await tx
        .select({ namespace: schema.workspaces.namespace })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.orgId, orgId))
    ).map((r) => r.namespace.toLowerCase()),
  );
  const namespace = deriveNamespace(slug, takenNamespaces);

  const [ws] = await tx
    .insert(schema.workspaces)
    .values({
      orgId,
      name,
      slug,
      namespace,
      createdByUserId: userId,
      updatedByUserId: userId,
    })
    .returning({
      id: schema.workspaces.id,
      publicId: schema.workspaces.publicId,
      name: schema.workspaces.name,
      slug: schema.workspaces.slug,
      createdAt: schema.workspaces.createdAt,
    });
  if (!ws) throw new Error("workspace insert returned no row");

  await tx.insert(schema.workspaceUsers).values({
    workspaceId: ws.id,
    userId,
    role: "owner",
    joinedAt: new Date(),
    createdByUserId: userId,
    updatedByUserId: userId,
  });

  await bootstrapWorkspaceAgents({ workspaceId: ws.id, orgId, userId, tx });
  await seedWorkspaceDefaultRegistry({ orgId, workspaceId: ws.id, tx });
  await seedWorkspaceDefaultEnvironment({ orgId, workspaceId: ws.id, tx });

  return ws;
}
