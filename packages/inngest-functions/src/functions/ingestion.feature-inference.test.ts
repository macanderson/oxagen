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
  const ctx = { orgId: "o", workspaceId: "w", connectionId: "c", fileNaturalKey: "github:c:o/r:src/a.ts" };

  it("filters below-threshold features and MERGEs nodes/edges for the rest", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const session = { run };
    const features: InferredFeature[] = [
      { name: "Kept Feature", description: "d", relatedSymbolNames: ["sym1"], confidence: CONFIDENCE_THRESHOLD },
      { name: "Dropped", description: "d", relatedSymbolNames: [], confidence: CONFIDENCE_THRESHOLD - 0.1 },
    ];

    const created = await writeAcceptedFeatures(session, ctx, features);
    expect(created).toBe(1);

    // Feature MERGE + :IMPLEMENTS→SourceFile + :IMPLEMENTS→SourceSymbol = 3 runs
    // for the single accepted feature (one related symbol).
    expect(run).toHaveBeenCalledTimes(3);
    const featureMerge = run.mock.calls[0]!;
    expect(featureMerge[0]).toContain("MERGE (feat:Feature");
    expect(featureMerge[1]).toMatchObject({ name: "Kept Feature", naturalKey: "feature:w:kept-feature" });
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
