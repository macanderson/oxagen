// The live spend adapter (plan §5 Batch 3, lane A7: spend + budgets).
//
// What is wired, and what is not, after checking plan §3.1 at column level
// (./mappers/spend.ts carries the mapping; the PR body carries the table):
//
//   byModel         wired. `get_usage_breakdown` through the kernel, for the
//                   workspace and the current calendar month (UTC).
//   budgets         wired. `get_spend_budget` through the kernel: the org
//                   ceiling and the workspace ceiling with their live burn.
//   summary         not backed (M2, G3): runs per period and proven spend are
//                   not recorded.
//   byOperator      not backed (M2, G3): agents, runs and a budget per person
//   byAgent         are not recorded; token_usage has no run and no operator
//   byTool          rollup, and tool_invocations has no cost column.
//   drill
//   waste           not backed (M6, G7): needs verdicts.
//   findings, findingEvidence, findingFix   not backed (M2, G4).
//   reconciliation  not backed (M5, G5).
//
// Both wired reads exist as capabilities, so they go through the kernel as the
// signed-in person (contract-wiring order): IAM decides, a denial is a `denied`
// value, and the result is parsed by the contract's own output schema and then
// by the view model. invoke() runs inside runInTenantScope; the one direct
// Postgres read (the scope's slugs) runs in withTenantDb under the same scope.
// A store failure is thrown, never turned into an empty list or a zero.
import "server-only";
import { schema, withTenantDb } from "@oxagen/database";
import {
  type CapabilityContext,
  CapabilityError,
  getCapability,
  invoke,
} from "@oxagen/oxagen";
import { billingBudgetGet } from "@oxagen/oxagen/contracts/billing.budget.get";
import { billingUsageBreakdown } from "@oxagen/oxagen/contracts/billing.usage.breakdown";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { notBackedFor } from "@/data/backing";
import { Budget, SpendByModel } from "@/data/contracts";
import {
  denied,
  notBacked,
  type Read,
  readError,
  readOk,
} from "@/data/not-backed";
import { PAGE_FAILURES } from "@/data/page-states";
import type { SpendReadPort } from "@/data/ports";
import type { Scope } from "@/data/scope";
import { ContractOutputMismatch, ToolNotRegistered } from "@/server/errors";
import type { ToolContract } from "@/server/invoke";
import { getSession } from "@/server/session";
import { isOrgOnlyScope } from "@/server/tenant-scope";
import {
  monthWindow,
  type ScopeSlugs,
  toBudget,
  toSpendByModel,
} from "./mappers/spend";

const SPEND = PAGE_FAILURES.spend;

/** Kernel codes that mean "this person may not read this", not "the store failed". */
const DENIAL_CODES: ReadonlySet<string> = new Set([
  "authz_denied",
  "pending_approval",
  "surface_denied",
  "capability_not_installed",
]);

export function isSpendDenial(error: unknown): boolean {
  return error instanceof CapabilityError && DENIAL_CODES.has(error.code);
}

/** The I/O the adapter needs, injected so every branch is unit-tested without stores. */
export type SpendLiveDeps = {
  /** The signed-in person's user id; null without a session. */
  principal: () => Promise<string | null>;
  /** Invoke a read capability as `userId` in `scope`; the result is parsed by the contract's output schema. */
  invoke: <I, O>(call: {
    scope: Scope;
    userId: string;
    contract: ToolContract<I, O>;
    input: NoInfer<I>;
  }) => Promise<O>;
  /** The organization's and the workspace's current slugs; null when the scope cannot see them. */
  slugs: (scope: Scope) => Promise<ScopeSlugs | null>;
  clock: () => Date;
};

const ModelList = z.array(SpendByModel);
const BudgetList = z.array(Budget);

// Spend is read per workspace (the Spend page is /{org}/{ws}/spend); an
// organization-level scope has no workspace to narrow to.
const workspaceRequired = () => readError("workspace_required", 400);

/**
 * Run one capability read as the signed-in person. A missing session and a
 * kernel denial are the page's `denied` state; anything else is thrown.
 */
async function asViewer<T>(
  deps: SpendLiveDeps,
  scope: Scope,
  read: (userId: string) => Promise<Read<T>>,
): Promise<Read<T>> {
  const userId = await deps.principal();
  if (userId === null) return denied(SPEND.permission);
  try {
    return await read(userId);
  } catch (error) {
    if (isSpendDenial(error)) return denied(SPEND.permission);
    throw error;
  }
}

export function createLiveSpend(deps: SpendLiveDeps): SpendReadPort {
  return {
    summary: () => Promise.resolve(notBacked("M2", "G3")),
    byOperator: () => Promise.resolve(notBacked("M2", "G3")),
    byAgent: () => Promise.resolve(notBacked("M2", "G3")),

    byModel(scope) {
      if (isOrgOnlyScope(scope)) return Promise.resolve(workspaceRequired());
      return asViewer(deps, scope, async (userId) => {
        const { start, end } = monthWindow(deps.clock());
        const breakdown = await deps.invoke({
          scope,
          userId,
          contract: billingUsageBreakdown,
          input: { start, end, workspaceId: scope.workspaceId },
        });
        const rows: SpendByModel[] = [];
        for (const row of breakdown.byModel) {
          const candidate = toSpendByModel(row);
          // A model with no prompt tokens has no cache hit rate, and the view
          // model has no null for it: say the table is not recorded rather
          // than drop the row (and its spend) or print a zero rate.
          if (!candidate.ok) return notBackedFor("spend", "byModel");
          rows.push(candidate.value);
        }
        return readOk(ModelList.parse(rows));
      });
    },

    byTool: () => Promise.resolve(notBacked("M2", "G3")),
    waste: () => Promise.resolve(notBackedFor("spend", "waste")),
    drill: () => Promise.resolve(notBacked("M2", "G3")),
    findings: () => Promise.resolve(notBackedFor("spend", "findings")),
    findingEvidence: () =>
      Promise.resolve(notBackedFor("spend", "findingEvidence")),
    findingFix: () => Promise.resolve(notBackedFor("spend", "findingFix")),
    reconciliation: () =>
      Promise.resolve(notBackedFor("spend", "reconciliation")),

    budgets(scope) {
      if (isOrgOnlyScope(scope)) return Promise.resolve(workspaceRequired());
      return asViewer(deps, scope, async (userId) => {
        const { budgets } = await deps.invoke({
          scope,
          userId,
          contract: billingBudgetGet,
          input: {},
        });
        // No ceiling configured is a recorded fact: nothing caps this spend.
        if (budgets.length === 0) return readOk(BudgetList.parse([]));
        const slugs = await deps.slugs(scope);
        if (slugs === null) return readError("workspace_not_found", 404);
        const rows = budgets
          .map((status) => toBudget(status, slugs))
          .filter((budget): budget is Budget => budget !== null);
        return readOk(BudgetList.parse(rows));
      });
    },
  };
}

let handlersRegistered: Promise<unknown> | null = null;

/** The production I/O: the request's session, the kernel, and tenant-scoped Postgres. */
export const liveSpendDeps: SpendLiveDeps = {
  async principal() {
    return (await getSession())?.user.id ?? null;
  },

  async invoke({ scope, userId, contract, input }) {
    // The handler registry must be loaded before the first invoke(), or the
    // kernel finds no handler (the same rule src/server/invoke.ts follows).
    handlersRegistered ??= import("@oxagen/handlers/register");
    await handlersRegistered;
    if (!getCapability(contract.name))
      throw new ToolNotRegistered(contract.name);
    const ctx: CapabilityContext = {
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      userId,
      apiKeyId: null,
      requestId: crypto.randomUUID(),
      surface: "app",
      messageId: null,
    };
    const raw = await runInTenantScope(scope, () =>
      invoke(contract.name, input, ctx),
    );
    const parsed = contract.output.safeParse(raw);
    if (!parsed.success)
      throw new ContractOutputMismatch(contract.name, parsed.error.issues);
    return parsed.data;
  },

  slugs(scope) {
    return runInTenantScope(scope, () =>
      withTenantDb(async (tx) => {
        const [org] = await tx
          .select({ slug: schema.organizations.slug })
          .from(schema.organizations)
          .where(eq(schema.organizations.id, scope.orgId))
          .limit(1);
        const [ws] = await tx
          .select({ slug: schema.workspaces.slug })
          .from(schema.workspaces)
          .where(
            and(
              eq(schema.workspaces.id, scope.workspaceId),
              eq(schema.workspaces.orgId, scope.orgId),
            ),
          )
          .limit(1);
        if (!org || !ws) return null;
        return { org: org.slug, workspace: ws.slug };
      }),
    );
  },

  clock: () => new Date(),
};

export const liveSpend: SpendReadPort = createLiveSpend(liveSpendDeps);
