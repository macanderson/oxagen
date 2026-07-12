/**
 * GET /api/v1/agent/subagent/siblings?workspaceId=<id>&runId=<runId>
 *
 * Same-origin read seam for the Fleet child-detail drawer's "Siblings"
 * section (activity/fleet/child-drawer.tsx) — given a running child's runId,
 * returns its fanout siblings as compact rows via list_subagent_siblings.
 * Loaded on demand (a "Load siblings" click), only offered while the child is
 * still running.
 *
 * Auth: session required, then workspace membership resolved + asserted via
 * resolveWorkspaceScope — mirrors ./result/route.ts and graph/explore/route.ts.
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import "@oxagen/handlers/register";
// list_subagent_siblings is an agent.* capability bound by @oxagen/agent/register,
// NOT the foundation register — without this invoke() throws "No handler
// registered" (mirrors memories-section.tsx).
import "@oxagen/agent/register";
import { invoke } from "@oxagen/oxagen";
import { runInTenantScope } from "@oxagen/tenancy";
import { isSubagentRunNotFoundError } from "@oxagen/agent";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveWorkspaceScope } from "@/lib/resolve-org";
import type { AgentSubagentSiblingsOutput } from "@oxagen/oxagen/contracts/agent.subagent.siblings";

const QuerySchema = z.object({
  workspaceId: z.string().min(1),
  runId: z.string().min(1),
});

export async function GET(request: NextRequest): Promise<Response> {
  let session: Awaited<ReturnType<typeof getSessionOrRedirect>>;
  try {
    session = await getSessionOrRedirect();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    workspaceId: url.searchParams.get("workspaceId"),
    runId: url.searchParams.get("runId"),
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid query" },
      { status: 400 },
    );
  }
  const { workspaceId, runId } = parsed.data;

  const scope = await resolveWorkspaceScope(workspaceId, session.user.id);
  if (!scope) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  try {
    const out = (await runInTenantScope(scope, () =>
      invoke(
        "list_subagent_siblings",
        { runId },
        {
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          userId: session.user.id,
          apiKeyId: null,
          requestId: crypto.randomUUID(),
          surface: "app",
          messageId: null,
        },
        { surface: "agent" },
      ),
    )) as AgentSubagentSiblingsOutput;
    return NextResponse.json(out);
  } catch (err) {
    if (isSubagentRunNotFoundError(err)) {
      return NextResponse.json({ error: "Subagent run not found" }, { status: 404 });
    }
    console.error("[agent/subagent/siblings] list_subagent_siblings failed", err);
    return NextResponse.json({ error: "Failed to load siblings" }, { status: 500 });
  }
}
