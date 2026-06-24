import "@oxagen/handlers/register";

import { type NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace, assertOrgMember, getOrgRole } from "@/lib/resolve-org";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen";

export const runtime = "nodejs";

// Schema-registry browser proxy. Lives at /api/schema/* (NOT /api/v1/schema/*)
// on purpose: apps/app rewrites /api/v1/:path* to the Hono API, which would
// shadow a catch-all filesystem route. /api/schema/* sits outside that rewrite
// so this route reliably handles the call and drives invoke() in-process with
// explicit IAM (apps/app does not bootstrap IAM).
//
// Capabilities that require the caller to hold owner or admin role.
// Capabilities whose contract surfaces are agent-only (no "api" surface): the
// kernel rejects them over surface "api", so the in-app proxy must invoke them
// over "agent". e.g. schema.delete ships ["agent"] to keep route/tool parity
// truthful, but the schema-builder drawer still needs to drive it.
const AGENT_SURFACE_CAPABILITIES = new Set(["schema.delete"]);

const ADMIN_ONLY_CAPABILITIES = new Set([
  "schema.toggle",
  "schema.registry.config",
  "schema.reconcile.dispatch",
]);

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  // ── Auth ─────────────────────────────────────────────────────────────────
  let session: Awaited<ReturnType<typeof getSessionOrRedirect>>;
  try {
    session = await getSessionOrRedirect();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── Resolve capability from path segments ─────────────────────────────
  const { path } = await params;
  const capability = `schema.${path.join(".")}`;

  // ── Parse body ────────────────────────────────────────────────────────
  let rawBody: Record<string, unknown>;
  try {
    rawBody = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { orgSlug, workspaceSlug, ...input } = rawBody;
  if (typeof orgSlug !== "string" || !orgSlug || typeof workspaceSlug !== "string" || !workspaceSlug) {
    return NextResponse.json({ error: "orgSlug and workspaceSlug are required" }, { status: 400 });
  }

  // ── Tenant resolution ─────────────────────────────────────────────────
  let tenant: Awaited<ReturnType<typeof resolveOrg>>;
  let workspace: Awaited<ReturnType<typeof resolveWorkspace>>;
  try {
    tenant = await resolveOrg(orgSlug);
    await assertOrgMember(tenant.id, session.user.id);
    workspace = await resolveWorkspace(tenant.id, workspaceSlug);
  } catch {
    return NextResponse.json({ error: "Org or workspace not found" }, { status: 404 });
  }

  // ── IAM gate for admin-only capabilities ───────────────────────────────
  if (ADMIN_ONLY_CAPABILITIES.has(capability)) {
    const role = await getOrgRole(tenant.id, session.user.id);
    if (role !== "owner" && role !== "admin") {
      return NextResponse.json({ error: "Forbidden: requires owner or admin role" }, { status: 403 });
    }
  }

  // ── Invoke handler ─────────────────────────────────────────────────────
  const requestId = randomUUID();
  const capCtx = {
    orgId: tenant.id,
    workspaceId: workspace.id,
    userId: session.user.id,
    apiKeyId: null as string | null,
    requestId,
    surface: "app" as const,
    messageId: requestId,
    clientIp: null as string | null,
  };

  try {
    const result = await runInTenantScope(
      { orgId: tenant.id, workspaceId: workspace.id },
      () =>
        invoke(capability, input, capCtx, {
          surface: AGENT_SURFACE_CAPABILITIES.has(capability) ? "agent" : "api",
        }),
    );
    return NextResponse.json(result ?? {});
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    if (message.includes("Forbidden") || message.includes("IAM")) {
      return NextResponse.json({ error: message }, { status: 403 });
    }
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
