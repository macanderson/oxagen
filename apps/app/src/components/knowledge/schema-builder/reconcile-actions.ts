"use server";

import { invoke } from "@oxagen/oxagen/kernel";
import "@oxagen/handlers/register";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace } from "@/lib/resolve-org";

/**
 * Server action: dispatch a schema reconciliation job for the given versionId.
 * Returns the executionId (aex_…) for the caller to poll via schemaReconcileStatusAction.
 *
 * Used by PinChangeDialog.onDispatch to wire the pin → reconcile flow:
 *
 *   <PinChangeDialog
 *     onDispatch={async ({ versionId, prune }) => {
 *       const { executionId } = await schemaReconcileDispatchAction({ orgSlug, workspaceSlug, versionId, prune });
 *       // caller may store executionId for polling
 *     }}
 *   />
 */
export async function schemaReconcileDispatchAction(opts: {
  orgSlug: string;
  workspaceSlug: string;
  versionId: string;
  prune: boolean;
}): Promise<{ executionId: string }> {
  const session = await getSessionOrRedirect();
  const org = await resolveOrg(opts.orgSlug);
  const workspace = await resolveWorkspace(org.id, opts.workspaceSlug);

  const result = await invoke(
    "schema.reconcile.dispatch",
    { versionId: opts.versionId, prune: opts.prune },
    {
      orgId: org.id,
      workspaceId: workspace.id,
      userId: session.user.id,
      apiKeyId: null,
      requestId: crypto.randomUUID(),
      surface: "app" as const,
      messageId: null,
    },
    // schema.reconcile.dispatch exposes surfaces ["api","mcp","cli"] — NOT
    // "agent". The kernel matches the *contract* surface here, so we must pass a
    // surface the contract actually exposes; "api" mirrors the in-app proxy
    // route (AGENT_SURFACE_CAPABILITIES only contains schema.delete).
    { surface: "api" },
  );
  return result as { executionId: string };
}

/**
 * Server action: poll the status of a running reconciliation job.
 * The caller passes the executionId returned by schemaReconcileDispatchAction.
 */
export async function schemaReconcileStatusAction(
  orgSlug: string,
  workspaceSlug: string,
  executionId: string,
): Promise<{
  status: "planning" | "running" | "completed" | "failed" | "cancelled";
  totalNodes: number;
  processedNodes: number;
  updatedNodes: number;
  totalRelationships: number;
  processedRelationships: number;
  updatedRelationships: number;
  prunedNodes: number;
  prunedRelationships: number;
}> {
  const session = await getSessionOrRedirect();
  const org = await resolveOrg(orgSlug);
  const workspace = await resolveWorkspace(org.id, workspaceSlug);

  const result = await invoke(
    "schema.reconcile.status",
    { executionId },
    {
      orgId: org.id,
      workspaceId: workspace.id,
      userId: session.user.id,
      apiKeyId: null,
      requestId: crypto.randomUUID(),
      surface: "app" as const,
      messageId: null,
    },
    // schema.reconcile.status exposes surfaces ["api","mcp","cli"] — NOT "agent".
    // Same reasoning as schemaReconcileDispatchAction above.
    { surface: "api" },
  );
  return result as Awaited<ReturnType<typeof schemaReconcileStatusAction>>;
}
