import { beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@oxagen/database";
import type { Bundle } from "@oxagen/oxagen/steering-repo/bundle";
import type { SteeringCheckContext } from "@oxagen/oxagen/contracts/context.steering.index.get";

// Each table's rows, keyed by the table the handler selects from.
const rows = vi.hoisted(() => new Map<unknown, unknown[]>());
const whereCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const tx = {
    select: () => ({
      from: (table: unknown) => ({
        where: async () => {
          whereCalls.count += 1;
          return rows.get(table) ?? [];
        },
      }),
    }),
  };
  const withTenantDb = async (fn: (t: unknown) => Promise<unknown>) => fn(tx);
  return { ...real, withTenantDb, withOrgDb: withTenantDb };
});

import {
  createSteeringIndexGetHandler,
  readCheckContext,
} from "./context.steering.index.get";
import type { SteeringScope } from "./steering.search";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

const EMPTY_CONTEXT: SteeringCheckContext = {
  runtimes: [],
  members: [],
  teams: [],
  groups: [],
  credentials: [],
};

/** A published version with only the fields the handler reads, and a few it drops. */
function bundle(records: Array<Record<string, unknown>>): Bundle {
  return { records } as unknown as Bundle;
}

const REFUNDS = {
  lineage: "rec_billing_refunds",
  path: "steering/billing/refunds.md",
  blob: "a".repeat(40),
  id: "rec_billing_refunds_0a1b2c3d4e5f",
  hash: `sha256:${"0".repeat(64)}`,
  label: "Refunds need a ticket",
  kind: "constraint",
  effect: "require",
  tokens: 12,
};

const LEDGER = {
  lineage: "rec_ledger_memory",
  path: "memories/ledger.md",
  blob: "b".repeat(40),
  id: "rec_ledger_memory_1a2b3c4d5e6f",
  hash: `sha256:${"1".repeat(64)}`,
  label: "The ledger closes at midnight UTC",
  kind: "memory",
  tokens: 9,
};

describe("get_steering_index handler", () => {
  it("answers a null index before the first publish", async () => {
    const handler = createSteeringIndexGetHandler({
      published: async () => ({ workspace: null, organization: null }),
      readContext: async () => EMPTY_CONTEXT,
    });
    const out = await handler({}, CTX);
    expect(out).toEqual({ index: null, context: EMPTY_CONTEXT });
  });

  it("reads the version published now for the caller's workspace", async () => {
    const scopes: SteeringScope[] = [];
    const contextScopes: unknown[] = [];
    const handler = createSteeringIndexGetHandler({
      published: async (scope) => {
        scopes.push(scope);
        return { workspace: null, organization: null };
      },
      readContext: async (scope) => {
        contextScopes.push(scope);
        return EMPTY_CONTEXT;
      },
    });
    await handler({}, CTX);
    expect(scopes).toEqual([
      { orgId: CTX.orgId, workspaceId: CTX.workspaceId, runId: null },
    ]);
    expect(contextScopes).toEqual([
      { orgId: CTX.orgId, workspaceId: CTX.workspaceId },
    ]);
  });

  it("maps each published record to the fields the checks read", async () => {
    const handler = createSteeringIndexGetHandler({
      published: async () => ({
        workspace: bundle([REFUNDS, LEDGER]),
        organization: null,
      }),
      readContext: async () => EMPTY_CONTEXT,
    });
    const out = await handler({}, CTX);
    expect(out.index).toEqual({
      records: [
        {
          lineage: REFUNDS.lineage,
          path: REFUNDS.path,
          id: REFUNDS.id,
          hash: REFUNDS.hash,
          kind: "constraint",
          effect: "require",
        },
        {
          lineage: LEDGER.lineage,
          path: LEDGER.path,
          id: LEDGER.id,
          hash: LEDGER.hash,
          kind: "memory",
          effect: null,
        },
      ],
    });
    // bundle/v1 holds no statement, so no record carries one.
    for (const record of out.index?.records ?? []) {
      expect(record).not.toHaveProperty("statement");
      expect(record).not.toHaveProperty("blob");
    }
  });

  it("returns the context the reader built", async () => {
    const context: SteeringCheckContext = {
      ...EMPTY_CONTEXT,
      runtimes: ["ci-linux-01"],
      credentials: ["stripe-live"],
    };
    const handler = createSteeringIndexGetHandler({
      published: async () => ({ workspace: null, organization: null }),
      readContext: async () => context,
    });
    expect((await handler({}, CTX)).context).toEqual(context);
  });
});

describe("readCheckContext", () => {
  beforeEach(() => {
    rows.clear();
    whereCalls.count = 0;
  });

  it("lists runtime slugs and credential names, sorted, each once", async () => {
    rows.set(schema.runtimes, [
      { name: "gpu-west" },
      { name: "ci-linux-01" },
      { name: "gpu-west" },
    ]);
    rows.set(schema.mcpCredentials, [
      { name: "stripe-test" },
      { name: "linear" },
      { name: "stripe-live" },
    ]);
    const context = await readCheckContext({
      orgId: CTX.orgId,
      workspaceId: CTX.workspaceId,
    });
    expect(context.runtimes).toEqual(["ci-linux-01", "gpu-west"]);
    expect(context.credentials).toEqual(["linear", "stripe-live", "stripe-test"]);
    expect(whereCalls.count).toBe(2);
  });

  it("returns members, teams, and groups empty, since no table holds them", async () => {
    rows.set(schema.runtimes, [{ name: "ci-linux-01" }]);
    const context = await readCheckContext({
      orgId: CTX.orgId,
      workspaceId: CTX.workspaceId,
    });
    expect(context.members).toEqual([]);
    expect(context.teams).toEqual([]);
    expect(context.groups).toEqual([]);
    expect(context.credentials).toEqual([]);
  });
});
