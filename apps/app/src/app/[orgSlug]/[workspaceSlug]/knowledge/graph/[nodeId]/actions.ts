"use server";

/**
 * actions.ts — server actions for the Knowledge → Graph node-detail admin
 * panel: delete node, add/remove a Neo4j label, upsert/delete an outgoing
 * relationship (spec: docs/web-app-2.0/workspace/knowledge/graph/node/spec.md).
 *
 * Every action follows the same shape as knowledge/memory/actions.ts:
 *   1. getSessionOrRedirect() → session guard
 *   2. resolveOrg / resolveWorkspace → IDOR + org/workspace resolution
 *      (both already call notFound() on a miss — no need to re-check)
 *   3. assertOrgMember() → org membership guard
 *   4. assertOrgAdmin() → hard owner/admin gate. apps/app does NOT bootstrap
 *      IAM and invoke() skips role checks in the app surface, so every
 *      mutation here is gated to the same admin bar page.tsx uses to decide
 *      whether to render the admin panel at all (getOrgRole/isAdmin — the
 *      identical pattern used by knowledge/ontology/page.tsx). A caller who
 *      invokes the action directly, bypassing the UI, still hits this gate.
 *   5. invoke() with surface: "agent" (delete_node / add_node_label /
 *      remove_node_label / upsert_edge / delete_edge are graph.* capabilities,
 *      not "app"-surfaced, so passing "app" would throw surface_denied)
 *   6. revalidatePath() → invalidate the node-detail RSC
 */

import { revalidatePath } from "next/cache";
import { invoke } from "@oxagen/oxagen";
// Side-effect import: binds every handler so invoke() can resolve.
import "@oxagen/handlers/register";
import { runInTenantScope } from "@oxagen/tenancy";
import type { GraphNodeDeleteOutput } from "@oxagen/oxagen/contracts/graph.node.delete";
import type { GraphNodeLabelAddOutput } from "@oxagen/oxagen/contracts/graph.node_label.add";
import type { GraphNodeLabelRemoveOutput } from "@oxagen/oxagen/contracts/graph.node_label.remove";
import type { GraphEdgeUpsertOutput } from "@oxagen/oxagen/contracts/graph.edge.upsert";
import type { GraphEdgeDeleteOutput } from "@oxagen/oxagen/contracts/graph.edge.delete";
import { logger } from "@oxagen/handlers/logger";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertOrgMember,
  assertOrgAdmin,
} from "@/lib/resolve-org";

// ---------------------------------------------------------------------------
// Result types (exported for client prop typing)
// ---------------------------------------------------------------------------

export type DeleteNodeResult = { ok: true; deleted: boolean } | { ok: false; error: string };

export type AddNodeLabelResult =
  | { ok: true; labels: string[]; added: string[] }
  | { ok: false; error: string };

export type RemoveNodeLabelResult =
  | { ok: true; labels: string[]; removed: string[] }
  | { ok: false; error: string };

export type UpsertEdgeResult =
  | { ok: true; edgeId: string; created: boolean; superseded: number }
  | { ok: false; error: string };

export type DeleteEdgeResult = { ok: true; deleted: boolean } | { ok: false; error: string };

function nodePath(orgSlug: string, workspaceSlug: string, nodeId: string): string {
  return `/${orgSlug}/${workspaceSlug}/knowledge/graph/${nodeId}`;
}

// ---------------------------------------------------------------------------
// deleteNodeAction
// ---------------------------------------------------------------------------

export async function deleteNodeAction(input: {
  orgSlug: string;
  workspaceSlug: string;
  nodeId: string;
}): Promise<DeleteNodeResult> {
  const session = await getSessionOrRedirect();
  const { orgSlug, workspaceSlug, nodeId } = input;

  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);

  await assertOrgMember(org.id, session.user.id);
  await assertOrgAdmin(org.id, session.user.id);

  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const ctx = {
      orgId: org.id,
      workspaceId: ws.id,
      userId: session.user.id,
      apiKeyId: null as string | null,
      requestId: crypto.randomUUID(),
      surface: "app" as const,
      messageId: null as string | null,
    };

    try {
      const out = (await invoke(
        "delete_node",
        { nodeId },
        ctx,
        { surface: "agent" },
      )) as GraphNodeDeleteOutput;

      revalidatePath(nodePath(orgSlug, workspaceSlug, nodeId));
      revalidatePath(`/${orgSlug}/${workspaceSlug}/knowledge/graph`);
      return { ok: true, deleted: out.deleted };
    } catch (err) {
      logger.error(
        { err, orgId: org.id, workspaceId: ws.id, nodeId },
        "knowledge.node: deleteNodeAction failed",
      );
      const message = err instanceof Error ? err.message : "";
      return { ok: false, error: message || "Failed to delete node." };
    }
  });
}

// ---------------------------------------------------------------------------
// addNodeLabelAction
// ---------------------------------------------------------------------------

export async function addNodeLabelAction(input: {
  orgSlug: string;
  workspaceSlug: string;
  nodeId: string;
  labels: string[];
}): Promise<AddNodeLabelResult> {
  const session = await getSessionOrRedirect();
  const { orgSlug, workspaceSlug, nodeId, labels } = input;

  const trimmed = labels.map((l) => l.trim()).filter((l) => l.length > 0);
  if (trimmed.length === 0) {
    return { ok: false, error: "Enter at least one label." };
  }

  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);

  await assertOrgMember(org.id, session.user.id);
  await assertOrgAdmin(org.id, session.user.id);

  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const ctx = {
      orgId: org.id,
      workspaceId: ws.id,
      userId: session.user.id,
      apiKeyId: null as string | null,
      requestId: crypto.randomUUID(),
      surface: "app" as const,
      messageId: null as string | null,
    };

    try {
      const out = (await invoke(
        "add_node_label",
        { nodeId, labels: trimmed },
        ctx,
        { surface: "agent" },
      )) as GraphNodeLabelAddOutput;

      revalidatePath(nodePath(orgSlug, workspaceSlug, nodeId));
      return { ok: true, labels: out.labels, added: out.added };
    } catch (err) {
      logger.error(
        { err, orgId: org.id, workspaceId: ws.id, nodeId },
        "knowledge.node: addNodeLabelAction failed",
      );
      const message = err instanceof Error ? err.message : "";
      return { ok: false, error: message || "Failed to add label." };
    }
  });
}

// ---------------------------------------------------------------------------
// removeNodeLabelAction
// ---------------------------------------------------------------------------

export async function removeNodeLabelAction(input: {
  orgSlug: string;
  workspaceSlug: string;
  nodeId: string;
  labels: string[];
}): Promise<RemoveNodeLabelResult> {
  const session = await getSessionOrRedirect();
  const { orgSlug, workspaceSlug, nodeId, labels } = input;

  const trimmed = labels.map((l) => l.trim()).filter((l) => l.length > 0);
  if (trimmed.length === 0) {
    return { ok: false, error: "No label to remove." };
  }

  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);

  await assertOrgMember(org.id, session.user.id);
  await assertOrgAdmin(org.id, session.user.id);

  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const ctx = {
      orgId: org.id,
      workspaceId: ws.id,
      userId: session.user.id,
      apiKeyId: null as string | null,
      requestId: crypto.randomUUID(),
      surface: "app" as const,
      messageId: null as string | null,
    };

    try {
      const out = (await invoke(
        "remove_node_label",
        { nodeId, labels: trimmed },
        ctx,
        { surface: "agent" },
      )) as GraphNodeLabelRemoveOutput;

      revalidatePath(nodePath(orgSlug, workspaceSlug, nodeId));
      return { ok: true, labels: out.labels, removed: out.removed };
    } catch (err) {
      logger.error(
        { err, orgId: org.id, workspaceId: ws.id, nodeId },
        "knowledge.node: removeNodeLabelAction failed",
      );
      const message = err instanceof Error ? err.message : "";
      return { ok: false, error: message || "Failed to remove label." };
    }
  });
}

// ---------------------------------------------------------------------------
// upsertEdgeAction
// ---------------------------------------------------------------------------

export async function upsertEdgeAction(input: {
  orgSlug: string;
  workspaceSlug: string;
  fromNodeId: string;
  toNodeId: string;
  relationshipType: string;
}): Promise<UpsertEdgeResult> {
  const session = await getSessionOrRedirect();
  const { orgSlug, workspaceSlug, fromNodeId } = input;

  const toNodeId = input.toNodeId.trim();
  const relationshipType = input.relationshipType.trim();
  if (!toNodeId || !relationshipType) {
    return { ok: false, error: "Target node id and relationship type are required." };
  }

  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);

  await assertOrgMember(org.id, session.user.id);
  await assertOrgAdmin(org.id, session.user.id);

  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const ctx = {
      orgId: org.id,
      workspaceId: ws.id,
      userId: session.user.id,
      apiKeyId: null as string | null,
      requestId: crypto.randomUUID(),
      surface: "app" as const,
      messageId: null as string | null,
    };

    try {
      const out = (await invoke(
        "upsert_edge",
        { fromNodeId, toNodeId, relationshipType },
        ctx,
        { surface: "agent" },
      )) as GraphEdgeUpsertOutput;

      revalidatePath(nodePath(orgSlug, workspaceSlug, fromNodeId));
      return { ok: true, edgeId: out.edgeId, created: out.created, superseded: out.superseded };
    } catch (err) {
      logger.error(
        { err, orgId: org.id, workspaceId: ws.id, fromNodeId, toNodeId },
        "knowledge.node: upsertEdgeAction failed",
      );
      const message = err instanceof Error ? err.message : "";
      return { ok: false, error: message || "Failed to add relationship." };
    }
  });
}

// ---------------------------------------------------------------------------
// deleteEdgeAction
// ---------------------------------------------------------------------------

export async function deleteEdgeAction(input: {
  orgSlug: string;
  workspaceSlug: string;
  fromNodeId: string;
  toNodeId: string;
  edgeType: string;
}): Promise<DeleteEdgeResult> {
  const session = await getSessionOrRedirect();
  const { orgSlug, workspaceSlug, fromNodeId } = input;

  const toNodeId = input.toNodeId.trim();
  const edgeType = input.edgeType.trim();
  if (!toNodeId || !edgeType) {
    return { ok: false, error: "Target node id and relationship type are required." };
  }

  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);

  await assertOrgMember(org.id, session.user.id);
  await assertOrgAdmin(org.id, session.user.id);

  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, async () => {
    const ctx = {
      orgId: org.id,
      workspaceId: ws.id,
      userId: session.user.id,
      apiKeyId: null as string | null,
      requestId: crypto.randomUUID(),
      surface: "app" as const,
      messageId: null as string | null,
    };

    try {
      const out = (await invoke(
        "delete_edge",
        { fromNodeId, toNodeId, edgeType },
        ctx,
        { surface: "agent" },
      )) as GraphEdgeDeleteOutput;

      revalidatePath(nodePath(orgSlug, workspaceSlug, fromNodeId));
      return { ok: true, deleted: out.deleted };
    } catch (err) {
      logger.error(
        { err, orgId: org.id, workspaceId: ws.id, fromNodeId, toNodeId, edgeType },
        "knowledge.node: deleteEdgeAction failed",
      );
      const message = err instanceof Error ? err.message : "";
      return { ok: false, error: message || "Failed to remove relationship." };
    }
  });
}
