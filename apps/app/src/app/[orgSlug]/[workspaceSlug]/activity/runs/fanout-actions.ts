"use server";
/**
 * fanout-actions.ts — read-only server actions for the subagent fan-out viewer.
 *
 * These power the live polling on the client surface. Each resolves the org +
 * workspace, asserts org membership, enters tenant scope, and invokes the
 * read capability through the shared kernel (metering + IAM in one place):
 *   resolveOrg → resolveWorkspace → assertOrgMember → runInTenantScope → invoke.
 *
 * Read capabilities only — no mutations, so no owner/admin write gate.
 */
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen";
// Side-effect imports: bind foundation + agent.* handlers so invoke() resolves.
import "@oxagen/handlers/register";
import "@oxagen/agent/register";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
import type { AgentSubagentFanoutListOutput } from "@oxagen/oxagen/contracts/agent.subagent.fanout.list";
import type { AgentSubagentFanoutGetOutput } from "@oxagen/oxagen/contracts/agent.subagent.fanout.get";

export type { AgentSubagentFanoutListOutput, AgentSubagentFanoutGetOutput };

interface ScopeArgs {
  orgSlug: string;
  workspaceSlug: string;
}

async function withReadScope<T>(
  scope: ScopeArgs,
  fn: (ctx: {
    orgId: string;
    workspaceId: string;
    userId: string;
    apiKeyId: string | null;
    requestId: string;
    surface: "app";
    messageId: string | null;
  }) => Promise<T>,
): Promise<T> {
  const session = await getSessionOrRedirect();
  const org = await resolveOrg(scope.orgSlug);
  const ws = await resolveWorkspace(org.id, scope.workspaceSlug);
  await assertOrgMember(org.id, session.user.id);

  return runInTenantScope({ orgId: org.id, workspaceId: ws.id }, () =>
    fn({
      orgId: org.id,
      workspaceId: ws.id,
      userId: session.user.id,
      apiKeyId: null,
      requestId: crypto.randomUUID(),
      surface: "app",
      messageId: null,
    }),
  );
}

// List fan-outs for the workspace, newest first.
export async function listFanoutsAction(
  scope: ScopeArgs,
): Promise<AgentSubagentFanoutListOutput> {
  return withReadScope(scope, (ctx) =>
    invoke(
      "agent.subagent.fanout.list",
      { limit: 50 },
      ctx,
      { surface: "agent" },
    ) as Promise<AgentSubagentFanoutListOutput>,
  );
}

// Get one fan-out with its child runs.
export async function getFanoutAction(
  scope: ScopeArgs,
  fanoutId: string,
): Promise<AgentSubagentFanoutGetOutput> {
  return withReadScope(scope, (ctx) =>
    invoke(
      "agent.subagent.fanout.get",
      { fanoutId },
      ctx,
      { surface: "agent" },
    ) as Promise<AgentSubagentFanoutGetOutput>,
  );
}
