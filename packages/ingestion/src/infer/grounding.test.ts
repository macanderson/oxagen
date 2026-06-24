/**
 * §7.3 ingestion-time grounding tests for inferSemanticEdges + buildSchemaContext.
 *
 * Verifies that the pinned active vocabulary is injected into the inference
 * system prompt as fenced DATA (not instructions), and that inferred
 * relationship types are constrained to the active vocabulary.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  close: vi.fn(async () => undefined),
  generateObjectFor: vi.fn(),
  upsertInferredEdges: vi.fn(async (..._a: unknown[]) => undefined),
}));

vi.mock("@oxagen/ontology/tenant", () => ({
  scopedSession: () => ({ run: mocks.run, close: mocks.close }),
}));

vi.mock("@oxagen/ai", () => ({
  generateObjectFor: (...a: unknown[]) => mocks.generateObjectFor(...a),
}));

vi.mock("../mutations/upsert-entity", () => ({
  upsertInferredEdges: (...a: unknown[]) => mocks.upsertInferredEdges(...a),
}));

import { inferSemanticEdges, buildSchemaContext } from "./index";
import type { PinnedSchema, SemanticInferenceJob } from "../types";

function makeRows(rows: Record<string, unknown>[]) {
  return {
    records: rows.map((fields) => ({
      get: (key: string) => (key in fields ? fields[key] : null),
    })),
  };
}

function pinned(): PinnedSchema {
  return {
    registryId: "scr_1",
    versionId: "scv_1",
    versionNumber: 1,
    enforcementMode: "lenient",
    conformanceFloor: 0.5,
    labels: [
      {
        schemaName: "starter",
        name: "Customer",
        displayName: "Customer",
        description: "a paying account",
        naturalKeyProps: [],
        properties: [
          {
            key: "arr",
            dataType: "number",
            required: true,
            description: "annual recurring revenue",
            enumValues: null,
            itemType: null,
            constraints: {},
            example: "120000",
          },
        ],
      },
    ],
    relationshipTypes: [
      {
        schemaName: "starter",
        name: "REFERENCES",
        displayName: "References",
        description: "customer references a contract",
        startLabel: "Customer",
        endLabel: "Contract",
        cardinality: null,
        properties: [],
      },
    ],
  };
}

function job(overrides: Partial<SemanticInferenceJob> = {}): SemanticInferenceJob {
  return {
    nodeId: "n-1",
    entityType: "Customer",
    propertiesSnapshot: { arr: 120000 },
    workspaceId: "ws-1",
    orgId: "org-1",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // node load returns naturalKey; target resolution returns the candidate.
  mocks.run
    .mockResolvedValueOnce(makeRows([{ naturalKey: "nk-1", displayName: "Acme" }]))
    .mockResolvedValueOnce(makeRows([{ naturalKey: "nk-target", nodeId: "n-target" }]));
});

describe("buildSchemaContext (§7.3)", () => {
  it("returns empty when no schema is pinned", () => {
    const out = buildSchemaContext("Customer", null);
    expect(out.text).toBe("");
    expect(out.allowedRelationshipTypes).toEqual([]);
  });

  it("fences the label + property + relationship grounding as DATA", () => {
    const out = buildSchemaContext("Customer", pinned());
    expect(out.text).toContain("SCHEMA CONTEXT");
    expect(out.text).toContain("NOT instructions"); // §11 prompt-injection posture
    expect(out.text).toContain("Customer");
    expect(out.text).toContain("annual recurring revenue"); // property description
    expect(out.text).toContain("REFERENCES (Customer → Contract)");
    expect(out.allowedRelationshipTypes).toEqual(["REFERENCES"]);
  });
});

describe("inferSemanticEdges grounding", () => {
  it("injects the active-vocabulary schema context into the system prompt", async () => {
    mocks.generateObjectFor.mockResolvedValue({
      object: {
        inferredEdges: [
          { targetNaturalKey: "nk-target", edgeType: "REFERENCES", confidence: 0.95, rationale: "x" },
        ],
      },
    });

    await inferSemanticEdges(job({ pinnedSchema: pinned() }));

    const system = (mocks.generateObjectFor.mock.calls[0]?.[0] as { system: string }).system;
    expect(system).toContain("SCHEMA CONTEXT");
    expect(system).toContain("REFERENCES");
    expect(system).toContain("Use ONLY relationship types from the allowed list");
  });

  it("drops inferred relationship types outside the active vocabulary", async () => {
    mocks.generateObjectFor.mockResolvedValue({
      object: {
        inferredEdges: [
          // In active vocab → kept.
          { targetNaturalKey: "nk-target", edgeType: "REFERENCES", confidence: 0.95, rationale: "x" },
          // PART_OF is a writable template type but NOT in the pinned active vocab → dropped.
          { targetNaturalKey: "nk-target", edgeType: "PART_OF", confidence: 0.95, rationale: "y" },
        ],
      },
    });

    const out = await inferSemanticEdges(job({ pinnedSchema: pinned() }));

    expect(out.inferredEdges.map((e) => e.edgeType)).toEqual(["REFERENCES"]);
    // upsertInferredEdges received only the in-vocabulary edge.
    const written = mocks.upsertInferredEdges.mock.calls[0]?.[0] as unknown as Array<{
      edgeType: string;
    }>;
    expect(written.map((e) => e.edgeType)).toEqual(["REFERENCES"]);
  });

  it("leaves inference unconstrained when no schema is pinned", async () => {
    mocks.generateObjectFor.mockResolvedValue({
      object: {
        inferredEdges: [
          { targetNaturalKey: "nk-target", edgeType: "PART_OF", confidence: 0.95, rationale: "z" },
        ],
      },
    });

    const out = await inferSemanticEdges(job({ pinnedSchema: null }));

    // No pin → the writable template type survives.
    expect(out.inferredEdges.map((e) => e.edgeType)).toEqual(["PART_OF"]);
    const system = (mocks.generateObjectFor.mock.calls[0]?.[0] as { system: string }).system;
    expect(system).not.toContain("SCHEMA CONTEXT");
  });
});
