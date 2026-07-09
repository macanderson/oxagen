import { describe, expect, it } from "vitest";
import { semanticEdgeInfer } from "./semantic.edge.infer";
import { getCapability } from "../registry";

describe("semantic.edge.infer capability", () => {
  // ── input: required fields ────────────────────────────────────────────────

  it("parses minimal input with only the required semanticEdgePrompt", () => {
    const parsed = semanticEdgeInfer.input.parse({
      semanticEdgePrompt: "Link entities that share the same industry.",
    });
    expect(parsed.semanticEdgePrompt).toBe(
      "Link entities that share the same industry.",
    );
  });

  it("rejects missing semanticEdgePrompt", () => {
    expect(() => semanticEdgeInfer.input.parse({})).toThrow();
  });

  it("rejects empty semanticEdgePrompt (min 1)", () => {
    expect(() =>
      semanticEdgeInfer.input.parse({ semanticEdgePrompt: "" }),
    ).toThrow();
  });

  it("rejects semanticEdgePrompt exceeding 4000 chars", () => {
    expect(() =>
      semanticEdgeInfer.input.parse({
        semanticEdgePrompt: "a".repeat(4001),
      }),
    ).toThrow();
  });

  it("accepts semanticEdgePrompt at exactly 4000 chars (max boundary)", () => {
    const prompt = "x".repeat(4000);
    const parsed = semanticEdgeInfer.input.parse({
      semanticEdgePrompt: prompt,
    });
    expect(parsed.semanticEdgePrompt).toBe(prompt);
  });

  // ── input: defaults ───────────────────────────────────────────────────────

  it("defaults maxEdgesPerNode to 10", () => {
    const parsed = semanticEdgeInfer.input.parse({
      semanticEdgePrompt: "Find related nodes.",
    });
    expect(parsed.maxEdgesPerNode).toBe(10);
  });

  it("defaults dryRun to false", () => {
    const parsed = semanticEdgeInfer.input.parse({
      semanticEdgePrompt: "Find related nodes.",
    });
    expect(parsed.dryRun).toBe(false);
  });

  it("defaults confidenceThreshold to 0.8", () => {
    const parsed = semanticEdgeInfer.input.parse({
      semanticEdgePrompt: "Find related nodes.",
    });
    expect(parsed.confidenceThreshold).toBe(0.8);
  });

  // ── input: maxEdgesPerNode bounds ─────────────────────────────────────────

  it("accepts maxEdgesPerNode=1 (min)", () => {
    const parsed = semanticEdgeInfer.input.parse({
      semanticEdgePrompt: "Find related nodes.",
      maxEdgesPerNode: 1,
    });
    expect(parsed.maxEdgesPerNode).toBe(1);
  });

  it("accepts maxEdgesPerNode=50 (max)", () => {
    const parsed = semanticEdgeInfer.input.parse({
      semanticEdgePrompt: "Find related nodes.",
      maxEdgesPerNode: 50,
    });
    expect(parsed.maxEdgesPerNode).toBe(50);
  });

  it("rejects maxEdgesPerNode=0 (below min)", () => {
    expect(() =>
      semanticEdgeInfer.input.parse({
        semanticEdgePrompt: "Find related nodes.",
        maxEdgesPerNode: 0,
      }),
    ).toThrow();
  });

  it("rejects maxEdgesPerNode=51 (above max)", () => {
    expect(() =>
      semanticEdgeInfer.input.parse({
        semanticEdgePrompt: "Find related nodes.",
        maxEdgesPerNode: 51,
      }),
    ).toThrow();
  });

  it("rejects non-integer maxEdgesPerNode", () => {
    expect(() =>
      semanticEdgeInfer.input.parse({
        semanticEdgePrompt: "Find related nodes.",
        maxEdgesPerNode: 2.5,
      }),
    ).toThrow();
  });

  // ── input: confidenceThreshold bounds ────────────────────────────────────

  it("accepts confidenceThreshold=0 (min boundary)", () => {
    const parsed = semanticEdgeInfer.input.parse({
      semanticEdgePrompt: "Find related nodes.",
      confidenceThreshold: 0,
    });
    expect(parsed.confidenceThreshold).toBe(0);
  });

  it("accepts confidenceThreshold=1 (max boundary)", () => {
    const parsed = semanticEdgeInfer.input.parse({
      semanticEdgePrompt: "Find related nodes.",
      confidenceThreshold: 1,
    });
    expect(parsed.confidenceThreshold).toBe(1);
  });

  it("rejects confidenceThreshold below 0", () => {
    expect(() =>
      semanticEdgeInfer.input.parse({
        semanticEdgePrompt: "Find related nodes.",
        confidenceThreshold: -0.1,
      }),
    ).toThrow();
  });

  it("rejects confidenceThreshold above 1", () => {
    expect(() =>
      semanticEdgeInfer.input.parse({
        semanticEdgePrompt: "Find related nodes.",
        confidenceThreshold: 1.1,
      }),
    ).toThrow();
  });

  // ── input: optional fields ────────────────────────────────────────────────

  it("accepts sourceIds array", () => {
    const parsed = semanticEdgeInfer.input.parse({
      semanticEdgePrompt: "Find related nodes.",
      sourceIds: ["src-1", "src-2"],
    });
    expect(parsed.sourceIds).toEqual(["src-1", "src-2"]);
  });

  it("omitted sourceIds is undefined", () => {
    const parsed = semanticEdgeInfer.input.parse({
      semanticEdgePrompt: "Find related nodes.",
    });
    expect(parsed.sourceIds).toBeUndefined();
  });

  it("accepts dryRun=true", () => {
    const parsed = semanticEdgeInfer.input.parse({
      semanticEdgePrompt: "Find related nodes.",
      dryRun: true,
    });
    expect(parsed.dryRun).toBe(true);
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses a valid queued output", () => {
    const parsed = semanticEdgeInfer.output.parse({
      jobId: "job-001",
      status: "queued",
      estimatedNodes: 420,
      dryRun: false,
    });
    expect(parsed.jobId).toBe("job-001");
    expect(parsed.status).toBe("queued");
    expect(parsed.estimatedNodes).toBe(420);
    expect(parsed.dryRun).toBe(false);
  });

  it("parses dryRun=true reflected in output", () => {
    const parsed = semanticEdgeInfer.output.parse({
      jobId: "job-002",
      status: "queued",
      estimatedNodes: 0,
      dryRun: true,
    });
    expect(parsed.dryRun).toBe(true);
  });

  it("rejects output with status other than 'queued'", () => {
    expect(() =>
      semanticEdgeInfer.output.parse({
        jobId: "job-001",
        status: "running",
        estimatedNodes: 10,
        dryRun: false,
      }),
    ).toThrow();
  });

  it("rejects output missing jobId", () => {
    expect(() =>
      semanticEdgeInfer.output.parse({
        status: "queued",
        estimatedNodes: 10,
        dryRun: false,
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("infer_semantic_edges")).toBe(semanticEdgeInfer);
  });
});
