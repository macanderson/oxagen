/**
 * POST /api/v1/graph/explore
 *
 * The single data seam for the knowledge-graph explorer. A discriminated `op`
 * field selects the composition (initial graph, expand a node, paginated table,
 * search, or node detail); each is assembled server-side from the wired graph
 * capabilities in `explore-service.ts`. Read-only — the explorer never mutates.
 *
 * Auth: session required, then workspace membership asserted (IDOR guard) before
 * any org-scoped data is touched. Mirrors the resolve/membership pattern used by
 * the chat stream route.
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertWorkspaceMember,
} from "@/lib/resolve-org";
import { logger } from "@oxagen/handlers/logger";
import { dispatchExplore } from "@/components/knowledge/graph-explorer/explore-service";
import type { ExploreRequest } from "@/components/knowledge/graph-explorer/types";

const TenantFields = {
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
};

// Discriminated by `op`. Limits are clamped again in the service, but bound
// them here too so a single request can never ask for an unbounded page.
//
// Every branch the client (`api-client.ts`) and service (`explore-service.ts`
// `dispatchExplore`) support MUST appear here — a missing branch makes the
// discriminated union reject the body with a 400, which silently breaks that
// op for the whole explorer (this is exactly how `vocab` + the node/edge CRUD
// ops regressed: the schema lagged the client/service by six ops). Keep this
// union in lockstep with the `ExploreRequest` union in `./types.ts`.
const BodySchema = z.discriminatedUnion("op", [
  z.object({
    ...TenantFields,
    op: z.literal("graph"),
    labels: z.array(z.string().min(1)).max(50).optional(),
    limit: z.number().int().min(1).max(250).optional(),
    // Opt-in to runtime lineage (is_system) nodes. Absent/false = the default
    // explore view: only the customer's source-system ontology is seeded.
    includeSystem: z.boolean().optional(),
  }),
  z.object({
    ...TenantFields,
    op: z.literal("expand"),
    nodeId: z.string().min(1).max(512),
  }),
  z.object({
    ...TenantFields,
    op: z.literal("nodes"),
    labels: z.array(z.string().min(1)).max(50).optional(),
    query: z.string().max(500).optional(),
    limit: z.number().int().min(1).max(250).optional(),
    offset: z.number().int().min(0).optional(),
    includeSystem: z.boolean().optional(),
  }),
  z.object({
    ...TenantFields,
    op: z.literal("search"),
    query: z.string().min(1).max(500),
    labels: z.array(z.string().min(1)).max(50).optional(),
  }),
  z.object({
    ...TenantFields,
    op: z.literal("node"),
    nodeId: z.string().min(1).max(512),
  }),
  // Vocabulary — distinct labels + relationship types, fetched on mount to
  // populate the create/edit dialogs. No payload beyond tenant scope.
  z.object({
    ...TenantFields,
    op: z.literal("vocab"),
  }),
  // Similarity search — embedding/fuzzy node lookup for edge endpoint pickers.
  z.object({
    ...TenantFields,
    op: z.literal("similaritySearch"),
    query: z.string().min(1).max(500),
    limit: z.number().int().min(1).max(250).optional(),
  }),
  // Mutation ops — node/edge CRUD. The service routes these through the
  // metered `graph.*` capabilities; workspace membership is asserted below
  // before any op runs, so these are gated identically to the read ops.
  z.object({
    ...TenantFields,
    op: z.literal("upsertNode"),
    label: z.string().min(1).max(200),
    displayName: z.string().min(1).max(500),
    description: z.string().max(2000).optional(),
    properties: z.record(z.unknown()).optional(),
    externalId: z.string().min(1).max(512).optional(),
  }),
  z.object({
    ...TenantFields,
    op: z.literal("deleteNode"),
    nodeId: z.string().min(1).max(512),
  }),
  z.object({
    ...TenantFields,
    op: z.literal("upsertEdge"),
    fromNodeId: z.string().min(1).max(512),
    toNodeId: z.string().min(1).max(512),
    relationshipType: z.string().min(1).max(200),
    properties: z.record(z.string()).optional(),
  }),
  z.object({
    ...TenantFields,
    op: z.literal("deleteEdge"),
    fromNodeId: z.string().min(1).max(512),
    toNodeId: z.string().min(1).max(512),
    edgeType: z.string().min(1).max(200),
  }),
]);

export async function POST(request: NextRequest): Promise<Response> {
  let session: Awaited<ReturnType<typeof getSessionOrRedirect>>;
  try {
    session = await getSessionOrRedirect();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }

  const body = parsed.data;

  let orgId: string;
  let workspaceId: string;
  try {
    const org = await resolveOrg(body.orgSlug);
    const workspace = await resolveWorkspace(org.id, body.workspaceSlug);
    // IDOR guard: assert workspace membership before honouring the request.
    await assertWorkspaceMember(workspace.id, session.user.id);
    orgId = org.id;
    workspaceId = workspace.id;
  } catch {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  try {
    const result = await dispatchExplore(body as ExploreRequest, {
      orgId,
      workspaceId,
      userId: session.user.id,
      apiKeyId: null,
      requestId: crypto.randomUUID(),
      surface: "app",
      messageId: null,
    });
    return NextResponse.json(result);
  } catch (err) {
    logger.error(
      { err, op: body.op, orgId, workspaceId },
      "[graph/explore] op failed",
    );
    return NextResponse.json(
      { error: "Graph explore failed" },
      { status: 500 },
    );
  }
}
