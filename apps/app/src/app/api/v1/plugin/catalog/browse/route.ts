/**
 * GET /api/v1/plugin/catalog/browse
 *
 * Returns a paginated list of catalog servers for the marketplace modal.
 * Authentication required; org context is not required (catalog is global).
 *
 * Query params:
 *   search    — optional text search
 *   authKind  — optional filter: oauth | secret | none
 *   installed — optional filter: "true" (installed only) | "false" (not installed only)
 *   limit     — page size (max 100, default 30)
 *   offset    — pagination offset (default 0)
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
    rawPluginType === "content_tool" ||
    rawPluginType === "capability"
      ? rawPluginType
      : undefined;
  const rawInstalled = searchParams.get("installed");
  const installed =
    rawInstalled === "true" ? true : rawInstalled === "false" ? false : undefined;
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "30", 10), 100);
  const offset = Math.max(parseInt(searchParams.get("offset") ?? "0", 10), 0);
  const workspaceId = searchParams.get("workspaceId") ?? undefined;
  // orgId: passed from query param when available so installed state is resolved per-org.
  // Falls back to empty string (catalog is global; installed=false for anonymous browse).
  const orgId = searchParams.get("orgId") ?? "";

  const ctx = {
    orgId,
    workspaceId: workspaceId ?? "",
    userId: session.user.id,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };

  try {
    const result = await invoke(
      "plugin.catalog.browse",
      { search, authKind, pluginType, installed, limit, offset, workspaceId },
      ctx,
      { surface: "agent" },
    );
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Browse failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
