import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const generateObjectFor = vi.fn();
vi.mock("@oxagen/ai", () => ({ generateObjectFor: (...a: unknown[]) => generateObjectFor(...a) }));

const invoke = vi.fn();
vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const getPinnedSchema = vi.fn(async (..._a: unknown[]) => null as unknown);
vi.mock("./schema.pinned", () => ({
  getPinnedSchema: (...a: unknown[]) => getPinnedSchema(...a),
}));

function pinnedWith(relTypes: string[]): unknown {
  return {
    registryId: "scr_1",
    versionId: "scv_1",
    versionNumber: 1,
    enforcementMode: "lenient",
    conformanceFloor: 0.5,
    labels: [],
    relationshipTypes: relTypes.map((name) => ({
      schemaName: "s",
      name,
      displayName: name,
      description: null,
      startLabel: null,
      endLabel: null,
      cardinality: null,
      properties: [],
    })),
  };
}

import type { CapabilityContext } from "@oxagen/oxagen";
import { graphIngestHandler, sanitizeLabel } from "./graph.ingest";

const ctx: CapabilityContext = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "u",
  apiKeyId: null,
  requestId: "req-1",
  surface: "app",
  messageId: null,
};

describe("sanitizeLabel", () => {
  it("falls back to Entity for blank, and caps length at 100", () => {
    expect(sanitizeLabel("  ")).toBe("Entity");
    expect(sanitizeLabel("Person")).toBe("Person");
    expect(sanitizeLabel("x".repeat(200)).length).toBe(100);
  });
});

function wireInvoke() {
  invoke.mockImplementation(async (cap: string, input: unknown) => {
    if (cap === "prompt.settings.read") return { additionalInstructions: "" };
    if (cap === "graph.node.upsert") {
      const name = (input as { displayName: string }).displayName;
      return { nodeId: `node_${name}`, created: true };
    }
    if (cap === "graph.edge.upsert") return { edgeId: "e_1", created: true };
    throw new Error(`unexpected invoke ${cap}`);
  });
}

describe("graphIngestHandler", () => {
  beforeEach(() => {
    getPinnedSchema.mockResolvedValue(null);
  });
  afterEach(() => {
    generateObjectFor.mockReset();
    invoke.mockReset();
    getPinnedSchema.mockReset();
  });

  it("upserts extracted entities and only relationships whose endpoints resolved", async () => {
    wireInvoke();
    generateObjectFor.mockResolvedValue({
      object: {
        entities: [
          { name: "USS Nautilus", type: "Vessel", confidence: 0.95 },
          { name: "Hyman Rickover", type: "Person", confidence: 0.8 },
        ],
        relationships: [
          { fromName: "Hyman Rickover", toName: "USS Nautilus", relationshipType: "CREATED_BY", confidence: 0.7 },
          // Endpoint "Ghost" was never extracted → this edge must be dropped.
          { fromName: "Ghost", toName: "USS Nautilus", relationshipType: "RELATED_TO", confidence: 0.5 },
        ],
      },
    });

    const out = await graphIngestHandler(
      { text: "The USS Nautilus was built under Admiral Rickover.", maxEntities: 25 },
      ctx,
    );

    expect(out.entities).toHaveLength(2);
    expect(out.entities[0]).toMatchObject({ name: "USS Nautilus", type: "Vessel", nodeId: "node_USS Nautilus", created: true });
    // Only the resolved relationship survives (skill discipline: no invented endpoints).
    expect(out.relationships).toHaveLength(1);
    expect(out.relationships[0]).toMatchObject({ from: "Hyman Rickover", to: "USS Nautilus", relationshipType: "CREATED_BY" });
    expect(out.summary).toContain("2 entities");
    expect(out.summary).toContain("1 relationship");

    // graph.node.upsert called per entity; graph.edge.upsert called once.
    const nodeCalls = invoke.mock.calls.filter((c) => c[0] === "graph.node.upsert");
    const edgeCalls = invoke.mock.calls.filter((c) => c[0] === "graph.edge.upsert");
    expect(nodeCalls).toHaveLength(2);
    expect(edgeCalls).toHaveLength(1);
    // graph.edge.upsert now carries `relationshipType` (not edgeType).
    expect((edgeCalls[0]?.[1] as { relationshipType: string }).relationshipType).toBe("CREATED_BY");
    // confidence carried onto the node properties + edge properties (as string).
    expect((nodeCalls[0]?.[1] as { properties: { confidence: number } }).properties.confidence).toBe(0.95);
    expect((edgeCalls[0]?.[1] as { properties: { confidence: string } }).properties.confidence).toBe("0.7");
  });

  it("§3.2/§7.3: when a registry is pinned, grounds the prompt + drops out-of-vocabulary relationships", async () => {
    wireInvoke();
    getPinnedSchema.mockResolvedValue(pinnedWith(["SIGNED_CONTRACT"]));
    generateObjectFor.mockResolvedValue({
      object: {
        entities: [
          { name: "Acme", type: "Customer", confidence: 0.95 },
          { name: "MSA-1", type: "Contract", confidence: 0.9 },
        ],
        relationships: [
          // In active vocab → kept.
          { fromName: "Acme", toName: "MSA-1", relationshipType: "SIGNED_CONTRACT", confidence: 0.9 },
          // NOT in active vocab → dropped before any graph mutation.
          { fromName: "Acme", toName: "MSA-1", relationshipType: "EMPLOYS", confidence: 0.9 },
        ],
      },
    });

    const out = await graphIngestHandler({ text: "Acme signed MSA-1.", maxEntities: 25 }, ctx);

    // Only the in-vocabulary relationship is upserted.
    const edgeCalls = invoke.mock.calls.filter((c) => c[0] === "graph.edge.upsert");
    expect(edgeCalls).toHaveLength(1);
    expect((edgeCalls[0]?.[1] as { relationshipType: string }).relationshipType).toBe("SIGNED_CONTRACT");
    expect(out.relationships.map((r) => r.relationshipType)).toEqual(["SIGNED_CONTRACT"]);

    // The active vocabulary was injected into the extraction prompt as grounding.
    const promptArg = (generateObjectFor.mock.calls[0]?.[0] as { prompt: string }).prompt;
    expect(promptArg).toContain("SIGNED_CONTRACT");
    expect(promptArg).toContain("active schema vocabulary");
  });

  it("returns an empty result (no edges) when the model extracts nothing", async () => {
    wireInvoke();
    generateObjectFor.mockResolvedValue({ object: { entities: [], relationships: [] } });
    const out = await graphIngestHandler({ text: "nothing here", maxEntities: 25 }, ctx);
    expect(out.entities).toHaveLength(0);
    expect(out.relationships).toHaveLength(0);
    expect(out.summary).toContain("0 entities");
  });

  it("continues when a single entity upsert fails", async () => {
    invoke.mockImplementation(async (cap: string, input: unknown) => {
      if (cap === "prompt.settings.read") return { additionalInstructions: "" };
      if (cap === "graph.node.upsert") {
        const name = (input as { displayName: string }).displayName;
        if (name === "Bad") throw new Error("neo4j down");
        return { nodeId: `node_${name}`, created: true };
      }
      if (cap === "graph.edge.upsert") return { edgeId: "e_1", created: true };
      throw new Error("unexpected");
    });
    generateObjectFor.mockResolvedValue({
      object: {
        entities: [
          { name: "Good", type: "Thing", confidence: 0.9 },
          { name: "Bad", type: "Thing", confidence: 0.9 },
        ],
        relationships: [],
      },
    });
    const out = await graphIngestHandler({ text: "x", maxEntities: 25 }, ctx);
    expect(out.entities.map((e) => e.name)).toEqual(["Good"]);
  });
});
