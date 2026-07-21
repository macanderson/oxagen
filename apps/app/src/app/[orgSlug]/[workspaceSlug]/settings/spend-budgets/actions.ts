"use server";
/**
 * actions.ts — server actions for Workspace → Settings → Spend Budgets
 * (OXA-1079). Wraps get_spend_budget / set_spend_budget.
 *
 * Placement rationale (do not move this under [orgSlug]/billing/*):
 * getScopeBudgets() in packages/billing/src/spend-budget-store.ts relies on
 * Postgres RLS to narrow to "(org-default row) OR (this workspace's row)".
 * Only a scope with a REAL workspaceId returns both rows. The org-level
 * billing/* routes use a sentinel zero-UUID workspace and would silently see
 * only the org row — and a set() from there would write a workspace ceiling
 * against the sentinel. This page resolves the actual workspace, so both
 * scopes round-trip correctly.
 *
 * Authorization: apps/app does NOT bootstrap kernel IAM (invoke() called
 * from apps/app skips the kernel's role checks entirely — see CLAUDE.md),
 * so assertBillingManager here IS the authorization gate for BOTH actions —
 * mirroring the identical gate() shape in ../../billing/revenue/actions.ts.
 * Note this is intentionally narrower than the contracts' own
 * `defaultRoles` (get_spend_budget allows any org/workspace Member to read);
 * the app surface keeps a single, well-understood boundary — billing
 * managers only — for both viewing and editing this panel.
 */
import { invoke } from "@oxagen/oxagen";
// Side-effect import binds every handler into the kernel — without it
// invoke() throws "No handler registered".
import "@oxagen/handlers/register";
import { runInTenantScope } from "@oxagen/tenancy";
import { revalidatePath } from "next/cache";
import type { BillingBudgetSetInput } from "@oxagen/oxagen/contracts/billing.budget.set";
import { getSession } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertBillingManager,
} from "@/lib/resolve-org";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";
import type { SpendBudgetStatus } from "./spend-budget-format";

const NOT_AUTHORIZED =
  "You don't have permission to manage spend budgets for this workspace.";

type Gate =
  | { orgId: string; workspaceId: string; userId: string }
  | { error: string };

/**
 * Billing-manager gate for both spend-budget actions: resolve the org +
 * workspace, require an authenticated principal, and assert an
 * owner/admin/billing role (assertBillingManager calls notFound(), which
 * throws — caught below and converted into a graceful {error}).
 */
async function gate(orgSlug: string, workspaceSlug: string): Promise<Gate> {
  const session = await getSession();
  const userId = session?.user?.id;
  if (!userId) return { error: "Not authenticated." };
  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  try {
    await assertBillingManager(org.id, userId);
  } catch {
    return { error: NOT_AUTHORIZED };
  }
  return { orgId: org.id, workspaceId: ws.id, userId };
}

/** Build the app-surface kernel context. */
function buildCtx(orgId: string, workspaceId: string, userId: string) {
  return {
    orgId,
    workspaceId,
    userId,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };
}

function message(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export type GetSpendBudgetsResult =
  | { ok: true; budgets: SpendBudgetStatus[] }
  | { ok: false; error: string };

export async function getSpendBudgetsAction(
  orgSlug: string,
  workspaceSlug: string,
): Promise<GetSpendBudgetsResult> {
  const g = await gate(orgSlug, workspaceSlug);
  if ("error" in g) return { ok: false, error: g.error };
  try {
    const ctx = buildCtx(g.orgId, g.workspaceId, g.userId);
    // { surface: "agent" } — the contract's `surfaces` is
    // ["api","mcp","agent","cli"] and does not include "app" (mirrors
    // ../agent-defaults/page.tsx's get_budget_policy call).
    const out = (await runInTenantScope(
      { orgId: g.orgId, workspaceId: g.workspaceId },
      () => invoke("get_spend_budget", {}, ctx, { surface: "agent" }),
    )) as { budgets: SpendBudgetStatus[] };
    return { ok: true, budgets: out.budgets };
  } catch (err) {
    return { ok: false, error: message(err, "Failed to load spend budgets.") };
  }
}

export type SetSpendBudgetActionInput = BillingBudgetSetInput;

export type SetSpendBudgetResult =
  | { ok: true; budget: SpendBudgetStatus }
  | { ok: false; error: string };

export async function setSpendBudgetAction(
  orgSlug: string,
  workspaceSlug: string,
  input: SetSpendBudgetActionInput,
): Promise<SetSpendBudgetResult> {
  const g = await gate(orgSlug, workspaceSlug);
  if ("error" in g) return { ok: false, error: g.error };
  try {
    const ctx = buildCtx(g.orgId, g.workspaceId, g.userId);
    const budget = (await runInTenantScope(
      { orgId: g.orgId, workspaceId: g.workspaceId },
      () => invoke("set_spend_budget", input, ctx, { surface: "agent" }),
    )) as SpendBudgetStatus;

    const routeCtx: Required<ScopeContext> = { orgSlug, workspaceSlug };
    revalidatePath(workspace.settings.spendBudgets(routeCtx));

    return { ok: true, budget };
  } catch (err) {
    return { ok: false, error: message(err, "Failed to save spend budget.") };
  }
}
