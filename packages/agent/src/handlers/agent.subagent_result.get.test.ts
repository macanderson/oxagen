import { describe, expect, it, vi, beforeEach } from "vitest";

// ---- Module mocks -----------------------------------------------------------

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: vi.fn(),
  };
});

import { withTenantDb } from "@oxagen/database";
import { agentSubagentResultGetHandler } from "./agent.subagent_result.get";
import { SubagentRunNotFoundError } from "./subagent-errors";

import { TEST_CTX as CTX } from "../test-utils/fixtures";

type JoinedRow = {
  publicId: string;
  fanoutUuid: string;
  capabilityName: string;
  status: string;
  summary: string | null;
  inputPayload: unknown;
  outputPayload: unknown;
  errorReason: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  fanoutPublicId: string;
};

function joinedRow(overrides: Partial<JoinedRow> = {}): JoinedRow {
  return {
    publicId: "sar_1",
    fanoutUuid: "fanuuid_1",
    capabilityName: "search_web",
    status: "completed",
    summary: "3 hits for q1",
    inputPayload: { query: "q1" },
    outputPayload: { results: ["a", "b", "c"] },
    errorReason: null,
    startedAt: new Date("2024-01-01T00:00:00Z"),
    completedAt: new Date("2024-01-01T00:01:00Z"),
    fanoutPublicId: "fan_1",
    ...overrides,
  };
}

// Single select with innerJoin: select().from().innerJoin().where().limit()
function setupMocks(row: JoinedRow | null) {
  vi.mocked(withTenantDb).mockImplementationOnce(async (fn) =>
    fn({
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: (n: number) =>
                Promise.resolve(row ? [row].slice(0, n) : []),
            }),
          }),
        }),
      }),
    } as unknown as Parameters<typeof fn>[0]),
  );
}

// ---- Tests ------------------------------------------------------------------

describe("agent.subagent.result.get handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the run's FULL input + output payloads with fanout public id", async () => {
    setupMocks(joinedRow());

    const result = await agentSubagentResultGetHandler({ runId: "sar_1" }, CTX);

    expect(result).toMatchObject({
      runId: "sar_1",
      fanoutId: "fan_1",
      capabilityName: "search_web",
      status: "completed",
      summary: "3 hits for q1",
      input: { query: "q1" },
      output: { results: ["a", "b", "c"] },
      errorReason: null,
    });
    expect(result.startedAt).toBe("2024-01-01T00:00:00.000Z");
    expect(result.completedAt).toBe("2024-01-01T00:01:00.000Z");
  });

  it("returns null output/timestamps for a run that has not completed", async () => {
    setupMocks(
      joinedRow({
        status: "pending",
        summary: null,
        outputPayload: null,
        startedAt: null,
        completedAt: null,
      }),
    );

    const result = await agentSubagentResultGetHandler({ runId: "sar_1" }, CTX);

    expect(result.status).toBe("pending");
    expect(result.output).toBeNull();
    expect(result.summary).toBeNull();
    expect(result.startedAt).toBeNull();
    expect(result.completedAt).toBeNull();
  });

  it("throws a typed SubagentRunNotFoundError for an unknown or cross-tenant runId", async () => {
    // Tenant scoping: the query filters on ctx.orgId + ctx.workspaceId, so a
    // runId owned by another org resolves to zero rows — indistinguishable
    // from a nonexistent id, surfaced as a 404, never another org's data.
    setupMocks(null);

    const err = await agentSubagentResultGetHandler(
      { runId: "sar_other_org" },
      CTX,
    ).then(
      () => {
        throw new Error("expected handler to reject");
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SubagentRunNotFoundError);
    expect((err as SubagentRunNotFoundError).code).toBe(
      "subagent_run_not_found",
    );
    expect((err as Error).message).toBe("Subagent run sar_other_org not found");
  });
});
