import "@oxagen/handlers/register";

import { type NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertOrgMember,
  getOrgRole,
} from "@/lib/resolve-org";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen";
import { logger } from "@oxagen/handlers/logger";

// Runs on the default Node.js runtime (invoke() uses Node built-ins). No
// `export const runtime` — the segment config is incompatible with
// cacheComponents, and Node is the framework default; never move to edge.

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
const AGENT_SURFACE_CAPABILITIES = new Set(["delete_schema"]);

const ADMIN_ONLY_CAPABILITIES = new Set([
  "toggle_schema",
  "get_registry_config",
  "dispatch_schema_reconcile",
]);

// Maps the browser-facing URL path (kept stable for the schema-service client)
// to the canonical ADR-025 verb-first capability name. The capability name is
// not a mechanical `schema.${path.join(".")}` transform of the URL, so it must
// be looked up explicitly.
const PATH_TO_CAPABILITY: Record<string, string> = {
  "registry/get": "get_schema_registry",
  "registry/config": "get_registry_config",
  list: "list_schemas",
  toggle: "toggle_schema",
  "label/upsert": "upsert_schema_label",
  "label/delete": "delete_schema_label",
  "relationship/upsert": "upsert_schema_relationship",
  "relationship/delete": "delete_schema_relationship",
  "property/upsert": "upsert_schema_property",
  "property/delete": "delete_schema_property",
  "version/list": "list_schema_versions",
  "version/diff": "diff_schema_versions",
  "version/create": "create_schema_version",
  "version/pin": "pin_schema_version",
  export: "export_schema",
  recommend: "recommend_schema",
  "reconcile/dispatch": "dispatch_schema_reconcile",
  "reconcile/status": "get_reconcile_status",
  setup: "setup_schema",
  "validate/node": "validate_schema_node",
  "validate/relationship": "validate_schema_relationship",
  chat: "run_schema_chat",
  delete: "delete_schema",
};

// The schema assistant applies chat-proposed mutations by POSTing the canonical
// capability name directly (see applyMutation in schema-service.ts), so accept
// any already-canonical name in addition to the mapped URL paths.
const KNOWN_CAPABILITIES = new Set(Object.values(PATH_TO_CAPABILITY));

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
  const pathKey = path.join("/");
  const capability =
    PATH_TO_CAPABILITY[pathKey] ??
    (KNOWN_CAPABILITIES.has(pathKey) ? pathKey : null);
  if (!capability) {
    return NextResponse.json(
      { error: `Unknown schema capability: ${pathKey}` },
      { status: 404 },
    );
  }

  // ── Parse body ────────────────────────────────────────────────────────
  let rawBody: Record<string, unknown>;
  try {
    rawBody = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { orgSlug, workspaceSlug, ...input } = rawBody;
  if (
    typeof orgSlug !== "string" ||
    !orgSlug ||
    typeof workspaceSlug !== "string" ||
    !workspaceSlug
  ) {
    return NextResponse.json(
      { error: "orgSlug and workspaceSlug are required" },
      { status: 400 },
    );
  }

  // ── Tenant resolution ─────────────────────────────────────────────────
  let tenant: Awaited<ReturnType<typeof resolveOrg>>;
  let workspace: Awaited<ReturnType<typeof resolveWorkspace>>;
  try {
    tenant = await resolveOrg(orgSlug);
    await assertOrgMember(tenant.id, session.user.id);
    workspace = await resolveWorkspace(tenant.id, workspaceSlug);
  } catch {
    return NextResponse.json(
      { error: "Org or workspace not found" },
      { status: 404 },
    );
  }

  // ── IAM gate for admin-only capabilities ───────────────────────────────
  if (ADMIN_ONLY_CAPABILITIES.has(capability)) {
    const role = await getOrgRole(tenant.id, session.user.id);
    if (role !== "owner" && role !== "admin") {
      return NextResponse.json(
        { error: "Forbidden: requires owner or admin role" },
        { status: 403 },
      );
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
    const message =
      err instanceof Error ? err.message : "Internal server error";
    // Log every failure server-side. Without this an infrastructure fault (DB
    // outage, unregistered handler, Neo4j down) is indistinguishable from a bad
    // request: the caller gets a 400 and nothing reaches the server logs or
    // ClickHouse, so a recurring defect stays invisible to an operator.
    logger.error(
      {
        err,
        capability,
        orgId: tenant.id,
        workspaceId: workspace.id,
        requestId,
      },
      "[api/schema] capability invocation failed",
    );
    if (message.includes("Forbidden") || message.includes("IAM")) {
      return NextResponse.json({ error: message }, { status: 403 });
    }
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
