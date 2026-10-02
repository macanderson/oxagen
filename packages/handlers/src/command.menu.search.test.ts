import { describe, it, expect, vi, afterEach } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";

// ── Mock all I/O ──────────────────────────────────────────────────────────────

// graph.node.search via invoke()
const mockInvoke = vi.fn().mockResolvedValue({ nodes: [] });
vi.mock("@oxagen/oxagen/kernel", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

// withTenantDb — returns an empty list by default; override per test.
const mockWithTenantDb = vi.fn().mockResolvedValue([]);
vi.mock("@oxagen/database", () => {
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    schema: {
      agentExecutions: {
        orgId: "orgId",
        workspaceId: "workspaceId",
        publicId: "publicId",
        agentId: "agentId",
        originId: "originId",
        status: "status",
        createdAt: "createdAt",
        deletedAt: "deletedAt",
      },
      // The assistant's own call reads these as identifiers, by column name.
      messages: {
        id: { name: "id" },
        conversationId: { name: "conversation_id" },
        orgId: { name: "org_id" },
        workspaceId: { name: "workspace_id" },
      },
      conversations: {
        id: { name: "id" },
        orgId: { name: "org_id" },
        workspaceId: { name: "workspace_id" },
        userId: { name: "user_id" },
      },
      agents: {
        id: "id",
        agentType: "agentType",
        principalId: "principalId",
        orgId: "orgId",
        workspaceId: "workspaceId",
        publicId: "publicId",
        name: "name",
        slug: "slug",
        status: "status",
        deletedAt: "deletedAt",
      },
      principals: {
        id: "principalRowId",
        orgId: "orgId",
        publicId: "publicId",
        displayName: "displayName",
        kind: "kind",
        status: "status",
        idpSubject: "idpSubject",
      },
    },
    withTenantDb: (fn: (tx: unknown) => Promise<unknown>) =>
      mockWithTenantDb(fn),
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

// drizzle functions — just return their args so we can verify they don't throw
vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  ilike: (a: unknown, b: unknown) => ({ ilike: [a, b] }),
  isNull: (a: unknown) => ({ isNull: a }),
  ne: (a: unknown, b: unknown) => ({ ne: [a, b] }),
  or: (...args: unknown[]) => ({ or: args }),
  // The run arm's assistant exclusion is a raw fragment (ADR-235).
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({
      sql: strings.join("?"),
      values,
    }),
    { identifier: (name: string) => ({ identifier: name }) },
  ),
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createOxagenAssistantBinding } from "@oxagen/oxagen/oxagen-assistant";
import { commandMenuSearchHandler } from "./command.menu.search";

const ctx: CapabilityContext = {
  orgId: "00000000-0000-0000-0000-000000000001",
  workspaceId: "00000000-0000-0000-0000-000000000002",
  userId: "u1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "app",
  messageId: null,
};

afterEach(() => {
  vi.clearAllMocks();
  mockInvoke.mockResolvedValue({ nodes: [] });
  mockWithTenantDb.mockResolvedValue([]);
});

describe("commandMenuSearchHandler", () => {
  it("returns empty rows when all sources return nothing", async () => {
    const result = await commandMenuSearchHandler(
      {
        kind: "run",
        query: "aex_nothing",
        orgSlug: "acme",
        workspaceSlug: "prod",
      },
      ctx,
    );
    expect(result.rows).toHaveLength(0);
  });

  it("maps agent Postgres rows into SearchResultRow with correct href", async () => {
    mockWithTenantDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        // Simulate tx chain: .select().from().where().limit() → rows
        const tx = {
          select: () => tx,
          from: () => tx,
          where: () => tx,
          orderBy: () => tx,
          limit: () =>
            Promise.resolve([
              {
                publicId: "agt_abc",
                name: "Churn Investigator",
                status: "active",
              },
            ]),
        };
        return fn(tx);
      },
    );

    const result = await commandMenuSearchHandler(
      {
        kind: "agent",
        query: "churn",
        orgSlug: "acme",
        workspaceSlug: "prod",
      },
      ctx,
    );
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row?.kind).toBe("agent");
    expect(row?.label).toBe("Churn Investigator");
    expect(row?.href).toBe("/acme/prod/agents/agt_abc");
    expect(row?.contextLine).toBe("Status: active");
    expect(row?.scope).toBe("Workspace: prod");
  });

  it.each(["churn", ""])(
    "leaves retired (archived) agents out of the agent query (query %j)",
    async (query) => {
      const wheres: unknown[] = [];
      mockWithTenantDb.mockImplementation(
        async (fn: (tx: unknown) => Promise<unknown>) => {
          const tx = {
            select: () => tx,
            from: () => tx,
            where: (cond: unknown) => {
              wheres.push(cond);
              return tx;
            },
            orderBy: () => tx,
            limit: () => Promise.resolve([]),
          };
          return fn(tx);
        },
      );

      await commandMenuSearchHandler(
        { kind: "agent", query, orgSlug: "acme", workspaceSlug: "prod" },
        ctx,
      );

      expect(wheres).toHaveLength(1);
      const where = wheres[0] as { and: unknown[] };
      expect(where.and).toContainEqual({ isNull: "deletedAt" });
      expect(where.and).toContainEqual({ ne: ["status", "archived"] });
    },
  );

  it("merges graph + Postgres results, deduplicates by href", async () => {
    // Graph returns a node for the same entity, under a different route.
    mockInvoke.mockResolvedValue({
      nodes: [
        {
          nodeId: "agt_abc",
          label: "Agent",
          displayName: "Churn Investigator",
          description: "Graph node",
        },
      ],
    });
    // Postgres also returns the same record
    mockWithTenantDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          select: () => tx,
          from: () => tx,
          where: () => tx,
          orderBy: () => tx,
          limit: () =>
            Promise.resolve([
              {
                publicId: "agt_abc",
                name: "Churn Investigator",
                status: "active",
              },
            ]),
        };
        return fn(tx);
      },
    );

    const result = await commandMenuSearchHandler(
      {
        kind: "agent",
        query: "churn",
        orgSlug: "acme",
        workspaceSlug: "prod",
      },
      ctx,
    );

    // Postgres href: /acme/prod/agents/agt_abc
    // Graph href:    /acme/prod/knowledge/graph/agt_abc
    // Different hrefs → no dedup; both appear, Postgres first.
    expect(result.rows.length).toBeLessThanOrEqual(8);
    expect(result.rows[0]?.href).toBe("/acme/prod/agents/agt_abc");
  });

  it("slices merged results to max 8 rows", async () => {
    // Return 6 Postgres rows + 5 graph nodes → 11 total, should be sliced to 8
    mockWithTenantDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          select: () => tx,
          from: () => tx,
          where: () => tx,
          orderBy: () => tx,
          limit: () =>
            Promise.resolve(
              Array.from({ length: 6 }, (_, i) => ({
                publicId: `aex_${i}`,
                status: "completed",
                createdAt: new Date(),
              })),
            ),
        };
        return fn(tx);
      },
    );
    mockInvoke.mockResolvedValue({
      nodes: Array.from({ length: 5 }, (_, i) => ({
        nodeId: `node_${i}`,
        label: "Run",
        displayName: `Run ${i}`,
        description: null,
      })),
    });

    const result = await commandMenuSearchHandler(
      { kind: "run", query: "aex", orgSlug: "acme", workspaceSlug: "prod" },
      ctx,
    );
    expect(result.rows.length).toBeLessThanOrEqual(8);
  });

  it("gracefully handles graph.node.search failure (ontology best-effort)", async () => {
    mockInvoke.mockRejectedValue(new Error("Neo4j unavailable"));
    mockWithTenantDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          select: () => tx,
          from: () => tx,
          where: () => tx,
          orderBy: () => tx,
          limit: () =>
            Promise.resolve([
              { publicId: "agt_abc", name: "Cleanup Agent", status: "active" },
            ]),
        };
        return fn(tx);
      },
    );

    const result = await commandMenuSearchHandler(
      {
        kind: "agent",
        query: "cleanup",
        orgSlug: "acme",
        workspaceSlug: "prod",
      },
      ctx,
    );
    // Should still return Postgres rows despite graph failure.
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.kind).toBe("agent");
  });

  it("searches across all kinds when no kind filter is provided", async () => {
    // Each withTenantDb call returns 1 row of the appropriate type
    let callCount = 0;
    mockWithTenantDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        callCount++;
        const entityConfigs = [
          [{ publicId: "aex_1", status: "failed", createdAt: new Date() }],
          [{ publicId: "plb_1", name: "Playbook A", status: "active" }],
          [{ publicId: "plt_1", triggerType: "webhook", isEnabled: true }],
          [{ publicId: "agt_1", name: "Agent A", status: "active" }],
          [
            {
              publicId: "prn_1",
              displayName: "Alice",
              kind: "human",
              status: "active",
            },
          ],
        ];
        const data =
          entityConfigs[(callCount - 1) % entityConfigs.length] ?? [];
        const tx = {
          select: () => tx,
          from: () => tx,
          where: () => tx,
          orderBy: () => tx,
          limit: () => Promise.resolve(data),
        };
        return fn(tx);
      },
    );

    const result = await commandMenuSearchHandler(
      { query: "a", orgSlug: "acme", workspaceSlug: "prod" },
      ctx,
    );
    expect(result.rows.length).toBeGreaterThanOrEqual(1);
    expect(result.rows.length).toBeLessThanOrEqual(8);
  });
});

// ADR-235: each turn of the in-app assistant records an execution under the
// workspace's managed `interactive_chat` agent. That record is internal, so
// only the assistant itself finds it.
describe("commandMenuSearchHandler: the in-app assistant's executions", () => {
  /** The NOT EXISTS fragment the run arm adds, as the `sql` mock records it. */
  function isAssistantExclusion(cond: unknown): boolean {
    if (typeof cond !== "object" || cond === null || !("sql" in cond))
      return false;
    const fragment = cond as { sql: string; values: unknown[] };
    return (
      fragment.sql.startsWith("not exists") &&
      fragment.values.includes("interactive_chat")
    );
  }

  /**
   * The person whose own executions the assistant's call keeps: the OR of
   * the exclusion and the asker test, whose last value is the user id.
   */
  function ownAsker(cond: unknown): unknown {
    if (typeof cond !== "object" || cond === null || !("sql" in cond))
      return undefined;
    const fragment = cond as { sql: string; values: unknown[] };
    if (
      !fragment.sql.startsWith("(") ||
      !isAssistantExclusion(fragment.values[0])
    )
      return undefined;
    const own = fragment.values[1] as { values: unknown[] } | undefined;
    return own?.values.at(-1);
  }

  /**
   * A fake tx that records the run query's WHERE and applies the exclusion
   * the way Postgres would: a row whose agent is `interactive_chat` drops out
   * when the WHERE carries the fragment, unless the WHERE keeps the asker's
   * own turns and the row is one.
   */
  function setupRuns(
    rows: Array<{
      publicId: string;
      status: string;
      agentType: string;
      askedBy?: string;
    }>,
  ) {
    const wheres: Array<{ and: unknown[] }> = [];
    mockWithTenantDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        let where: { and: unknown[] } = { and: [] };
        const tx = {
          select: () => tx,
          from: () => tx,
          where: (cond: { and: unknown[] }) => {
            where = cond;
            wheres.push(cond);
            return tx;
          },
          orderBy: () => tx,
          limit: () => {
            const asker = where.and
              .map(ownAsker)
              .find((a) => a !== undefined);
            const hides =
              where.and.some(isAssistantExclusion) || asker !== undefined;
            return Promise.resolve(
              rows
                .filter(
                  (r) =>
                    !(
                      hides &&
                      r.agentType === "interactive_chat" &&
                      (asker === undefined || r.askedBy !== asker)
                    ),
                )
                .map((r) => ({
                  publicId: r.publicId,
                  status: r.status,
                  createdAt: new Date(),
                })),
            );
          },
        };
        return fn(tx);
      },
    );
    return wheres;
  }

  const runs = () => [
    { publicId: "aex_custom", status: "completed", agentType: "custom" },
    {
      publicId: "aex_assistant",
      status: "completed",
      agentType: "interactive_chat",
      askedBy: "u1",
    },
    {
      publicId: "aex_assistant_other",
      status: "completed",
      agentType: "interactive_chat",
      askedBy: "u2",
    },
  ];
  const input = {
    kind: "run" as const,
    query: "aex",
    orgSlug: "acme",
    workspaceSlug: "prod",
  };

  it("leaves the assistant's executions out for a caller without its binding", async () => {
    const wheres = setupRuns(runs());
    const result = await commandMenuSearchHandler(input, ctx);
    expect(result.rows.map((r) => r.id)).toEqual(["aex_custom"]);
    expect(wheres).toHaveLength(1);
    expect(wheres[0]!.and.some(isAssistantExclusion)).toBe(true);
  });

  it("finds the asker's own assistant executions, and not another person's, when the call carries its binding", async () => {
    const wheres = setupRuns(runs());
    const result = await commandMenuSearchHandler(input, {
      ...ctx,
      oxagenAssistant: createOxagenAssistantBinding({
        requestId: ctx.requestId,
      }),
    });
    expect(result.rows.map((r) => r.id)).toEqual([
      "aex_custom",
      "aex_assistant",
    ]);
    expect(wheres[0]!.and.map(ownAsker)).toContain("u1");
  });
});

// ADR-235: the workspace's managed assistant agent and the service principal
// it acts as are Oxagen's, so the menu offers neither.
describe("commandMenuSearchHandler: the assistant agent and its principal", () => {
  /** The WHERE each query built, and a fake that applies it to `rows`. */
  function setupRows<T extends Record<string, unknown>>(
    rows: T[],
    hidden: (where: { and: unknown[] }, row: T) => boolean,
  ) {
    const wheres: Array<{ and: unknown[] }> = [];
    mockWithTenantDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        let where: { and: unknown[] } = { and: [] };
        const tx = {
          select: () => tx,
          from: () => tx,
          where: (cond: { and: unknown[] }) => {
            where = cond;
            wheres.push(cond);
            return tx;
          },
          orderBy: () => tx,
          limit: () =>
            Promise.resolve(rows.filter((row) => !hidden(where, row))),
        };
        return fn(tx);
      },
    );
    return wheres;
  }

  /** The NOT EXISTS fragment that ties a principal to an assistant agent. */
  function isAssistantPrincipalExclusion(cond: unknown): boolean {
    if (typeof cond !== "object" || cond === null || !("sql" in cond))
      return false;
    const fragment = cond as { sql: string; values: unknown[] };
    return (
      fragment.sql.startsWith("not exists") &&
      fragment.values.includes("principalId") &&
      fragment.values.includes("principalRowId") &&
      fragment.values.includes("interactive_chat")
    );
  }

  it("leaves the managed assistant agent out and keeps an ordinary agent", async () => {
    const wheres = setupRows(
      [
        {
          publicId: "agt_ops",
          name: "Ops agent",
          status: "active",
          agentType: "custom",
        },
        {
          publicId: "agt_assistant",
          name: "QA Chat Agent",
          status: "active",
          agentType: "interactive_chat",
        },
      ],
      (where, row) =>
        where.and.some(
          (c) =>
            JSON.stringify(c) ===
            JSON.stringify({ ne: ["agentType", "interactive_chat"] }),
        ) && row.agentType === "interactive_chat",
    );

    const result = await commandMenuSearchHandler(
      { kind: "agent", query: "a", orgSlug: "acme", workspaceSlug: "prod" },
      ctx,
    );

    expect(result.rows.map((r) => r.id)).toEqual(["agt_ops"]);
    expect(wheres).toHaveLength(1);
    expect(wheres[0]!.and).toContainEqual({
      ne: ["agentType", "interactive_chat"],
    });
  });

  it("leaves the assistant's service principal out and keeps an ordinary principal", async () => {
    const wheres = setupRows(
      [
        {
          publicId: "prn_alice",
          displayName: "Alice",
          kind: "human",
          status: "active",
          linkedAgentType: null,
        },
        {
          publicId: "prn_assistant",
          displayName: "oxagen.assistant",
          kind: "service",
          status: "active",
          linkedAgentType: "interactive_chat",
        },
      ],
      (where, row) =>
        where.and.some(isAssistantPrincipalExclusion) &&
        row.linkedAgentType === "interactive_chat",
    );

    const result = await commandMenuSearchHandler(
      {
        kind: "principal",
        query: "a",
        orgSlug: "acme",
        workspaceSlug: "prod",
      },
      ctx,
    );

    expect(result.rows.map((r) => r.id)).toEqual(["prn_alice"]);
    expect(wheres).toHaveLength(1);
    expect(wheres[0]!.and.some(isAssistantPrincipalExclusion)).toBe(true);
  });
});
