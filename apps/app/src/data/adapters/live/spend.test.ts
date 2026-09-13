import type { BillingBudgetGetOutput } from "@oxagen/oxagen/contracts/billing.budget.get";
import type { BillingUsageBreakdownOutput } from "@oxagen/oxagen/contracts/billing.usage.breakdown";
import { getScope } from "@oxagen/tenancy";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ORG_ONLY_WORKSPACE_ID } from "@/data/scope";
import { ContractOutputMismatch, ToolNotRegistered } from "@/server/errors";
import type { ToolContract } from "@/server/invoke";

const mocks = vi.hoisted(() => {
  class CapabilityError extends Error {
    constructor(
      readonly capability: string,
      readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = "CapabilityError";
    }
  }
  return {
    CapabilityError,
    registry: { loaded: 0 },
    invoke:
      vi.fn<
        (
          name: string,
          input: unknown,
          ctx: Record<string, unknown>,
        ) => Promise<unknown>
      >(),
    getCapability: vi.fn<(name: string) => unknown>(),
    getSession: vi.fn<() => Promise<{ user: { id: string } } | null>>(),
    withTenantDb: vi.fn<(fn: (tx: unknown) => unknown) => Promise<unknown>>(),
  };
});

vi.mock("@oxagen/handlers/register", () => {
  mocks.registry.loaded += 1;
  return {};
});
vi.mock("@oxagen/oxagen", () => ({
  CapabilityError: mocks.CapabilityError,
  invoke: mocks.invoke,
  getCapability: mocks.getCapability,
}));
vi.mock("@/server/session", () => ({ getSession: mocks.getSession }));
vi.mock("@oxagen/database", () => ({
  schema: {
    organizations: { id: "organizations.id", slug: "organizations.slug" },
    workspaces: {
      id: "workspaces.id",
      orgId: "workspaces.org_id",
      slug: "workspaces.slug",
    },
  },
  withTenantDb: mocks.withTenantDb,
}));
vi.mock("drizzle-orm", () => ({
  and: (...parts: unknown[]) => ({ and: parts }),
  eq: (column: unknown, value: unknown) => ({ eq: [column, value] }),
}));

import {
  createLiveSpend,
  isSpendDenial,
  liveSpend,
  liveSpendDeps,
  type SpendLiveDeps,
} from "./spend";

const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-00000000c0de",
};
const ORG_SCOPE = { orgId: SCOPE.orgId, workspaceId: ORG_ONLY_WORKSPACE_ID };
const USER = "0192d4a8-7c1e-7a00-8000-0000000000ab";
const NOW = new Date("2026-09-12T09:14:02.000Z");

type ModelRow = BillingUsageBreakdownOutput["byModel"][number];
type BudgetStatus = BillingBudgetGetOutput["budgets"][number];

const modelRow = (o: Partial<ModelRow>): ModelRow => ({
  key: "claude-sonnet-4-5",
  provider: "anthropic",
  inputTokens: 1_000,
  outputTokens: 120,
  cachedTokens: 600,
  cacheWriteTokens: 200,
  costMicros: 41_265,
  executions: 3,
  messages: 1,
  ...o,
});

const budgetStatus = (o: Partial<BudgetStatus>): BudgetStatus => ({
  scope: "org",
  publicId: "bdg_01K5RS7Q2W",
  enabled: true,
  period: "monthly",
  windowDays: null,
  limitUsd: 25_000,
  spentUsd: 9_918.402117,
  projectedUsd: 24_000,
  ratio: 0.39,
  state: "ok",
  reachedThreshold: 0,
  windowStart: "2026-09-01T00:00:00.000Z",
  windowEnd: NOW.toISOString(),
  ...o,
});

type Call = { contract: string; input: unknown; userId: string };

/** Fake I/O: records every capability call and answers with the given outputs. */
function fakeDeps(
  outputs: {
    byModel?: ModelRow[];
    budgets?: BudgetStatus[];
    error?: unknown;
  },
  overrides?: Partial<SpendLiveDeps>,
) {
  const calls: Call[] = [];
  const slugCalls: unknown[] = [];
  const deps: SpendLiveDeps = {
    principal: () => Promise.resolve(USER),
    invoke: <I, O>(call: {
      scope: typeof SCOPE;
      userId: string;
      contract: ToolContract<I, O>;
      input: I;
    }) => {
      calls.push({
        contract: call.contract.name,
        input: call.input,
        userId: call.userId,
      });
      if (outputs.error !== undefined) return Promise.reject(outputs.error);
      const output =
        call.contract.name === "get_usage_breakdown"
          ? { byModel: outputs.byModel ?? [] }
          : { budgets: outputs.budgets ?? [] };
      return Promise.resolve(output as O);
    },
    slugs: (scope) => {
      slugCalls.push(scope);
      return Promise.resolve({ org: "acme", workspace: "core-platform" });
    },
    clock: () => NOW,
    ...overrides,
  };
  return { deps, calls, slugCalls };
}

describe("spend methods waiting on a store", () => {
  const port = createLiveSpend(fakeDeps({}).deps);

  it.each(["summary", "byOperator", "byAgent", "byTool"] as const)(
    "%s is not backed until cost rollups land (M2, G3)",
    async (method) => {
      await expect(port[method](SCOPE)).resolves.toEqual({
        ok: false,
        reason: "not_backed",
        milestone: "M2",
        gap: "G3",
      });
    },
  );

  it("drill is not backed until cost rollups land (M2, G3)", async () => {
    await expect(
      port.drill(SCOPE, "agent", "acme.core.release"),
    ).resolves.toEqual({
      ok: false,
      reason: "not_backed",
      milestone: "M2",
      gap: "G3",
    });
  });

  it("waste waits on verdicts (M6, G7)", async () => {
    await expect(port.waste(SCOPE)).resolves.toMatchObject({
      reason: "not_backed",
      milestone: "M6",
      gap: "G7",
    });
  });

  it("findings, evidence and fixes wait on the findings job (M2, G4)", async () => {
    for (const read of [
      port.findings(SCOPE),
      port.findingEvidence(SCOPE, "fnd_01"),
      port.findingFix(SCOPE, "fnd_01"),
    ])
      await expect(read).resolves.toMatchObject({
        reason: "not_backed",
        milestone: "M2",
        gap: "G4",
      });
  });

  it("reconciliation waits on provider usage (M5, G5)", async () => {
    await expect(port.reconciliation(SCOPE)).resolves.toMatchObject({
      reason: "not_backed",
      milestone: "M5",
      gap: "G5",
    });
  });
});

describe("byModel", () => {
  it("reads get_usage_breakdown as the viewer for this workspace's calendar month", async () => {
    const { deps, calls } = fakeDeps({
      byModel: [
        modelRow({}),
        modelRow({
          key: "text-embedding-3-small",
          provider: "openai",
          inputTokens: 5_000,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          costMicros: 100,
          executions: 12,
        }),
      ],
    });
    const result = await createLiveSpend(deps).byModel(SCOPE);
    expect(calls).toEqual([
      {
        contract: "get_usage_breakdown",
        userId: USER,
        input: {
          start: "2026-09-01T00:00:00.000Z",
          end: "2026-10-01T00:00:00.000Z",
          workspaceId: SCOPE.workspaceId,
        },
      },
    ]);
    expect(result).toEqual({
      ok: true,
      value: [
        {
          model: "claude-sonnet-4-5",
          assistant: true,
          calls: 3,
          spend: { micros: "41265", currency: "USD", basis: "estimated" },
          cacheHitRate: 0.75,
        },
        {
          model: "text-embedding-3-small",
          assistant: true,
          calls: 12,
          spend: { micros: "100", currency: "USD", basis: "estimated" },
          cacheHitRate: 0,
        },
      ],
    });
  });

  it("returns an empty table when no model call was recorded", async () => {
    const { deps } = fakeDeps({ byModel: [] });
    await expect(createLiveSpend(deps).byModel(SCOPE)).resolves.toEqual({
      ok: true,
      value: [],
    });
  });

  it("is not backed, never a zero rate or a dropped row, when a model has no prompt tokens", async () => {
    const { deps } = fakeDeps({
      byModel: [
        modelRow({}),
        modelRow({
          key: "gpt-image-1",
          inputTokens: 0,
          cachedTokens: 0,
          cacheWriteTokens: 0,
        }),
      ],
    });
    await expect(createLiveSpend(deps).byModel(SCOPE)).resolves.toEqual({
      ok: false,
      reason: "not_backed",
      milestone: "M0",
      gap: "G0",
    });
  });

  it("refuses an organization-level scope without reading (negative)", async () => {
    const { deps, calls } = fakeDeps({ byModel: [modelRow({})] });
    const principal = vi.fn(deps.principal);
    await expect(
      createLiveSpend({ ...deps, principal }).byModel(ORG_SCOPE),
    ).resolves.toEqual({
      ok: false,
      reason: "error",
      code: "workspace_required",
      status: 400,
    });
    expect(calls).toEqual([]);
    expect(principal).not.toHaveBeenCalled();
  });

  it("is denied without a session, and never invokes (negative)", async () => {
    const { deps, calls } = fakeDeps(
      { byModel: [modelRow({})] },
      { principal: () => Promise.resolve(null) },
    );
    await expect(createLiveSpend(deps).byModel(SCOPE)).resolves.toEqual({
      ok: false,
      reason: "denied",
      permission: "spend.read",
    });
    expect(calls).toEqual([]);
  });

  it.each([
    "authz_denied",
    "pending_approval",
    "surface_denied",
    "capability_not_installed",
  ])("turns a kernel %s into the denied state (negative)", async (code) => {
    const { deps } = fakeDeps({
      error: new mocks.CapabilityError("get_usage_breakdown", code, "no"),
    });
    await expect(createLiveSpend(deps).byModel(SCOPE)).resolves.toEqual({
      ok: false,
      reason: "denied",
      permission: "spend.read",
    });
  });

  it("throws a kernel failure that is not a denial (negative)", async () => {
    const failure = new mocks.CapabilityError(
      "get_usage_breakdown",
      "invalid_input",
      "bad",
    );
    const { deps } = fakeDeps({ error: failure });
    await expect(createLiveSpend(deps).byModel(SCOPE)).rejects.toBe(failure);
  });

  it("throws a store failure instead of reporting no spend (negative)", async () => {
    const failure = new Error("clickhouse down");
    const { deps } = fakeDeps({ error: failure });
    await expect(createLiveSpend(deps).byModel(SCOPE)).rejects.toBe(failure);
  });
});

describe("budgets", () => {
  it("reads get_spend_budget as the viewer and shows each enforced ceiling by its scope's slug", async () => {
    const { deps, calls, slugCalls } = fakeDeps({
      budgets: [
        budgetStatus({}),
        budgetStatus({
          scope: "workspace",
          publicId: "bdg_01K5RS7Q2X",
          period: "rolling",
          windowDays: 7,
          limitUsd: 1_234.567891,
          spentUsd: 0,
        }),
        budgetStatus({ scope: "workspace", enabled: false }),
      ],
    });
    const result = await createLiveSpend(deps).budgets(SCOPE);
    expect(calls).toEqual([
      { contract: "get_spend_budget", userId: USER, input: {} },
    ]);
    expect(slugCalls).toEqual([SCOPE]);
    expect(result).toEqual({
      ok: true,
      value: [
        {
          scopeKind: "org",
          scopeId: "acme",
          period: "monthly",
          limit: { micros: "25000000000", currency: "USD" },
          spent: { micros: "9918402117", currency: "USD", basis: "estimated" },
          mode: "hard",
        },
        {
          scopeKind: "workspace",
          scopeId: "core-platform",
          period: "rolling",
          limit: { micros: "1234567891", currency: "USD" },
          spent: { micros: "0", currency: "USD", basis: "estimated" },
          mode: "hard",
        },
      ],
    });
  });

  it("returns no budgets, without a slug lookup, when no ceiling is configured", async () => {
    const { deps, slugCalls } = fakeDeps({ budgets: [] });
    await expect(createLiveSpend(deps).budgets(SCOPE)).resolves.toEqual({
      ok: true,
      value: [],
    });
    expect(slugCalls).toEqual([]);
  });

  it("answers 404 when the scope cannot see its own workspace (negative)", async () => {
    const { deps } = fakeDeps(
      { budgets: [budgetStatus({})] },
      { slugs: () => Promise.resolve(null) },
    );
    await expect(createLiveSpend(deps).budgets(SCOPE)).resolves.toEqual({
      ok: false,
      reason: "error",
      code: "workspace_not_found",
      status: 404,
    });
  });

  it("refuses an organization-level scope without reading (negative)", async () => {
    const { deps, calls } = fakeDeps({ budgets: [budgetStatus({})] });
    await expect(
      createLiveSpend(deps).budgets(ORG_SCOPE),
    ).resolves.toMatchObject({
      reason: "error",
      code: "workspace_required",
    });
    expect(calls).toEqual([]);
  });

  it("turns a kernel denial into the denied state (negative)", async () => {
    const { deps } = fakeDeps({
      error: new mocks.CapabilityError(
        "get_spend_budget",
        "authz_denied",
        "no",
      ),
    });
    await expect(createLiveSpend(deps).budgets(SCOPE)).resolves.toEqual({
      ok: false,
      reason: "denied",
      permission: "spend.read",
    });
  });
});

describe("isSpendDenial", () => {
  it("is true only for a kernel denial code (negative cases included)", () => {
    expect(
      isSpendDenial(new mocks.CapabilityError("x", "authz_denied", "")),
    ).toBe(true);
    expect(
      isSpendDenial(new mocks.CapabilityError("x", "no_handler", "")),
    ).toBe(false);
    expect(isSpendDenial(new Error("authz_denied"))).toBe(false);
    expect(isSpendDenial({ code: "authz_denied" })).toBe(false);
  });
});

describe("liveSpendDeps (production I/O)", () => {
  const contract = {
    name: "get_spend_budget",
    input: z.object({}),
    output: z.object({ budgets: z.array(z.object({ scope: z.string() })) }),
  };

  it("is the adapter the live source registers", () => {
    expect(Object.keys(liveSpend).sort()).toEqual(
      Object.keys(createLiveSpend(liveSpendDeps)).sort(),
    );
  });

  it("reads the principal from the request session", async () => {
    mocks.getSession.mockResolvedValueOnce({ user: { id: USER } });
    await expect(liveSpendDeps.principal()).resolves.toBe(USER);
    mocks.getSession.mockResolvedValueOnce(null);
    await expect(liveSpendDeps.principal()).resolves.toBeNull();
  });

  it("invokes as the viewer inside the tenant scope, loads handlers once, and parses the output", async () => {
    mocks.getCapability.mockReturnValue({ name: "get_spend_budget" });
    let scopeSeen: unknown = null;
    mocks.invoke.mockImplementation(() => {
      scopeSeen = getScope();
      return Promise.resolve({ budgets: [{ scope: "org" }] });
    });
    const call = { scope: SCOPE, userId: USER, contract, input: {} };
    await expect(liveSpendDeps.invoke(call)).resolves.toEqual({
      budgets: [{ scope: "org" }],
    });
    await liveSpendDeps.invoke(call);
    expect(mocks.registry.loaded).toBe(1);
    expect(scopeSeen).toMatchObject(SCOPE);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "get_spend_budget",
      {},
      expect.objectContaining({
        orgId: SCOPE.orgId,
        workspaceId: SCOPE.workspaceId,
        userId: USER,
        apiKeyId: null,
        surface: "app",
        messageId: null,
      }),
    );
  });

  it("throws ToolNotRegistered for a contract the kernel does not know (negative)", async () => {
    mocks.getCapability.mockReturnValue(undefined);
    await expect(
      liveSpendDeps.invoke({ scope: SCOPE, userId: USER, contract, input: {} }),
    ).rejects.toBeInstanceOf(ToolNotRegistered);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("throws ContractOutputMismatch rather than pass an unparsed result on (negative)", async () => {
    mocks.getCapability.mockReturnValue({ name: "get_spend_budget" });
    mocks.invoke.mockResolvedValue({ budgets: "not a list" });
    await expect(
      liveSpendDeps.invoke({ scope: SCOPE, userId: USER, contract, input: {} }),
    ).rejects.toBeInstanceOf(ContractOutputMismatch);
  });

  /** A fake transaction answering the organization read, then the workspace read. */
  function fakeTx(answers: unknown[][]) {
    const where: unknown[] = [];
    let scopeSeen: unknown = null;
    const tx = {
      select: () => ({
        from: () => ({
          where: (clause: unknown) => {
            where.push(clause);
            return {
              limit: () => Promise.resolve(answers.shift() ?? []),
            };
          },
        }),
      }),
    };
    mocks.withTenantDb.mockImplementation((fn) => {
      scopeSeen = getScope();
      return Promise.resolve(fn(tx));
    });
    return { where, scope: () => scopeSeen };
  }

  it("reads both slugs through withTenantDb in the scope, the workspace filtered by its org", async () => {
    const seen = fakeTx([[{ slug: "acme" }], [{ slug: "core-platform" }]]);
    await expect(liveSpendDeps.slugs(SCOPE)).resolves.toEqual({
      org: "acme",
      workspace: "core-platform",
    });
    expect(seen.scope()).toMatchObject(SCOPE);
    expect(seen.where).toEqual([
      { eq: ["organizations.id", SCOPE.orgId] },
      {
        and: [
          { eq: ["workspaces.id", SCOPE.workspaceId] },
          { eq: ["workspaces.org_id", SCOPE.orgId] },
        ],
      },
    ]);
  });

  it("answers null when the scope cannot see the workspace (negative)", async () => {
    fakeTx([[{ slug: "acme" }], []]);
    await expect(liveSpendDeps.slugs(SCOPE)).resolves.toBeNull();
    fakeTx([[], [{ slug: "core-platform" }]]);
    await expect(liveSpendDeps.slugs(SCOPE)).resolves.toBeNull();
  });

  it("tells the time", () => {
    expect(liveSpendDeps.clock()).toBeInstanceOf(Date);
  });
});
