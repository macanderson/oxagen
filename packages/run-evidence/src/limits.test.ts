import { describe, expect, it } from "vitest";
import {
  MAX_APPROVALS,
  MAX_ARTIFACTS,
  MAX_CHANGES,
  MAX_COMMITS,
  MAX_CONTEXT_FRAMES,
  MAX_ENVELOPE_JCS_BYTES,
  MAX_MODEL_CALLS,
  MAX_ORDINARY_STRING_UTF8_BYTES,
  MAX_PULL_REQUESTS,
  MAX_TERMINAL_SUMMARY_UTF8_BYTES,
  MAX_TOOL_CALLS,
  MAX_VERIFICATIONS,
  RUN_STAGE_COUNT,
} from "./limits";

describe("run-evidence limits", () => {
  it("pins every collection and envelope limit", () => {
    expect({
      envelopeJcsBytes: MAX_ENVELOPE_JCS_BYTES,
      contextFrames: MAX_CONTEXT_FRAMES,
      modelCalls: MAX_MODEL_CALLS,
      changes: MAX_CHANGES,
      toolCalls: MAX_TOOL_CALLS,
      approvals: MAX_APPROVALS,
      verifications: MAX_VERIFICATIONS,
      commits: MAX_COMMITS,
      pullRequests: MAX_PULL_REQUESTS,
      artifacts: MAX_ARTIFACTS,
    }).toEqual({
      envelopeJcsBytes: 1_048_576,
      contextFrames: 256,
      modelCalls: 512,
      changes: 5_000,
      toolCalls: 2_000,
      approvals: 256,
      verifications: 512,
      commits: 1_000,
      pullRequests: 64,
      artifacts: 1_000,
    });
  });

  it("pins UTF-8 string limits and stage count", () => {
    expect({
      ordinaryStringUtf8Bytes: MAX_ORDINARY_STRING_UTF8_BYTES,
      terminalSummaryUtf8Bytes: MAX_TERMINAL_SUMMARY_UTF8_BYTES,
      stageCount: RUN_STAGE_COUNT,
    }).toEqual({
      ordinaryStringUtf8Bytes: 4_096,
      terminalSummaryUtf8Bytes: 16_384,
      stageCount: 9,
    });
  });

  it("exports the contract core from the package barrel", async () => {
    const core = await import("./index");

    expect(core.MAX_ENVELOPE_JCS_BYTES).toBe(MAX_ENVELOPE_JCS_BYTES);
    expect(core.normalizeContextFrameV1).toBeTypeOf("function");
    expect(core.digestJcs).toBeTypeOf("function");
  });

  it("does not expose raw Context Graph Zod schemas from the runtime barrel", async () => {
    const core = await import("./index");
    const rawSchemaNames = [
      "contextFrameKindV1Schema",
      "contextProvenanceV1Schema",
      "contextFrameEmbeddingV1Schema",
      "contextRelationV1Schema",
      "contextFrameV1Schema",
      "contextQueryV1Schema",
    ];

    for (const name of rawSchemaNames) {
      expect(core).not.toHaveProperty(name);
    }
  });
});
