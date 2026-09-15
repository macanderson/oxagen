/**
 * GET /api/v1/plugin/catalog/browse
 *
 * Returns a paginated list of catalog servers for the marketplace modal.
 * Authentication required; workspace context is resolved from the workspaceId
 * query param (which the server validates against session membership).
 * orgId is NOT accepted as a query param — it is resolved server-side from
 * the session to prevent cross-org data leakage.
 *
 * Query params:
 *   pluginType — optional filter: mcp_server | integration | agent_capability | agent_skill | knowledge_source
 *   search     — optional text search
 *   authKind   — optional filter: oauth | secret | none
 *   installed  — optional filter: "true" (installed only) | "false" (not installed only)
 *   workspaceId — optional workspace scope (resolved + validated server-side)
 *   limit      — page size (max 100, default 30)
 *   offset     — pagination offset (default 0)
 */
import { type NextRequest, NextResponse } from "next/server";
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import { getSession } from "@/lib/session";
import { resolveWorkspaceScope } from "@/lib/resolve-org";

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = request.nextUrl;
  const search = searchParams.get("search") ?? undefined;
  const rawAuthKind = searchParams.get("authKind");
  const authKind =
    rawAuthKind === "oauth" ||
    rawAuthKind === "secret" ||
    rawAuthKind === "none"
      ? rawAuthKind
      : undefined;
  const rawPluginType = searchParams.get("pluginType");
  const pluginType =
    rawPluginType === "mcp_server" ||
    rawPluginType === "integration" ||
    rawPluginType === "agent_capability" ||
    rawPluginType === "agent_skill" ||
    rawPluginType === "knowledge_source"
      ? rawPluginType
      : undefined;
  const rawInstalled = searchParams.get("installed");
  const installed =
    rawInstalled === "true"
      ? true
      : rawInstalled === "false"
        ? false
        : undefined;
  // Safe parse: parseInt can return NaN for non-numeric input; NaN flows into
  // SQL LIMIT/OFFSET as an invalid value. Clamp to sane bounds after guarding
  // against NaN. Defaults match the JSDoc above (limit 30, offset 0; max 100).
  const rawLimit = Number.parseInt(searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), 100)
    : 30;
  const rawOffset = Number.parseInt(searchParams.get("offset") ?? "", 10);
  const offset = Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : 0;
  // The client sends only workspaceId; orgId is resolved server-side from it
  // (and membership is validated) via the canonical tenant seam — never trust a
  // client-supplied orgId, and never pass an empty placeholder into invoke().
  const workspaceId = searchParams.get("workspaceId") ?? "";
  const scope = await resolveWorkspaceScope(workspaceId, session.user.id);
  if (!scope) {
    return NextResponse.json(
      { error: "Workspace not found or access denied" },
      { status: 404 },
    );
  }

  const ctx = {
    orgId: scope.orgId,
    workspaceId: scope.workspaceId,
    userId: session.user.id,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };

  try {
    const result = await invoke(
      "browse_plugin_catalog",
      { search, authKind, pluginType, installed, limit, offset },
      ctx,
      { surface: "agent" },
    );
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Browse failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
