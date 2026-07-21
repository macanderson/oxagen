"use server";
/**
 * message-footer-actions.ts — server actions for the MessageFooter component.
 *
 * Provides the "Save as Memory" (agent.memory.write) action through the invoke() kernel boundary
 * so metering, IAM, and audit are enforced.
 */
import { invoke } from "@oxagen/oxagen";
import { agentMemoryWrite } from "@oxagen/oxagen/contracts/agent.memory.write";
// Side-effect: bind handlers into the kernel so invoke() can resolve them.
import "@oxagen/handlers/register";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertOrgMember,
} from "@/lib/resolve-org";

export interface MessageFooterActionCtx {
  orgSlug: string;
  workspaceSlug: string;
}

export type MessageFooterActionResult =
  | { ok: true }
  | { ok: false; error: string };

async function resolveScope(ctx: MessageFooterActionCtx) {
  const session = await getSessionOrRedirect();
  const org = await resolveOrg(ctx.orgSlug);
  const ws = await resolveWorkspace(org.id, ctx.workspaceSlug);
  await assertOrgMember(org.id, session.user.id);
  return {
    capabilityCtx: {
      orgId: org.id,
      workspaceId: ws.id,
      userId: session.user.id,
      apiKeyId: null as string | null,
      requestId: crypto.randomUUID(),
      surface: "app" as const,
      messageId: null as string | null,
    },
  };
}

/**
 * Save the given assistant message text as an agent memory via agent.memory.write.
 * Uses the two-axis model's default epistemic class (OBSERVATION — no
 * enforcement) and a "gotcha" kind so the lesson is retrievable across turns
 * without asserting a policy the memory hasn't earned yet (that happens via
 * agent.memory.promote once it accrues citation evidence).
 */
export async function saveAsMemoryAction(
  ctx: MessageFooterActionCtx,
  text: string,
): Promise<MessageFooterActionResult> {
  const parsed = agentMemoryWrite.input.safeParse({
    nodeRef: `chat-message:${Date.now()}`,
    memoryClass: "OBSERVATION",
    memoryKind: "gotcha",
    lesson: text.slice(0, 2000),
    source: "exception-watcher",
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }
  try {
    const { capabilityCtx } = await resolveScope(ctx);
    await invoke(agentMemoryWrite.name, parsed.data, capabilityCtx, {
      surface: "agent",
    });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to save memory",
    };
  }
}
