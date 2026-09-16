import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { schema } from "@oxagen/database";
import { z } from "zod";

const REGISTRY = [
  {
    name: "set_budget",
    description: "Set a spend budget",
    surfaces: ["api", "agent"],
    input: z.object({}),
  },
  {
    name: "list_runs",
    description: "List the runs",
    surfaces: ["api", "mcp", "agent"],
    input: z.object({}),
  },
  {
    name: "set_org_billing_terms",
    description: "budget terms, operator only",
    surfaces: ["api"],
    input: z.object({}),
  },
];

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  pluginForContract: vi.fn(
    (_name: string): { id: string } | undefined => undefined,
  ),
  listEntitled: vi.fn(async () => new Set<string>()),
}));

vi.mock("@oxagen/oxagen/plugins", () => ({
  pluginForContract: mocks.pluginForContract,
}));
vi.mock("@oxagen/plugins", () => ({
  listEntitledCapabilityPluginIds: mocks.listEntitled,
}));

vi.mock("../registry-loader", () => ({
  getOxagenRegistry: async () => ({
    listCapabilities: () => REGISTRY,
    getSurfaces: (c: { surfaces: string[] }) => c.surfaces,
    getCapability: (name: string) => REGISTRY.find((c) => c.name === name),
  }),
}));
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

import { toolsSearchHandler } from "./tools.search";

const dialect = new PgDialect();
const CTX = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "u-1",
  apiKeyId: null,
  requestId: "r-1",
  surface: "api" as const,
  messageId: null,
};

type Captured = Array<{ table: unknown; where: string; params: unknown[] }>;

function tx(captured: Captured) {
  return {
    select: () => ({
      from: (table: unknown) => {
        const chain = {
          where: (cond: SQL) => {
            const q = dialect.sqlToQuery(cond);
            captured.push({ table, where: q.sql, params: q.params });
            return chain;
          },
          orderBy: () => chain,
          limit: () => {
            if (table === schema.agentRuns)
              return Promise.resolve([
                {
                  publicId: "arun_a",
                  status: "completed",
                  goal: "review PR 12",
                  at: new Date(),
                },
              ]);
            if (table === schema.tachoSessions)
              return Promise.resolve([
                { publicId: "tse_b", outcome: "sealed", startedAt: new Date() },
              ]);
            if (table === schema.agents)
              return Promise.resolve([
                {
                  publicId: "agt_c",
                  slug: "reviewer",
                  name: "Reviewer",
                  status: "active",
                },
              ]);
            if (table === schema.approvalRequests)
              return Promise.resolve([
                {
                  publicId: "apr_d",
                  capabilityName: "set_budget",
                  expiresAt: new Date("2026-09-14T10:05:00.000Z"),
                },
              ]);
            throw new Error("unexpected table");
          },
        };
        return chain;
      },
    }),
  };
}

let captured: Captured;
beforeEach(() => {
  captured = [];
  mocks.pluginForContract.mockReset().mockReturnValue(undefined);
  mocks.listEntitled.mockReset().mockResolvedValue(new Set<string>());
  mocks.withTenantDb.mockImplementation((fn: (t: unknown) => unknown) =>
    Promise.resolve(fn(tx(captured))),
  );
});

describe("search_tools", () => {
  it("ranks the agent-surface belt first, then the workspace's records, with ids and no hrefs", async () => {
    const out = await toolsSearchHandler({ query: "budget" }, CTX);
    expect(out.rows).toEqual([
      {
        kind: "tool",
        id: "set_budget",
        label: "set_budget",
        contextLine: "Set a spend budget",
      },
      {
        kind: "run",
        id: "arun_a",
        label: "review PR 12",
        contextLine: "completed",
      },
      { kind: "run", id: "tse_b", label: "tse_b", contextLine: "sealed" },
      {
        kind: "agent",
        id: "agt_c",
        label: "Reviewer",
        contextLine: "reviewer · active",
      },
      {
        kind: "approval",
        id: "apr_d",
        label: "set_budget",
        contextLine: "expires 2026-09-14T10:05:00.000Z",
      },
    ]);
    // A capability outside the agent surface is not in the belt.
    expect(
      out.rows.find((r) => r.id === "set_org_billing_terms"),
    ).toBeUndefined();
  });

  it("pins every record read to the workspace and keeps the in-app agent's runs out", async () => {
    await toolsSearchHandler({ query: "x" }, CTX);
    for (const read of captured) {
      expect(read.where).toMatch(/"org_id" = \$/);
      expect(read.where).toMatch(/"workspace_id" = \$/);
    }
    const ledger = captured.find((c) => c.table === schema.agentRuns)!;
    expect(ledger.where).toMatch(/"surface" not in \(\$\d+, \$\d+\)/);
    expect(ledger.params).toEqual(expect.arrayContaining(["chat", "api-chat"]));
    // `%` and `_` in the query are characters, never wildcards.
    await toolsSearchHandler({ query: "100%_done" }, CTX);
    const last = captured.at(-1)!;
    expect(last.params).toEqual(expect.arrayContaining(["%100\\%\\_done%"]));
    const approvals = captured.find(
      (c) => c.table === schema.approvalRequests,
    )!;
    expect(approvals.where).toMatch(/"resolution" is null/);
    expect(approvals.where).toMatch(/"expires_at" > now\(\)/);
  });

  it("deals the eight slots across the kinds on the menu's empty query, so a large belt leaves room for records", async () => {
    const extra = Array.from({ length: 10 }, (_, i) => ({
      name: `tool_${i}`,
      description: "d",
      surfaces: ["agent"],
      input: z.object({}),
    }));
    REGISTRY.push(...extra);
    try {
      const out = await toolsSearchHandler({ query: "" }, CTX);
      expect(out.rows).toHaveLength(8);
      expect(out.rows.map((r) => r.kind)).toEqual([
        "tool",
        "tool",
        "tool",
        "tool",
        "run",
        "run",
        "agent",
        "approval",
      ]);
    } finally {
      REGISTRY.splice(REGISTRY.length - extra.length, extra.length);
    }
  });

  it("searches only the kinds asked for and reads nothing for the rest (negative)", async () => {
    const out = await toolsSearchHandler({ query: "", kinds: ["tool"] }, CTX);
    expect(out.rows.map((r) => r.kind)).toEqual(["tool", "tool"]);
    expect(mocks.withTenantDb).toHaveBeenCalledTimes(1);
    expect(captured).toHaveLength(0);
  });
  it("lists no tool claimed by a plugin the org has not installed (negative)", async () => {
    mocks.pluginForContract.mockImplementation((name: string) =>
      name === "set_budget" ? { id: "oxagen/budgets" } : undefined,
    );
    mocks.listEntitled.mockResolvedValue(new Set(["oxagen/other"]));
    const out = await toolsSearchHandler({ query: "", kinds: ["tool"] }, CTX);
    expect(out.rows.map((r) => r.id)).toEqual(["list_runs"]);
    expect(mocks.listEntitled).toHaveBeenCalledWith("org-1", "ws-1");
  });
});
