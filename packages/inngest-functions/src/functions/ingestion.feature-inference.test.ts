import { describe, it, expect, vi } from "vitest";
import {
  languageFromKey,
  buildFeaturePrompt,
  parseFeaturesFromText,
  writeAcceptedFeatures,
  CONFIDENCE_THRESHOLD,
  type InferredFeature,
} from "./ingestion.feature-inference";

describe("languageFromKey", () => {
  it("maps extensions to language labels", () => {
    expect(languageFromKey("github:c:o/r:src/a.ts")).toBe("typescript");
    expect(languageFromKey("github:c:o/r:src/a.tsx")).toBe("typescript");
    expect(languageFromKey("github:c:o/r:src/a.py")).toBe("python");
    expect(languageFromKey("github:c:o/r:src/a.rb")).toBe("unknown");
  });
});

describe("buildFeaturePrompt", () => {
  it("includes the file, language, symbols, and a JSON-only instruction", () => {
    const p = buildFeaturePrompt("github:c:o/r:src/pay.ts", [
      { kind: "function", name: "charge", startLine: 1, endLine: 9 },
    ]);
    expect(p).toContain("github:c:o/r:src/pay.ts");
    expect(p).toContain("typescript");
    expect(p).toContain("function charge (lines 1–9)");
    expect(p).toContain("JSON object");
  });
});

describe("parseFeaturesFromText", () => {
  it("parses a plain JSON object", () => {
    const out = parseFeaturesFromText(
      '{"features":[{"name":"Login","description":"d","relatedSymbolNames":["a"],"confidence":0.9}]}',
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe("Login");
  });

  it("strips code fences and surrounding prose", () => {
    const out = parseFeaturesFromText(
      'Here you go:\n```json\n{"features":[{"name":"X","description":"d","relatedSymbolNames":[],"confidence":0.7}]}\n```',
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe("X");
  });

  it("returns [] for garbage or schema-invalid text", () => {
    expect(parseFeaturesFromText("not json at all")).toEqual([]);
    expect(parseFeaturesFromText('{"features":[{"name":123}]}')).toEqual([]);
    expect(parseFeaturesFromText("")).toEqual([]);
  });
});

describe("writeAcceptedFeatures", () => {
  const ctx = {
    orgId: "o",
    workspaceId: "w",
    connectionId: "c",
    fileNaturalKey: "github:acme/api:src/a.ts",
    authority: { method: "llm-feature-inference", model: "claude-haiku-4-5" },
  };

  it("filters below-threshold features and MERGEs the Feature node + SourceFile edge (no SourceSymbol edge)", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const session = { run };
    const features: InferredFeature[] = [
      {
        name: "Kept Feature",
        description: "d",
        relatedSymbolNames: ["sym1"],
        confidence: CONFIDENCE_THRESHOLD,
      },
      {
        name: "Dropped",
        description: "d",
        relatedSymbolNames: [],
        confidence: CONFIDENCE_THRESHOLD - 0.1,
      },
    ];

    const created = await writeAcceptedFeatures(session, ctx, features);
    expect(created).toBe(1);

    // Feature MERGE + :IMPLEMENTS→SourceFile = 2 runs. The Feature→SourceSymbol
    // edge is GONE (SourceSymbol nodes no longer exist), even though the feature
    // still names a related symbol.
    expect(run).toHaveBeenCalledTimes(2);
    for (const [cypher] of run.mock.calls) {
      expect(cypher).not.toContain("SourceSymbol");
    }
    const featureMerge = run.mock.calls[0]!;
    expect(featureMerge[0]).toContain("MERGE (feat:Feature");
    expect(featureMerge[1]).toMatchObject({
      name: "Kept Feature",
      naturalKey: "feature:w:kept-feature",
    });
  });

  it("stamps authority provenance on the Feature node and the IMPLEMENTS edge (spec finding 7)", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    await writeAcceptedFeatures({ run }, ctx, [
      {
        name: "Kept",
        description: "d",
        relatedSymbolNames: [],
        confidence: 0.9,
      },
    ]);

    const [featureCypher, featureParams] = run.mock.calls[0]! as [
      string,
      Record<string, unknown>,
    ];
    expect(featureCypher).toContain("feat.authority    = 'inferred'");
    expect(featureCypher).toContain("feat.method       = $method");
    expect(featureParams).toMatchObject({
      method: "llm-feature-inference",
      model: "claude-haiku-4-5",
    });

    const [edgeCypher, edgeParams] = run.mock.calls[1]! as [
      string,
      Record<string, unknown>,
    ];
    expect(edgeCypher).toContain("MERGE (feat)-[impl:IMPLEMENTS]->(f)");
    expect(edgeCypher).toContain("impl.authority  = 'inferred'");
    expect(edgeParams).toMatchObject({
      method: "llm-feature-inference",
      model: "claude-haiku-4-5",
      confidence: 0.9,
    });
  });

  it("writes nothing when all features are below threshold", async () => {
    const run = vi.fn();
    const created = await writeAcceptedFeatures({ run }, ctx, [
      { name: "Low", description: "d", relatedSymbolNames: [], confidence: 0 },
    ]);
    expect(created).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("connectionIdFromKey", () => {
  it("returns '' for a canonical (connectionId-less) key", async () => {
    const { connectionIdFromKey } = await import(
      "./ingestion.feature-inference"
    );
    expect(connectionIdFromKey("github:acme/api:src/a.ts")).toBe("");
  });

  it("still recovers the connectionId from a legacy prefixed key", async () => {
    const { connectionIdFromKey } = await import(
      "./ingestion.feature-inference"
    );
    expect(connectionIdFromKey("github:conn-123:acme/api:src/a.ts")).toBe(
      "conn-123",
    );
  });

  it("returns '' for a non-github key", async () => {
    const { connectionIdFromKey } = await import(
      "./ingestion.feature-inference"
    );
    expect(connectionIdFromKey("src/a.ts")).toBe("");
  });
});
