/**
 * GET /api/v1/plugin/catalog/get
 *
 * Returns full detail for a single catalog server (for the marketplace detail panel).
 * Authentication required.
 *
 * Query params:
 *   name        — required, the registry server name (e.g. "@anthropic-ai/mcp-server-brave-search")
 *   version     — optional, semver string or "latest" (default: "latest")
 *   workspaceId — required; orgId + membership are resolved server-side from it
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

  const name = request.nextUrl.searchParams.get("name");
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  const version = request.nextUrl.searchParams.get("version") ?? "latest";

  const workspaceId = request.nextUrl.searchParams.get("workspaceId") ?? "";
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
    const result = await invoke("get_catalog_plugin", { name, version }, ctx, {
      surface: "agent",
    });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Get failed";
    // "catalog server not found: …" is an expected miss (e.g. an MCP server that
    // isn't in any enabled registry) — surface it as 404 so the client renders a
    // clean "not found" state instead of treating a 500 body as plugin detail.
    const status = /not found/i.test(message) ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
