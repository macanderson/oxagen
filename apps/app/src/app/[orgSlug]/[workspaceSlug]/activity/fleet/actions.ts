"use server";
/**
 * activity/fleet/actions.ts — server actions for the Fleet surface.
 *
 * Only one mutation exists today: cancelling an in-progress subagent fan-out.
 * Follows the house pattern (mirrors workbench/sandboxes/actions.ts):
 *   1. zod safeParse the client payload,
 *   2. resolveWorkbenchScope → session + org + workspace + IAM,
 *   3. gate on `canManage` (workspace Owner/Admin) — apps/app does NOT
 *      bootstrap IAM through invoke(), so this IS the authorization gate,
 *   4. invoke("cancel_subagent", …) inside runInTenantScope,
 *   5. return a discriminated union { ok: true, … } | { ok: false, error }.
 */
import "@oxagen/handlers/register";
// cancel_subagent is an agent.* capability bound by @oxagen/agent/register,
// NOT the foundation register — without this invoke() throws "No handler
// registered for capability cancel_subagent" (mirrors memories-section.tsx).
import "@oxagen/agent/register";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { invoke } from "@oxagen/oxagen";
import { runInTenantScope } from "@oxagen/tenancy";
import { logger } from "@oxagen/handlers/logger";
import { resolveWorkbenchScope } from "@/lib/workbench/scope";
import { workspace } from "@/lib/routes";
import type { AgentSubagentCancelOutput } from "@oxagen/oxagen/contracts/agent.subagent.cancel";

const scopeShape = {
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
};

const cancelSchema = z.object({
  ...scopeShape,
  fanoutId: z.string().min(1),
});

export type ActionResult<T = unknown> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export async function cancelFanoutAction(
  input: z.input<typeof cancelSchema>,
): Promise<ActionResult<{ fanout: AgentSubagentCancelOutput }>> {
  const parsed = cancelSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    };
  }
  const { orgSlug, workspaceSlug, fanoutId } = parsed.data;
  const { ctx, canManage } = await resolveWorkbenchScope(
    orgSlug,
    workspaceSlug,
  );
  if (!canManage) {
    return {
      ok: false,
      error: "Only workspace owners and admins can cancel a fan-out.",
    };
  }
  try {
    const fanout = (await runInTenantScope(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      () => invoke("cancel_subagent", { fanoutId }, ctx, { surface: "agent" }),
    )) as AgentSubagentCancelOutput;
    revalidatePath(workspace.activity.fleet({ orgSlug, workspaceSlug }));
    return { ok: true, fanout };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId, fanoutId },
      "activity.fleet: cancelFanoutAction failed",
    );
    return { ok: false, error: errMessage(err, "Failed to cancel fan-out.") };
  }
}
