import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock the LLM layer ────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  generateObjectFor: vi.fn(),
  selectModel: vi.fn(() => "mock-model"),
  resolveAgent: vi.fn(),
  withTenantDb: vi.fn(),
}));

vi.mock("@oxagen/ai", () => ({
  generateObjectFor: mocks.generateObjectFor,
  selectModel: mocks.selectModel,
}));

vi.mock("@oxagen/agent/handlers/_agent-definition", () => ({
  resolveAgent: mocks.resolveAgent,
}));

// NOTE: @oxagen/oxagen/agent-schema and @oxagen/oxagen/interactive-agent are left
// REAL. parseAgentDefinitionConfig parses the (valid) CONFIG_BLOB for prompt
// building, and computeConfigChecksum stays real so the checksum the handler
// computes matches the one this test computes from the same blob.

vi.mock("@oxagen/database", () => ({
  schema: {
    agents: { id: "agents.id", workspaceId: "agents.workspaceId" },
    agentVersions: {
      config: "agentVersions.config",
      agentId: "agentVersions.agentId",
      version: "agentVersions.version",
    },
  },
  withTenantDb: (fn: (tx: unknown) => Promise<unknown>) =>
    mocks.withTenantDb(fn),
}));

vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ({ and: a }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  desc: (a: unknown) => ({ desc: a }),
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  agentDefinitionSummarizeHandler,
  AgentSummarizeError,
} from "./agent.definition.summarize";
import { agentDefinitionSummarize } from "@oxagen/oxagen/contracts/agent.definition.summarize";
import { computeConfigChecksum } from "@oxagen/oxagen/interactive-agent";
import { TEST_CTX, makeCTX } from "./test-utils/fixtures";

// ── fixtures ──────────────────────────────────────────────────────────────────

// Raw version-config blob (what checksums are computed over AND what the real
// parseAgentDefinitionConfig parses to build the prompt). A valid
// AgentDefinitionConfig so the real parser accepts it.
const CONFIG_BLOB = {
  graph: {
    ontologyId: "sales",
    mode: "read",
    retrieval: { strategy: "hybrid" },
    budget: { maxHops: 2, maxNodes: 20 },
  },
  agentTools: [{ type: "skill", ref: "summarization" }],
  triggers: [{ type: "manual", enabled: true }],
  instructions: "Scan every deal and flag the risky ones for review.",
};
const CHECKSUM = computeConfigChecksum(CONFIG_BLOB);

function agentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "uuid-1",
    publicId: "agt_1",
    slug: "deal-scanner",
    name: "Deal Scanner",
    description: "Scans deals for risk.",
    agentType: "custom",
    status: "draft",
    deploymentStatus: "inactive",
    activeVersionId: null,
    avatarUrl: null,
    summary: null,
    summaryChecksum: null,
    ...overrides,
  };
}

/** Wire withTenantDb: first call = read (returns { agent, config }), second =
 *  write (captures the .set() args). resolveAgent + the version query resolve
 *  through the fake tx. */
function wireDb(opts: {
  agent: ReturnType<typeof agentRow> | null;
  versionRows?: unknown[];
}) {
  const captured = { set: undefined as Record<string, unknown> | undefined };
  mocks.resolveAgent.mockResolvedValue(opts.agent);

  const selectChain: Record<string, unknown> = {};
  selectChain.from = () => selectChain;
  selectChain.where = () => selectChain;
  selectChain.orderBy = () => selectChain;
  selectChain.limit = () =>
    Promise.resolve(opts.versionRows ?? [{ config: CONFIG_BLOB }]);

  const updateChain: Record<string, unknown> = {};
  updateChain.set = (v: Record<string, unknown>) => {
    captured.set = v;
    return updateChain;
  };
  updateChain.where = () => Promise.resolve(undefined);

  const tx = {
    select: () => selectChain,
    update: () => updateChain,
  };
  mocks.withTenantDb.mockImplementation(
    (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
  );
  return captured;
}

const INPUT = { agentId: "agt_1" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.selectModel.mockReturnValue("mock-model");
});

describe("agentDefinitionSummarizeHandler", () => {
  // ── fresh generation ────────────────────────────────────────────────────────
  it("generates, persists, and returns a fresh summary when none exists", async () => {
    const captured = wireDb({ agent: agentRow() });
    mocks.generateObjectFor.mockResolvedValue({
      object: {
        summary: "Scans new deals and flags the risky ones for review.",
      },
    });

    const out = await agentDefinitionSummarizeHandler(INPUT, TEST_CTX);

    expect(out.agentId).toBe("agt_1");
    expect(out.summary).toBe(
      "Scans new deals and flags the risky ones for review.",
    );
    expect(out.checksum).toBe(CHECKSUM);
    // The model call happened, on the fast tier, with tenant telemetry.
    expect(mocks.generateObjectFor).toHaveBeenCalledTimes(1);
    expect(mocks.selectModel).toHaveBeenCalledWith({ tier: "fast" });
    const call = mocks.generateObjectFor.mock.calls[0]![0] as {
      model: unknown;
      temperature: number;
      prompt: string;
      telemetry: { orgId: string; workspaceId: string };
    };
    expect(call.model).toBe("mock-model");
    expect(call.prompt).toContain("Deal Scanner");
    expect(call.prompt).toContain("skill:summarization");
    expect(call.telemetry.orgId).toBe(TEST_CTX.orgId);
    // The summary + checksum were persisted.
    expect(captured.set).toEqual({
      summary: "Scans new deals and flags the risky ones for review.",
      summaryChecksum: CHECKSUM,
      updatedAt: expect.any(Date),
    });
    // Contract-valid output.
    expect(() => agentDefinitionSummarize.output.parse(out)).not.toThrow();
  });

  // ── cache short-circuit ───────────────────────────────────────────────────────
  it("returns the cached summary without an LLM call when the checksum still matches", async () => {
    wireDb({
      agent: agentRow({
        summary: "A cached summary.",
        summaryChecksum: CHECKSUM,
      }),
    });

    const out = await agentDefinitionSummarizeHandler(INPUT, TEST_CTX);

    expect(out.summary).toBe("A cached summary.");
    expect(out.checksum).toBe(CHECKSUM);
    expect(mocks.generateObjectFor).not.toHaveBeenCalled();
  });

  it("regenerates despite a checksum match when force is set", async () => {
    const captured = wireDb({
      agent: agentRow({ summary: "Stale.", summaryChecksum: CHECKSUM }),
    });
    mocks.generateObjectFor.mockResolvedValue({
      object: { summary: "A freshly regenerated summary." },
    });

    const out = await agentDefinitionSummarizeHandler(
      { agentId: "agt_1", force: true },
      TEST_CTX,
    );

    expect(mocks.generateObjectFor).toHaveBeenCalledTimes(1);
    expect(out.summary).toBe("A freshly regenerated summary.");
    expect(captured.set?.summary).toBe("A freshly regenerated summary.");
  });

  it("regenerates when a summary exists but the config checksum has changed", async () => {
    wireDb({
      agent: agentRow({
        summary: "Old summary.",
        summaryChecksum: "stale-checksum-does-not-match",
      }),
    });
    mocks.generateObjectFor.mockResolvedValue({
      object: { summary: "New summary for the changed config." },
    });

    const out = await agentDefinitionSummarizeHandler(INPUT, TEST_CTX);

    expect(mocks.generateObjectFor).toHaveBeenCalledTimes(1);
    expect(out.summary).toBe("New summary for the changed config.");
    expect(out.checksum).toBe(CHECKSUM);
  });

  // ── truncation ────────────────────────────────────────────────────────────────
  it("hard-truncates the model output to 256 characters and normalizes whitespace", async () => {
    const captured = wireDb({ agent: agentRow() });
    // 400 chars with runs of whitespace to prove normalization + slice.
    const long = "word ".repeat(80) + "   tail";
    mocks.generateObjectFor.mockResolvedValue({
      object: { summary: `   ${long}   ` },
    });

    const out = await agentDefinitionSummarizeHandler(INPUT, TEST_CTX);

    expect(out.summary.length).toBe(256);
    expect(out.summary.startsWith("word word")).toBe(true);
    // No double spaces survived normalization.
    expect(out.summary).not.toContain("  ");
    expect(captured.set?.summary).toBe(out.summary);
  });

  // ── error paths ────────────────────────────────────────────────────────────────
  it("throws a typed AgentSummarizeError when the model call fails", async () => {
    wireDb({ agent: agentRow() });
    mocks.generateObjectFor.mockRejectedValue(new Error("gateway down"));

    await expect(
      agentDefinitionSummarizeHandler(INPUT, TEST_CTX),
    ).rejects.toBeInstanceOf(AgentSummarizeError);
    await expect(
      agentDefinitionSummarizeHandler(INPUT, TEST_CTX),
    ).rejects.toThrow(/gateway down/);
  });

  it("throws AgentSummarizeError when the model returns an empty summary", async () => {
    wireDb({ agent: agentRow() });
    mocks.generateObjectFor.mockResolvedValue({ object: { summary: "   " } });

    await expect(
      agentDefinitionSummarizeHandler(INPUT, TEST_CTX),
    ).rejects.toThrow(/empty summary/);
  });

  it("throws AgentSummarizeError when the agent is not found", async () => {
    wireDb({ agent: null });

    await expect(
      agentDefinitionSummarizeHandler(INPUT, TEST_CTX),
    ).rejects.toThrow(/not found/);
    expect(mocks.generateObjectFor).not.toHaveBeenCalled();
  });

  it("throws AgentSummarizeError when the agent has no version config", async () => {
    wireDb({ agent: agentRow(), versionRows: [] });

    await expect(
      agentDefinitionSummarizeHandler(INPUT, TEST_CTX),
    ).rejects.toThrow(/no version config/);
    expect(mocks.generateObjectFor).not.toHaveBeenCalled();
  });

  it("throws when workspaceId is missing from context", async () => {
    const noWsCtx = makeCTX({ workspaceId: undefined as unknown as string });

    await expect(
      agentDefinitionSummarizeHandler(INPUT, noWsCtx),
    ).rejects.toThrow(/workspaceId is required/);
  });

  // ── contract shape ───────────────────────────────────────────────────────────
  it("rejects input without an agentId at the contract boundary", () => {
    expect(() => agentDefinitionSummarize.input.parse({})).toThrow();
    expect(() =>
      agentDefinitionSummarize.input.parse({ agentId: "agt_1" }),
    ).not.toThrow();
    expect(() =>
      agentDefinitionSummarize.input.parse({ agentId: "agt_1", force: true }),
    ).not.toThrow();
  });
});
