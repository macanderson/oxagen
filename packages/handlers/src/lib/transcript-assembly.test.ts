// transcript-assembly.test.ts — the read side of the ingest-time fold: which
// assembly a transcript half carries, and whose clock is on it (#3526).
import { describe, expect, it, vi } from "vitest";
import {
  assembleModelStream,
  encodeAssembly,
  NO_BODY,
  type MessageAssembly,
  type RunFrame,
} from "@oxagen/run-ledger";
import { readAssembly } from "./transcript-assembly";

const SCOPE = { orgId: "org", workspaceId: "ws" };

/** The reference two calls with identical retained bytes both land on. */
const SHARED_REF = `evb:v1:ingestion:env:v1:${"a".repeat(64)}`;

/** One short recorded stream; the bytes are the same for both calls. */
const STREAM = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":1}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join("");

function frame(timing: {
  ttftMs: number | null;
  durationMs: number | null;
}): RunFrame {
  return {
    seq: "1",
    type: "llm_call",
    stage: "model",
    observedAt: new Date("2026-09-14T12:00:00.000Z"),
    digest: "sha256:" + "b".repeat(64),
    summary: "model call",
    body: NO_BODY,
    costMicros: null,
    turnIndex: null,
    phase: "response",
    identity: {
      tool: null,
      toolStatus: null,
      model: "claude-sonnet-5",
      policy: null,
      verdict: null,
      contextRows: null,
      callId: null,
    },
    timing,
  };
}

/** A store holding one assembly under `SHARED_REF`, as the fold wrote it. */
function storeHolding(assembly: MessageAssembly) {
  return {
    getAssembly: vi.fn(async () => encodeAssembly(assembly)),
  };
}

describe("readAssembly", () => {
  it("gives two calls that share one stored assembly their own timing", async () => {
    // The stored object is keyed by the body's digest, so two calls whose
    // retained response bytes are identical share it. The content is the same
    // for both by definition; their clocks are not, and before this the later
    // write's figures were read back on the earlier run.
    const store = storeHolding(assembleModelStream(STREAM) as MessageAssembly);

    const first = await readAssembly(
      store,
      SCOPE,
      SHARED_REF,
      STREAM,
      frame({ ttftMs: 120, durationMs: 1_400 }),
    );
    const second = await readAssembly(
      store,
      SCOPE,
      SHARED_REF,
      STREAM,
      frame({ ttftMs: 45, durationMs: 300 }),
    );

    expect(first?.ttftMs).toBe(120);
    expect(first?.durationMs).toBe(1_400);
    expect(second?.ttftMs).toBe(45);
    expect(second?.durationMs).toBe(300);
    // The content came from the shared object, not from a second fold.
    expect(first?.blocks).toEqual(second?.blocks);
    expect(first?.stopReason).toBe("end_turn");
  });

  it("overlays the frame's timing on an object an older fold baked timing into", async () => {
    // Objects written before the fold stopped storing timing still carry
    // another call's figures. The frame's own columns win over them, so no
    // reprocessing is needed to stop showing one call's rate on another.
    const stale = {
      ...(assembleModelStream(STREAM) as MessageAssembly),
      ttftMs: 9_999,
      durationMs: 9_999,
    };

    const read = await readAssembly(
      storeHolding(stale),
      SCOPE,
      SHARED_REF,
      STREAM,
      frame({ ttftMs: 60, durationMs: 700 }),
    );

    expect(read?.ttftMs).toBe(60);
    expect(read?.durationMs).toBe(700);
  });

  it("carries a frame that timed nothing as untimed rather than borrowing", async () => {
    const stale = {
      ...(assembleModelStream(STREAM) as MessageAssembly),
      ttftMs: 9_999,
      durationMs: 9_999,
    };

    const read = await readAssembly(
      storeHolding(stale),
      SCOPE,
      SHARED_REF,
      STREAM,
      frame({ ttftMs: null, durationMs: null }),
    );

    expect(read?.ttftMs).toBeNull();
    expect(read?.durationMs).toBeNull();
  });

  it("folds the wire with this frame's timing when nothing is stored", async () => {
    const read = await readAssembly(
      { getAssembly: vi.fn(async () => null) },
      SCOPE,
      SHARED_REF,
      STREAM,
      frame({ ttftMs: 88, durationMs: 900 }),
    );

    expect(read?.ttftMs).toBe(88);
    expect(read?.durationMs).toBe(900);
    expect(read?.stopReason).toBe("end_turn");
  });
});
