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
import { agentSubagentSiblingsHandler } from "./agent.subagent.siblings";
import { SubagentRunNotFoundError } from "./subagent-errors";

import { TEST_CTX as CTX } from "../test-utils/fixtures";

// Shape of one joined row the self-join returns (caller + every sibling that
// shares the caller's fanout, each carrying the fanout's public id).
type JoinedRow = {
  publicId: string;
  capabilityName: string;
  status: string;
  summary: string | null;
  attempts: number;
  errorReason: string | null;
  fanoutPublicId: string;
};

function row(overrides: Partial<JoinedRow> = {}): JoinedRow {
  return {
    publicId: "sar_1",
    capabilityName: "search_web",
    status: "completed",
    summary: "3 hits for q1",
    attempts: 1,
    errorReason: null,
    fanoutPublicId: "fan_1",
    ...overrides,
  };
}

// Handler query: select().from().innerJoin().innerJoin().where() → rows[]
function setupMocks(rows: JoinedRow[]) {
  vi.mocked(withTenantDb).mockImplementationOnce(async (fn) =>
    fn({
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            innerJoin: () => ({
              where: () => Promise.resolve(rows),
            }),
          }),
        }),
      }),
    } as unknown as Parameters<typeof fn>[0]),
  );
}

// ---- Tests ------------------------------------------------------------------

describe("agent.subagent.siblings handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns compact sibling rows for the caller's fanout, EXCLUDING the caller", async () => {
    setupMocks([
      // caller row — must be dropped from the result
      row({
        publicId: "sar_1",
        capabilityName: "search_web",
        status: "running",
        summary: null,
      }),
      row({
        publicId: "sar_2",
        capabilityName: "code.search",
        status: "completed",
        summary: "found handler in agent.ts",
        attempts: 1,
      }),
      row({
        publicId: "sar_3",
        capabilityName: "fetch_web_page",
        status: "failed",
        summary: null,
        attempts: 2,
        errorReason: "timeout",
      }),
    ]);

    const result = await agentSubagentSiblingsHandler({ runId: "sar_1" }, CTX);

    expect(result.runId).toBe("sar_1");
    expect(result.fanoutId).toBe("fan_1");
    // Caller excluded — only the two siblings remain.
    expect(result.siblings.map((s) => s.runId)).toEqual(["sar_2", "sar_3"]);
    expect(result.siblings).toEqual([
      {
        runId: "sar_2",
        capabilityName: "code.search",
        status: "completed",
        summary: "found handler in agent.ts",
        attempts: 1,
        errorReason: null,
      },
      {
        runId: "sar_3",
        capabilityName: "fetch_web_page",
        status: "failed",
        summary: null,
        attempts: 2,
        errorReason: "timeout",
      },
    ]);
  });

  it("NEVER exposes input/output payloads — only compact fields", async () => {
    setupMocks([
      row({ publicId: "sar_1", status: "running", summary: null }),
      row({ publicId: "sar_2" }),
    ]);

    const result = await agentSubagentSiblingsHandler({ runId: "sar_1" }, CTX);

    const sibling = result.siblings[0] as Record<string, unknown>;
    expect(sibling).not.toHaveProperty("input");
    expect(sibling).not.toHaveProperty("output");
    expect(sibling).not.toHaveProperty("inputPayload");
    expect(sibling).not.toHaveProperty("outputPayload");
    expect(Object.keys(sibling).sort()).toEqual(
      [
        "attempts",
        "capabilityName",
        "errorReason",
        "runId",
        "status",
        "summary",
      ].sort(),
    );
  });

  it("returns an empty siblings list for a lone child (only the caller in the fanout)", async () => {
    setupMocks([row({ publicId: "sar_1", status: "running", summary: null })]);

    const result = await agentSubagentSiblingsHandler({ runId: "sar_1" }, CTX);

    expect(result.runId).toBe("sar_1");
    expect(result.fanoutId).toBe("fan_1");
    expect(result.siblings).toEqual([]);
  });

  it("throws a typed SubagentRunNotFoundError for an unknown or cross-tenant runId", async () => {
    // Tenant scoping: the where() filters on caller.orgId + caller.workspaceId,
    // so a runId owned by another org self-matches zero rows — indistinguishable
    // from a nonexistent id, surfaced as a 404, never another org's data.
    setupMocks([]);

    const err = await agentSubagentSiblingsHandler(
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
