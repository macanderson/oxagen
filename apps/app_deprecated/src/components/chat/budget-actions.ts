"use server";
/**
 * budget-actions.ts — server action for the composer's BudgetControl
 * "Save as default" affordance.
 *
 * Routes through the `budget.policy.write` capability handler (never a direct
 * DB write). `budget.policy` is user-scoped (`scoped: false` on the
 * contract) — no org/workspace context is needed, so (unlike most chat server
 * actions) this file needs only the session, matching the account
 * preferences-action.ts pattern rather than the org/workspace-scoped
 * message-footer-actions.ts pattern.
 */
import { getSessionOrRedirect } from "@/lib/session";
import { invoke } from "@oxagen/oxagen";
import { budgetPolicyWrite } from "@oxagen/oxagen/contracts/budget.policy.write";
// Side-effect import: bind every foundation handler into the shared kernel so
// invoke("update_user_budget", …) can resolve its handler at runtime.
import "@oxagen/handlers/register";
import type { CapabilityContext } from "@oxagen/oxagen";

export interface BudgetDefaultInput {
  enabled: boolean;
  limitUsd: number | null;
  mode: "grace" | "prompt" | "enforce";
  graceOveragePct: number;
}

export type BudgetActionResult = { ok: true } | { ok: false; error: string };

/** Persist the composer's current per-turn budget as the user's saved default. */
export async function saveBudgetDefaultAction(
  input: BudgetDefaultInput,
): Promise<BudgetActionResult> {
  const session = await getSessionOrRedirect();

  const parsed = budgetPolicyWrite.input.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid budget",
    };
  }

  // budget.policy is user-scoped (scoped: false) — orgId/workspaceId are
  // sentinel values, matching the account preferences server action.
  const ctx: CapabilityContext = {
    orgId: "",
    workspaceId: "",
    userId: session.user.id,
    apiKeyId: null,
    requestId: crypto.randomUUID(),
    surface: "app",
    messageId: null,
  };

  try {
    await invoke("update_user_budget", parsed.data, ctx, { surface: "agent" });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error ? err.message : "Failed to save budget default",
    };
  }
}
