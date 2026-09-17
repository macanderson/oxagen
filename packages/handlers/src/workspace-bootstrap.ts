// workspace-bootstrap.ts — the one place a workspace's rows are written.
// `create_workspace` calls it inside its tenant transaction; `create_org`
// calls it inside the system transaction that creates the org, so the first
// workspace, its owner membership, the built-in agent, the default MCP registry
// and the default environment commit with the org or not at all.
import {
  schema,
  deriveNamespace,
  setTransactionWorkspaceScope,
} from "@oxagen/database";
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
 *
 * The transaction's `app.current_workspace_id` is re-pointed at the new
 * workspace as soon as its row exists, because everything after that insert
 * writes a table whose RLS policy reads that GUC. See
 * `setTransactionWorkspaceScope` for why this is the one place that is allowed.
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
      createdById: userId,
      updatedById: userId,
    })
    .returning({
      id: schema.workspaces.id,
      publicId: schema.workspaces.publicId,
      name: schema.workspaces.name,
      slug: schema.workspaces.slug,
      createdAt: schema.workspaces.createdAt,
    });
  if (!ws) throw new Error("workspace insert returned no row");

  // Everything below writes workspace-GUC-scoped tables —
  // `workspace.workspace_users` (workspace_only), `agent.agents` and
  // `environments.environments` (standard). The transaction was opened in the
  // CALLER's scope, which for `create_workspace` from an org-only caller is
  // `ORG_ONLY_WORKSPACE_ID` (ADR-068) and never this workspace, so without
  // this every one of those inserts is refused by its `tenant_isolation`
  // WITH CHECK (42501 — not a unique violation, so it escapes the callers'
  // slug-conflict classifier and surfaces as a 500). `workspace.workspaces`
  // itself is `org_only`, which is why the INSERT above needed no re-point.
  // `create_org` runs this on a `withSystemDb` transaction where RLS is
  // bypassed; re-pointing the GUC there is harmless and, if anything, more
  // truthful about what the transaction is writing.
  await setTransactionWorkspaceScope(tx, ws.id);

  await tx.insert(schema.workspaceUsers).values({
    workspaceId: ws.id,
    userId,
    role: "owner",
    joinedAt: new Date(),
    createdById: userId,
    updatedById: userId,
  });

  await bootstrapWorkspaceAgents({ workspaceId: ws.id, orgId, userId, tx });
  await seedWorkspaceDefaultRegistry({ orgId, workspaceId: ws.id, tx });
  await seedWorkspaceDefaultEnvironment({ orgId, workspaceId: ws.id, tx });

  return ws;
}
