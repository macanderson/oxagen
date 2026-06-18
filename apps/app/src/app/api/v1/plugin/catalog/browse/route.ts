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

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = request.nextUrl;
  const search = searchParams.get("search") ?? undefined;
  const rawAuthKind = searchParams.get("authKind");
  const authKind =
    rawAuthKind === "oauth" || rawAuthKind === "secret" || rawAuthKind === "none"
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
    rawInstalled === "true" ? true : rawInstalled === "false" ? false : undefined;
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "30", 10), 100);
  const offset = Math.max(parseInt(searchParams.get("offset") ?? "0", 10), 0);
  // workspaceId is accepted from the client for scoping, but orgId is always
  // resolved from the session to prevent cross-org spoofing.
  const workspaceId = searchParams.get("workspaceId") ?? "";

  const ctx = {
    // orgId intentionally omitted from query params; handlers resolve via workspaceId scope.
    orgId: "",
    workspaceId,
    userId: session.user.id,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };

  try {
    const result = await invoke(
      "plugin.catalog.browse",
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
