/**
 * POST /api/v1/agent/subagent/logs
 * body: { workspaceId: string; fanoutId: string; title?: string }
 *
 * Same-origin write seam for the Fleet "Download markdown logfile" action
 * (fleet-detail-client.tsx header + child-drawer.tsx) — generates a
 * downloadable markdown logfile for a fan-out via get_subagent_logs and
 * returns its serve URL. get_subagent_logs is fanout-scoped (not per-child):
 * the produced document covers every child run's capability, timing, and
 * full input/output.
 *
 * Auth: session required, then workspace membership resolved + asserted via
 * resolveWorkspaceScope — mirrors ../result/route.ts.
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import "@oxagen/handlers/register";
// get_subagent_logs is registered by the foundation @oxagen/handlers/register
// (packages/handlers/src/register.ts), unlike its five agent.subagent.* peers —
// no @oxagen/agent/register import needed for this one call, but it's a cheap,
// harmless no-op to import it anyway for consistency with the sibling routes.
import "@oxagen/agent/register";
import { invoke } from "@oxagen/oxagen";
import { runInTenantScope } from "@oxagen/tenancy";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveWorkspaceScope } from "@/lib/resolve-org";
import type { AgentSubagentLogsOutput } from "@oxagen/oxagen/contracts/agent.subagent.logs";

const BodySchema = z.object({
  workspaceId: z.string().min(1),
  fanoutId: z.string().min(1),
  title: z.string().max(200).optional(),
});

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
  const { workspaceId, fanoutId, title } = parsed.data;

  const scope = await resolveWorkspaceScope(workspaceId, session.user.id);
  if (!scope) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  try {
    const out = (await runInTenantScope(scope, () =>
      invoke(
        "get_subagent_logs",
        { fanoutId, title },
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
    )) as AgentSubagentLogsOutput;
    return NextResponse.json(out);
  } catch (err) {
    console.error("[agent/subagent/logs] get_subagent_logs failed", err);
    return NextResponse.json(
      { error: "Failed to generate logfile" },
      { status: 500 },
    );
  }
}
