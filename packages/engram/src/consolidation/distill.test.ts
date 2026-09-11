/**
 * Tests for the LLM-backed episodic→semantic distillation path and its
 * deterministic heuristic fallback. `@oxagen/ai` is mocked so no real gateway
 * call is made; we assert routing between the LLM path and the fallback.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRecord } from "../record";
import type { Namespace, Provenance } from "../types";

// Mock the AI chokepoint. `selectModel` returns a sentinel; `generateObjectFor`
// is controlled per-test. `vi.hoisted` lets the mock factory reference these.
const { generateObjectFor, selectModel, resolveModelFundingSource } =
  vi.hoisted(() => ({
    generateObjectFor: vi.fn(),
    selectModel: vi.fn(() => ({ modelId: "test/fast" })),
    // Defaults to `customer` deliberately. `resolveModelFundingSource` calls
    // guessing `platform` the one direction the funding seam must never err in,
    // so a test whose stub guessed it would be unable to catch that mistake.
    resolveModelFundingSource: vi.fn(async () => ({ fundedBy: "customer" })),
  }));
vi.mock("@oxagen/ai", () => ({
  generateObjectFor,
  selectModel,
  resolveModelFundingSource,
  CREDIT_REASONS: { CONSUME_ASSISTANT_TOKENS: "consume_assistant_tokens" },
}));

// Import after the mock is registered.
import {
  extractFactFromCluster,
  extractFactHeuristic,
  distill,
} from "./distill";

const NS: Namespace = { org: "test-org", workspace: "test-ws" };
const PROV: Provenance = {
  author: "test",
  derivedFrom: [],
  timestamp: Date.now(),
};

function makeEpisodic(
  event: string,
  outcome: "success" | "failure",
  tool: string,
) {
  return createRecord({
    kind: "episodic",
    namespace: NS,
    body: { event, payload: { tool }, outcome },
    salience: 0.5,
    confidence: 1.0,
    provenance: { ...PROV, tool },
  });
}

const TELEMETRY = {
  telemetry: {
    orgId: "org-1",
    workspaceId: "ws-1",
    surface: "ingestion" as const,
    messageId: null,
  },
};

const cluster = [
  makeEpisodic("tool_call", "success", "grep"),
  makeEpisodic("tool_call", "success", "grep"),
  makeEpisodic("tool_call", "failure", "grep"),
];

describe("extractFactFromCluster — LLM path", () => {
  beforeEach(() => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "test-key");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps the deterministic fact and only adopts the LLM's domain label (ADR-021 §1)", async () => {
    // The model decorates the DOMAIN; the fact TEXT is the deterministic
    // heuristic identity and must not come from the model.
    generateObjectFor.mockResolvedValueOnce({
      object: { domain: "tooling" },
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });

    const fact = await extractFactFromCluster(cluster, TELEMETRY);
    const heuristic = extractFactHeuristic(cluster)!;

    expect(generateObjectFor).toHaveBeenCalledTimes(1);
    // Fast/cheap tier + temperature 0 for a deterministic background job.
    expect(selectModel).toHaveBeenCalledWith({ tier: "fast" });
    expect(generateObjectFor.mock.calls[0]![0]).toMatchObject({
      temperature: 0,
    });
    expect(fact!.fact).toBe(heuristic.fact); // identity is deterministic
    expect(fact!.domain).toBe("tooling"); // decoration adopted
  });

  it("forwards the caller's telemetry into generateObjectFor", async () => {
    generateObjectFor.mockResolvedValueOnce({
      object: { domain: "general" },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });
    await extractFactFromCluster(cluster, TELEMETRY);
    expect(generateObjectFor.mock.calls[0]![0]).toMatchObject({
      telemetry: TELEMETRY.telemetry,
    });
  });

  it("charges the organisation's own funding source, never a guessed one", async () => {
    // ADR-053: an organisation that brought its own key must not be billed for
    // the call its key answered. The resolver is asked per organisation, and
    // whatever it answers is what reaches the chokepoint unchanged.
    resolveModelFundingSource.mockResolvedValueOnce({ fundedBy: "customer" });
    generateObjectFor.mockResolvedValueOnce({
      object: { domain: "general" },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });

    await extractFactFromCluster(cluster, TELEMETRY);

    expect(resolveModelFundingSource).toHaveBeenCalledWith(
      TELEMETRY.telemetry.orgId,
    );
    expect(generateObjectFor.mock.calls[0]![0]).toMatchObject({
      fundedBy: "customer",
      // The reason the assistant spend cap sums. A reason outside that sum is
      // invisible to the cap meant to bound it (ADR-052/053).
      chargeReason: "consume_assistant_tokens",
    });
  });

  it("passes a platform funding source through unchanged", async () => {
    resolveModelFundingSource.mockResolvedValueOnce({ fundedBy: "platform" });
    generateObjectFor.mockResolvedValueOnce({
      object: { domain: "general" },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });

    await extractFactFromCluster(cluster, TELEMETRY);

    expect(generateObjectFor.mock.calls[0]![0]).toMatchObject({
      fundedBy: "platform",
    });
  });

  it("falls back to the heuristic when generateObjectFor throws", async () => {
    generateObjectFor.mockRejectedValueOnce(new Error("gateway 500"));

    const fact = await extractFactFromCluster(cluster, TELEMETRY);

    expect(generateObjectFor).toHaveBeenCalledTimes(1);
    expect(fact).toEqual(extractFactHeuristic(cluster));
  });

  it("keeps the heuristic domain when the model returns an empty domain label", async () => {
    generateObjectFor.mockResolvedValueOnce({
      object: { domain: "   " },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });
    const fact = await extractFactFromCluster(cluster, TELEMETRY);
    expect(fact).toEqual(extractFactHeuristic(cluster));
  });
});

describe("extractFactFromCluster — heuristic fallback conditions", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses the heuristic (no LLM call) when no options are supplied", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "test-key");
    const fact = await extractFactFromCluster(cluster);
    expect(generateObjectFor).not.toHaveBeenCalled();
    expect(fact).toEqual(extractFactHeuristic(cluster));
  });

  it("uses the heuristic (no LLM call) when no gateway key is configured", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "");
    const fact = await extractFactFromCluster(cluster, TELEMETRY);
    expect(generateObjectFor).not.toHaveBeenCalled();
    expect(fact).toEqual(extractFactHeuristic(cluster));
  });

  it("returns null for an empty cluster without calling the LLM", async () => {
    vi.stubEnv("AI_GATEWAY_API_KEY", "test-key");
    const fact = await extractFactFromCluster([], TELEMETRY);
    expect(fact).toBeNull();
    expect(generateObjectFor).not.toHaveBeenCalled();
  });
});

describe("distill — LLM path integration", () => {
  beforeEach(() => vi.stubEnv("AI_GATEWAY_API_KEY", "test-key"));
  afterEach(() => vi.unstubAllEnvs());

  it("threads the deterministic fact with the LLM's domain through distill()", async () => {
    generateObjectFor.mockResolvedValue({
      object: { domain: "tooling" },
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });

    const result = await distill(cluster, [], undefined, TELEMETRY);
    const heuristic = extractFactHeuristic(cluster)!;

    expect(generateObjectFor).toHaveBeenCalled();
    expect(result.newFacts).toHaveLength(1);
    expect(result.newFacts[0]!.fact.fact).toBe(heuristic.fact);
    expect(result.newFacts[0]!.fact.domain).toBe("tooling");
    expect(result.processedEventIds).toHaveLength(3);
  });

  it("uses the heuristic in distill() when no options are provided", async () => {
    const result = await distill(cluster, []);
    expect(generateObjectFor).not.toHaveBeenCalled();
    expect(result.newFacts).toHaveLength(1);
    expect(result.newFacts[0]!.fact).toEqual(extractFactHeuristic(cluster));
  });
});

// ── A silent fall back and a working heuristic look identical from outside ───
//
// The LLM path resolves funding before it calls a model, and that lookup reads
// through withTenantDb. Consolidation is a background job, so a scopeless run
// throws — and the catch turned that into the same deterministic result a
// healthy run produces. The degradation is permanent and looks like normal
// operation. `onError` is how it becomes visible, and `phase` is how a funding
// failure is told from a model outage.
describe("extractFactFromCluster — reporting a failure it swallows", () => {
  beforeEach(() => vi.stubEnv("AI_GATEWAY_API_KEY", "test-key"));
  afterEach(() => vi.unstubAllEnvs());

  it("reports a funding failure as phase 'funding', and still falls back", async () => {
    const onError = vi.fn();
    resolveModelFundingSource.mockRejectedValueOnce(
      new Error("No active tenant scope"),
    );

    const fact = await extractFactFromCluster(cluster, {
      ...TELEMETRY,
      onError,
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![1]).toEqual({ phase: "funding" });
    expect(generateObjectFor).not.toHaveBeenCalled();
    // Still degrades rather than failing consolidation.
    expect(fact!.fact).toBe(extractFactHeuristic(cluster)!.fact);
  });

  it("reports a model failure as phase 'generate'", async () => {
    const onError = vi.fn();
    generateObjectFor.mockRejectedValueOnce(new Error("gateway down"));

    const fact = await extractFactFromCluster(cluster, {
      ...TELEMETRY,
      onError,
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![1]).toEqual({ phase: "generate" });
    expect(fact!.fact).toBe(extractFactHeuristic(cluster)!.fact);
  });
});
