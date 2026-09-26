import { describe, expect, it } from "vitest";
import {
  FRAME_LIMIT_DEFAULT,
  FRAME_LIMIT_MAX,
  runFrameSchema,
  runGet,
  WAIT_MS_MAX,
} from "./run.get";

const LEDGER_ID = "arun_5f0c2e9a1b7d4c3e8f6a02";

describe("get_run contract", () => {
  it("is a console read an SSE poll may make: mutates false, noBillingGate true", () => {
    expect(runGet.mutates).toBe(false);
    expect(runGet.noBillingGate).toBe(true);
    expect(runGet.scoped).toBe(true);
    expect(runGet.defaultEffect).toBe("deny");
    expect(runGet.layers).not.toContain("e2e");
  });

  it("is a low-risk read the in-app agent may call without approval", () => {
    expect(runGet.surfaces).toEqual(["api", "mcp", "agent"]);
    expect(runGet.agent).toEqual({
      requiresApproval: false,
      riskLevel: "low",
      category: "run",
    });
  });

  it("defaults the frame page and the wait, and bounds both", () => {
    expect(runGet.input.parse({ runId: LEDGER_ID })).toEqual({
      runId: LEDGER_ID,
      frameLimit: FRAME_LIMIT_DEFAULT,
      waitMs: 0,
    });
    expect(
      runGet.input.safeParse({ runId: LEDGER_ID, frameLimit: 0 }).success,
    ).toBe(false);
    expect(
      runGet.input.safeParse({
        runId: LEDGER_ID,
        frameLimit: FRAME_LIMIT_MAX + 1,
      }).success,
    ).toBe(false);
    expect(
      runGet.input.safeParse({ runId: LEDGER_ID, waitMs: WAIT_MS_MAX + 1 })
        .success,
    ).toBe(false);
    expect(
      runGet.input.safeParse({ runId: LEDGER_ID, waitMs: -1 }).success,
    ).toBe(false);
  });

  it("refuses an id neither store mints (negative)", () => {
    expect(runGet.input.safeParse({ runId: "aex_123" }).success).toBe(false);
    expect(runGet.input.safeParse({ runId: "arun_ABC" }).success).toBe(false);
  });

  it("answers frames as a page or null, never a bare array", () => {
    const run = {
      id: LEDGER_ID,
      source: "ledger",
      agentKey: null,
      operatorId: "prn_0123456789abcdefghjkmn",
      // Nullable and required alike: the row carries the key even when the
      // record holds nothing under it, so a reader can tell "not recorded"
      // from a field the shape never had.
      operatorKind: "human",
      operatorName: "Marcus Bell",
      operatorAvatarUrl: "https://avatars.example.com/marcus.png",
      operatorAttribution: "initiator",
      status: "live",
      outcome: "running",
      turns: null,
      steps: 0,
      frames: 0,
      cost: null,
      model: null,
      machine: null,
      taskRef: "fix the flaky test",
      startedAt: "2026-09-08T10:06:03.000Z",
      sealedAt: null,
      endedAt: null,
      replayGrade: null,
      verdict: null,
      enforcementTier: "harness",
      completenessGaps: [],
      canSummarize: false,
      name: null,
      summary: null,
    };
    expect(
      runGet.output.safeParse({
        run,
        frames: { frames: [], cursor: null },
        witnessFor: null,
      }).success,
    ).toBe(true);
    // A witness run names the worker run it reported on (ADR-064).
    expect(
      runGet.output.safeParse({
        run,
        frames: { frames: [], cursor: null },
        witnessFor: "tse_4q8r1t6v3x5z0b2d7h2k9m",
      }).success,
    ).toBe(true);
    expect(
      runGet.output.safeParse({
        run,
        frames: { frames: [], cursor: null },
        witnessFor: "wit_01K5RQ8M4",
      }).success,
    ).toBe(false);
    expect(runGet.output.safeParse({ run, frames: null }).success).toBe(false);
    expect(runGet.output.safeParse({ run, frames: [] }).success).toBe(false);
  });

  it("carries every frame's body reference and never its bytes", () => {
    const frame = {
      cursor: "ZjoxMg",
      seq: "12",
      type: "tool.call_completed",
      stage: "tool",
      observedAt: "2026-09-08T10:06:04.000Z",
      digest: `sha256:${"0".repeat(64)}`,
      summary: "read_file completed",
      tool: "read_file",
      toolStatus: "completed",
      approvalId: null,
      body: {
        digest: `sha256:${"a".repeat(64)}`,
        bytesRef: "evb:v1:evidence:v1:" + "a".repeat(64),
        redactions: [
          {
            path: "bytes:4-40",
            reason: "github_token",
            originalDigest: `sha256:${"b".repeat(64)}`,
          },
        ],
        fidelity: "full",
      },
      cost: null,
    };
    expect(runFrameSchema.safeParse(frame).success).toBe(true);
    expect(
      runFrameSchema.safeParse({
        ...frame,
        toolStatus: "parked",
        approvalId: "apr_01k5rq8m4",
      }).success,
    ).toBe(true);
    expect(
      runFrameSchema.safeParse({
        ...frame,
        body: { ...frame.body, bytesRef: null, fidelity: "digest_only" },
      }).success,
    ).toBe(true);
    expect(
      runFrameSchema.safeParse({
        ...frame,
        body: { ...frame.body, bytes: "eyJ9" },
      }).success,
    ).toBe(false);
    expect(
      runFrameSchema.safeParse({
        ...frame,
        body: {
          ...frame.body,
          redactions: [{ path: "bytes:0-1", reason: "" }],
        },
      }).success,
    ).toBe(false);
    const { body: _dropped, ...withoutBody } = frame;
    expect(runFrameSchema.safeParse(withoutBody).success).toBe(false);
  });

  it("parses a frame recorded before it named its tool, reading each tool field as null", () => {
    // tool, toolStatus and approvalId arrived with #4307. An output recorded
    // before then carries none of them and must still parse.
    const recorded = {
      cursor: "ZjoxMg",
      seq: "12",
      type: "tool.call_completed",
      stage: "tool",
      observedAt: "2026-09-08T10:06:04.000Z",
      digest: `sha256:${"0".repeat(64)}`,
      summary: "read_file completed",
      body: {
        digest: null,
        bytesRef: null,
        redactions: [],
        fidelity: "digest_only",
      },
      cost: null,
    };
    const parsed = runFrameSchema.safeParse(recorded);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({
      tool: null,
      toolStatus: null,
      approvalId: null,
    });
  });
});
