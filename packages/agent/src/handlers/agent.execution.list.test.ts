import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = { ...real, withTenantDb: vi.fn() };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import { withTenantDb } from "@oxagen/database";
import { createOxagenAssistantBinding } from "@oxagen/oxagen/oxagen-assistant";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { agentExecutionListHandler } from "./agent.execution.list";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

interface Row {
  publicId: string;
  agentId: string | null;
  originType: string;
  originId: string;
  status: string;
  startedAt: Date | null;
  completedAt: Date | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: string | null;
  createdAt: Date;
}

function row(i: number): Row {
  return {
    publicId: `aex_${i}`,
    agentId: null,
    originType: "chat",
    originId: "00000000-0000-4000-8000-000000000001",
    status: "completed",
    startedAt: new Date(`2026-06-16T00:0${i}:00Z`),
    completedAt: new Date(`2026-06-16T00:0${i}:04Z`),
    latencyMs: 4000,
    inputTokens: 100,
    outputTokens: 50,
    estimatedCostUsd: "0.012000",
    createdAt: new Date(`2026-06-16T00:0${i}:00Z`),
  };
}

// The handler issues one withTenantDb: select→from→where→orderBy→limit.
function setup(rows: Row[]) {
  vi.mocked(withTenantDb).mockImplementation((fn) => {
    if (typeof fn !== "function") return undefined as never;
    const tx = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({ limit: () => Promise.resolve(rows) }),
          }),
        }),
      }),
    };
    return fn(tx as unknown as Parameters<typeof fn>[0]);
  });
}

describe("agent.execution.list handler", () => {
  beforeEach(() => vi.mocked(withTenantDb).mockReset());

  it("returns rows newest-first with null nextCursor when under the limit", async () => {
    setup([row(3), row(2), row(1)]);
    const out = await agentExecutionListHandler({ limit: 25 }, CTX);
    expect(out.executions).toHaveLength(3);
    expect(out.executions[0]?.executionId).toBe("aex_3");
    expect(out.executions[0]?.estimatedCostUsd).toBe("0.012000");
    expect(out.nextCursor).toBeNull();
  });

  it("computes nextCursor and trims the over-fetched row when a page is full", async () => {
    // limit 2 → handler fetches 3; the extra row signals another page exists.
    setup([row(3), row(2), row(1)]);
    const out = await agentExecutionListHandler({ limit: 2 }, CTX);
    expect(out.executions).toHaveLength(2);
    expect(out.executions.map((e) => e.executionId)).toEqual([
      "aex_3",
      "aex_2",
    ]);
    // Cursor is the createdAt of the LAST returned row (aex_2), not the dropped one.
    expect(out.nextCursor).toBe(row(2).createdAt.toISOString());
  });

  it("returns an empty page with null cursor", async () => {
    setup([]);
    const out = await agentExecutionListHandler({ limit: 25 }, CTX);
    expect(out.executions).toEqual([]);
    expect(out.nextCursor).toBeNull();
  });
});

// ADR-235: each turn of the in-app assistant records an execution under the
// workspace's managed `interactive_chat` agent. That record is internal, so
// only the assistant itself reads it back.
describe("agent.execution.list handler: the in-app assistant's executions", () => {
  beforeEach(() => vi.mocked(withTenantDb).mockReset());

  const dialect = new PgDialect();
  /** The NOT EXISTS test the handler adds, as the dialect renders it. */
  const EXCLUSION =
    /not exists \(select 1 from "agent"\."agents" where "agent"\."agents"\."id" = "agent"\."agent_executions"\."agent_id" and "agent"\."agents"\."agent_type" = \$(\d+)\)/u;

  /**
   * A fake tx that renders the WHERE it receives and applies the exclusion
   * the way Postgres would: a row whose agent is `interactive_chat` drops
   * out when the rendered WHERE carries the NOT EXISTS test.
   */
  function setupRendering(rows: Array<Row & { agentType: string | null }>) {
    const wheres: Array<{ sql: string; params: unknown[] }> = [];
    vi.mocked(withTenantDb).mockImplementation((fn) => {
      if (typeof fn !== "function") return undefined as never;
      const tx = {
        select: () => ({
          from: () => ({
            where: (cond: SQL) => {
              const rendered = dialect.sqlToQuery(cond);
              wheres.push(rendered);
              const match = EXCLUSION.exec(rendered.sql);
              const hides =
                match !== null &&
                rendered.params[Number(match[1]) - 1] === "interactive_chat";
              const visible = rows
                .filter((r) => !(hides && r.agentType === "interactive_chat"))
                .map(({ agentType: _agentType, ...r }) => r);
              return {
                orderBy: () => ({ limit: () => Promise.resolve(visible) }),
              };
            },
          }),
        }),
      };
      return fn(tx as unknown as Parameters<typeof fn>[0]);
    });
    return wheres;
  }

  const ASSISTANT_AGENT = "00000000-0000-4000-8000-0000000000a1";
  const rows = () => [
    { ...row(3), agentType: null },
    {
      ...row(2),
      publicId: "aex_assistant",
      agentId: ASSISTANT_AGENT,
      agentType: "interactive_chat",
    },
    { ...row(1), agentType: "custom" },
  ];

  it("leaves the assistant's execution out for a caller without its binding", async () => {
    const wheres = setupRendering(rows());
    const out = await agentExecutionListHandler({ limit: 25 }, CTX);
    expect(out.executions.map((e) => e.executionId)).toEqual([
      "aex_3",
      "aex_1",
    ]);
    // A run with no agent stays: NOT EXISTS keeps a null agent_id.
    expect(wheres).toHaveLength(1);
    expect(wheres[0]!.sql).toMatch(EXCLUSION);
    expect(wheres[0]!.params).toContain("interactive_chat");
  });

  it("shows the assistant its own execution when the call carries its binding", async () => {
    const wheres = setupRendering(rows());
    const out = await agentExecutionListHandler(
      { limit: 25 },
      {
        ...CTX,
        oxagenAssistant: createOxagenAssistantBinding({
          requestId: CTX.requestId,
        }),
      },
    );
    expect(out.executions.map((e) => e.executionId)).toEqual([
      "aex_3",
      "aex_assistant",
      "aex_1",
    ]);
    expect(wheres[0]!.sql).not.toContain("not exists");
    expect(wheres[0]!.params).not.toContain("interactive_chat");
  });

  it("hides the assistant's execution from a forged binding (negative)", async () => {
    const wheres = setupRendering(rows());
    const out = await agentExecutionListHandler(
      { limit: 25 },
      {
        ...CTX,
        oxagenAssistant: {
          principalKind: "oxagen_assistant",
          requestId: CTX.requestId,
        } as never,
      },
    );
    expect(out.executions.map((e) => e.executionId)).not.toContain(
      "aex_assistant",
    );
    expect(wheres[0]!.sql).toMatch(EXCLUSION);
  });
});
