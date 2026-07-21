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
 * so the gates here ARE the authorization boundary. They mirror each
 * contract's own `defaultRoles` so the app agrees with the api/mcp/cli
 * surfaces rather than inventing a stricter rule: reading is Member-level
 * (assertOrgMember), writing is billing-manager only (assertBillingManager).
 * A Member who can see the burn cannot raise the ceiling.
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
  assertOrgMember,
  assertBillingManager,
} from "@/lib/resolve-org";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";
import type { SpendBudgetStatus } from "./spend-budget-format";

const NOT_A_MEMBER = "You don't have access to this workspace.";
const NOT_AUTHORIZED =
  "You don't have permission to manage spend budgets for this workspace.";

type Gate =
  | { orgId: string; workspaceId: string; userId: string }
  | { error: string };

/**
 * Resolve the org + workspace and require an authenticated principal holding
 * `role`. Both assert helpers call notFound(), which throws — caught here and
 * converted into a graceful {error} the panel can render.
 */
async function gate(
  orgSlug: string,
  workspaceSlug: string,
  role: "member" | "billingManager",
): Promise<Gate> {
  const session = await getSession();
  const userId = session?.user?.id;
  if (!userId) return { error: "Not authenticated." };
  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  try {
    if (role === "billingManager") {
      await assertBillingManager(org.id, userId);
    } else {
      await assertOrgMember(org.id, userId);
    }
  } catch {
    return { error: role === "billingManager" ? NOT_AUTHORIZED : NOT_A_MEMBER };
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
  const g = await gate(orgSlug, workspaceSlug, "member");
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
  const g = await gate(orgSlug, workspaceSlug, "billingManager");
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
