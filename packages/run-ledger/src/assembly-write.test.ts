import { describe, expect, it, vi } from "vitest";
import { writeAssembly } from "./assembly-write";
import { decodeAssembly } from "./content-blocks";

const REF = "evb:v1:ingestion:env:v1:" + "a".repeat(64);

const STREAM = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":1}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join("");

function scope() {
  return { orgId: "org", workspaceId: "ws", runId: "run", bodyRef: REF };
}

describe("writeAssembly", () => {
  it("folds a recorded stream once and stores it beside the wire", async () => {
    const putAssembly = vi.fn(async () => {});

    const outcome = await writeAssembly(
      { putAssembly },
      { ...scope(), bytes: Buffer.from(STREAM, "utf8"), timing: { ttftMs: 88, durationMs: 900 } },
    );

    expect(outcome).toBe("stored");
    expect(putAssembly).toHaveBeenCalledTimes(1);
    const written = (putAssembly.mock.calls as unknown as Array<
      [{ bodyRef: string; bytes: Uint8Array }]
    >)[0]?.[0] as { bodyRef: string; bytes: Uint8Array };
    expect(written.bodyRef).toBe(REF);
    const assembly = decodeAssembly(written.bytes);
    expect(assembly?.blocks).toHaveLength(1);
    expect(assembly?.stopReason).toBe("end_turn");
    expect(assembly?.ttftMs).toBe(88);
    expect(assembly?.durationMs).toBe(900);
    expect(assembly?.usage.outputTokens).toBe(9);
  });

  it("leaves a body that is not a model stream alone", async () => {
    const putAssembly = vi.fn(async () => {});

    const outcome = await writeAssembly(
      { putAssembly },
      { ...scope(), bytes: Buffer.from("please fix the bug", "utf8") },
    );

    expect(outcome).toBe("not_a_stream");
    expect(putAssembly).not.toHaveBeenCalled();
  });

  it("leaves bytes that are not text alone", async () => {
    const putAssembly = vi.fn(async () => {});

    const outcome = await writeAssembly(
      { putAssembly },
      { ...scope(), bytes: Uint8Array.from([0xff, 0xfe, 0xfd]) },
    );

    expect(outcome).toBe("not_text");
    expect(putAssembly).not.toHaveBeenCalled();
  });

  it("reports a store with no assembly seam rather than refusing the frame", async () => {
    expect(
      await writeAssembly({}, { ...scope(), bytes: Buffer.from(STREAM, "utf8") }),
    ).toBe("no_store");
  });

  it("reports a failed write rather than throwing into the append", async () => {
    const putAssembly = vi.fn(async () => {
      throw new Error("bucket is gone");
    });

    await expect(
      writeAssembly({ putAssembly }, { ...scope(), bytes: Buffer.from(STREAM, "utf8") }),
    ).resolves.toBe("failed");
  });

  it("never touches the recorded bytes", async () => {
    const bytes = Buffer.from(STREAM, "utf8");
    const before = Buffer.from(bytes).toString("base64");

    await writeAssembly({ putAssembly: async () => {} }, { ...scope(), bytes });

    expect(Buffer.from(bytes).toString("base64")).toBe(before);
  });
});
