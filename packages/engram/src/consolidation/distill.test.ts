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
const { generateObjectFor, selectModel } = vi.hoisted(() => ({
  generateObjectFor: vi.fn(),
  selectModel: vi.fn(() => ({ modelId: "test/fast" })),
}));
vi.mock("@oxagen/ai", () => ({ generateObjectFor, selectModel }));

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
