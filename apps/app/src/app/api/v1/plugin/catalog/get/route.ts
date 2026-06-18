/**
 * GET /api/v1/plugin/catalog/get
 *
 * Returns full detail for a single catalog server (for the marketplace detail panel).
 * Authentication required.
 *
 * Query params:
 *   name    — required, the registry server name (e.g. "@anthropic-ai/mcp-server-brave-search")
 *   version — optional, semver string or "latest" (default: "latest")
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

  const name = request.nextUrl.searchParams.get("name");
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  const version = request.nextUrl.searchParams.get("version") ?? "latest";

  const ctx = {
    orgId: "",
    workspaceId: "",
    userId: session.user.id,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };

  try {
    const result = await invoke(
      "plugin.catalog.get",
      { name, version },
      ctx,
      { surface: "agent" },
    );
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Get failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
