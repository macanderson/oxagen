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
  resolveActingUserId: vi.fn(async () => "u-1" as string | null),
  resolveActorOrgRoles: vi.fn(async () => ["Owner"] as string[]),
  resolveActorWorkspaceRoles: vi.fn(async () => ["Owner"] as string[]),
}));

vi.mock("@oxagen/iam/org-role", () => ({
  resolveActingUserId: mocks.resolveActingUserId,
  resolveActorOrgRoles: mocks.resolveActorOrgRoles,
  resolveActorWorkspaceRoles: mocks.resolveActorWorkspaceRoles,
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
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import { toolsSearchHandler } from "./tools.search";
import { SEARCH_KIND_ROLES } from "./search-kind-roles";
import { runList } from "@oxagen/oxagen/contracts/run.list";
import { agentDefinitionList } from "@oxagen/oxagen/contracts/agent.definition.list";

/** The `allow` roles of a contract's grant map, as search-kind-roles reads them. */
function allowed(
  grants: Readonly<Record<string, string | undefined>> | undefined,
): string[] {
  return Object.entries(grants ?? {})
    .filter(([, effect]) => effect === "allow")
    .map(([role]) => role);
}

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

/** What the two run stores answer; a test overrides either before it calls. */
const DEFAULT_LEDGER_ROWS = [
  {
    publicId: "arun_a",
    status: "completed",
    goal: "review PR 12",
    at: new Date("2026-09-14T10:00:00.000Z"),
  },
];
const DEFAULT_TACHO_ROWS = [
  {
    publicId: "tse_b",
    outcome: "sealed",
    startedAt: new Date("2026-09-14T09:00:00.000Z"),
  },
];
let ledgerRows: unknown[] = DEFAULT_LEDGER_ROWS;
let tachoRows: unknown[] = DEFAULT_TACHO_ROWS;

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
            if (table === schema.agentRuns) return Promise.resolve(ledgerRows);
            if (table === schema.tachoSessions)
              return Promise.resolve(tachoRows);
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
  ledgerRows = DEFAULT_LEDGER_ROWS;
  tachoRows = DEFAULT_TACHO_ROWS;
  mocks.pluginForContract.mockReset().mockReturnValue(undefined);
  mocks.listEntitled.mockReset().mockResolvedValue(new Set<string>());
  mocks.resolveActingUserId.mockReset().mockResolvedValue("u-1");
  mocks.resolveActorOrgRoles.mockReset().mockResolvedValue(["Owner"]);
  mocks.resolveActorWorkspaceRoles.mockReset().mockResolvedValue(["Owner"]);
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

  it("leaves retired (archived) agents out of the agent rows, on a query and on the empty query", async () => {
    for (const query of ["rev", ""]) {
      captured = [];
      await toolsSearchHandler({ query, kinds: ["agent"] }, CTX);
      const read = captured.find((c) => c.table === schema.agents)!;
      expect(read.where).toMatch(/"deleted_at" is null/);
      expect(read.where).toMatch(/"status" <> \$\d+/);
      expect(read.params).toContain("archived");
    }
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
  it("keeps a Tacho session newer than a full page of ledger runs", async () => {
    // Both stores answer their own newest rows. Taking the ledger's first and
    // slicing dropped every Tacho session whenever a full page of ledger runs
    // matched, however much newer the session was.
    ledgerRows = Array.from({ length: 8 }, (_, i) => ({
      publicId: `arun_${i}`,
      status: "completed",
      goal: `old run ${i}`,
      at: new Date("2026-09-14T08:00:00.000Z"),
    }));
    tachoRows = [
      {
        publicId: "tse_new",
        outcome: "sealed",
        startedAt: new Date("2026-09-14T12:00:00.000Z"),
      },
    ];
    const out = await toolsSearchHandler({ query: "", kinds: ["run"] }, CTX);
    expect(out.rows[0]).toEqual({
      kind: "run",
      id: "tse_new",
      label: "tse_new",
      contextLine: "sealed",
    });
  });

  it("hides every witness run from an API-key caller, in both run stores", async () => {
    // ADR-064: a worker holds the API key, and a run a verdict names as its
    // witness run is what checked that worker's own work. list_runs excludes
    // it; search_tools must exclude it by the same predicate, or it is a
    // second way in to the same rows.
    await toolsSearchHandler(
      { query: "", kinds: ["run"] },
      { ...CTX, apiKeyId: "key-1" },
    );
    const reads = captured.filter(
      (c) => c.table === schema.agentRuns || c.table === schema.tachoSessions,
    );
    expect(reads).toHaveLength(2);
    for (const read of reads) {
      expect(read.where).toMatch(/not exists \(select 1 from/);
      expect(read.where).toMatch(/"witness_run_id"/);
    }
  });

  it("hides no witness run from a session caller (negative)", async () => {
    await toolsSearchHandler({ query: "", kinds: ["run"] }, CTX);
    const reads = captured.filter(
      (c) => c.table === schema.agentRuns || c.table === schema.tachoSessions,
    );
    expect(reads).toHaveLength(2);
    for (const read of reads) expect(read.where).not.toMatch(/witness_run_id/);
  });

  it("answers a workspace Viewer no runs and no agents, and reads neither table", async () => {
    // `list_runs` does not grant workspace Viewer and `list_agent_defs` does
    // not grant it either, but `search_tools` does — so before the per-kind
    // gate a Viewer could read run ids and goals, and agent names and slugs,
    // straight out of the tables the authoritative capabilities refuse them.
    mocks.resolveActorOrgRoles.mockResolvedValue([]);
    mocks.resolveActorWorkspaceRoles.mockResolvedValue(["Viewer"]);
    const out = await toolsSearchHandler({ query: "" }, CTX);
    expect(out.rows.map((r) => r.kind)).not.toContain("run");
    expect(out.rows.map((r) => r.kind)).not.toContain("agent");
    // Not filtered after the fact — the tables are never read at all.
    expect(captured.find((c) => c.table === schema.agentRuns)).toBeUndefined();
    expect(captured.find((c) => c.table === schema.agents)).toBeUndefined();
    // The kind a Viewer legitimately has is still answered.
    expect(out.rows.map((r) => r.kind)).toContain("tool");
  });

  it("answers an org Member no agents, because list_agent_defs is Owner/Admin only", async () => {
    // A second bypass on the same route: `list_agent_defs` grants org Owner
    // and Admin only, while `search_tools` grants org Member.
    mocks.resolveActorOrgRoles.mockResolvedValue(["Member"]);
    mocks.resolveActorWorkspaceRoles.mockResolvedValue([]);
    const out = await toolsSearchHandler({ query: "" }, CTX);
    expect(out.rows.map((r) => r.kind)).not.toContain("agent");
    expect(captured.find((c) => c.table === schema.agents)).toBeUndefined();
    // `list_runs` grants org Member, so runs stay.
    expect(captured.find((c) => c.table === schema.agentRuns)).toBeDefined();
  });

  it("refuses when the caller named only kinds it may not see", async () => {
    // Narrowing to nothing would answer `rows: []`, which means "forbidden"
    // dressed as "no matches" — the fabricated-empty this repo bans.
    mocks.resolveActorOrgRoles.mockResolvedValue([]);
    mocks.resolveActorWorkspaceRoles.mockResolvedValue(["Viewer"]);
    await expect(
      toolsSearchHandler({ query: "", kinds: ["run"] }, CTX),
    ).rejects.toSatisfy(
      (e: unknown) => (e as { code?: string }).code === "forbidden",
    );
  });

  it("fails closed when no acting user resolves", async () => {
    // A deleted API key, or a key with no recorded creator.
    mocks.resolveActingUserId.mockResolvedValue(null);
    const out = await toolsSearchHandler({ query: "" }, CTX);
    expect(out.rows.map((r) => r.kind)).toEqual(["tool", "tool"]);
    expect(captured).toHaveLength(0);
  });

  it("derives each kind's roles from the source contract, not a local copy", async () => {
    // The lists must stay tied to the capabilities that own the tables, so
    // tightening `list_runs` tightens search in the same commit.
    expect(SEARCH_KIND_ROLES.run).toEqual({
      org: allowed(runList.defaultRoles.org),
      workspace: allowed(runList.defaultRoles.workspace),
    });
    expect(SEARCH_KIND_ROLES.agent).toEqual({
      org: allowed(agentDefinitionList.defaultRoles.org),
      workspace: allowed(agentDefinitionList.defaultRoles.workspace),
    });
    // `tool` has no source capability: the belt is the registry filtered by
    // entitlement, gated by search_tools' own roles.
    expect(SEARCH_KIND_ROLES.tool).toBeUndefined();
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
