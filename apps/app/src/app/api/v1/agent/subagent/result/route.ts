/**
 * GET /api/v1/agent/subagent/result?workspaceId=<id>&runId=<runId>
 *
 * Same-origin read seam for the Fleet child-detail drawer
 * (activity/fleet/child-drawer.tsx) — fetches ONE subagent child run's full
 * input/output payload via get_subagent_result. Kept out of the RSC read path
 * because it's opened lazily, per-child, on drawer click (not on page load).
 *
 * Auth: session required, then workspace membership resolved + asserted via
 * resolveWorkspaceScope (the canonical seam for routes that receive a
 * workspaceId, not slugs, from the client) — mirrors graph/explore/route.ts.
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import "@oxagen/handlers/register";
// get_subagent_result is an agent.* capability bound by @oxagen/agent/register,
// NOT the foundation register — without this invoke() throws "No handler
// registered" (mirrors memories-section.tsx).
import "@oxagen/agent/register";
import { invoke } from "@oxagen/oxagen";
import { runInTenantScope } from "@oxagen/tenancy";
import { isSubagentRunNotFoundError } from "@oxagen/agent";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveWorkspaceScope } from "@/lib/resolve-org";
import type { AgentSubagentResultGetOutput } from "@oxagen/oxagen/contracts/agent.subagent_result.get";

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
        "get_subagent_result",
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
    )) as AgentSubagentResultGetOutput;
    return NextResponse.json(out);
  } catch (err) {
    if (isSubagentRunNotFoundError(err)) {
      return NextResponse.json({ error: "Subagent run not found" }, { status: 404 });
    }
    console.error("[agent/subagent/result] get_subagent_result failed", err);
    return NextResponse.json({ error: "Failed to load subagent result" }, { status: 500 });
  }
}
