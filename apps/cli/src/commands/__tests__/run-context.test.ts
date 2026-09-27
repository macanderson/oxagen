/**
 * `oxagen run context` output discipline: --json emits the exact contract
 * payload, pretty mode prints one row per window with each block's share of
 * the prompt tokens, a block the recorder could not tell apart is a dash,
 * and an API failure goes to stderr. The shared API client is mocked.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { CommandWriter } from "../../lib/capture-writer.js";

vi.mock("../../lib/api.js", () => ({ apiPostOrThrow: vi.fn() }));

import { runContext } from "../run-context.js";
import { apiPostOrThrow } from "../../lib/api.js";

function memoryWriter() {
  const out: string[] = [];
  const err: string[] = [];
  const writer: CommandWriter = {
    write: (line) => {
      out.push(line);
    },
    writeErr: (line) => {
      err.push(line);
    },
  };
  return { writer, out, err };
}

const post = apiPostOrThrow as Mock;

const CONTEXT = {
  runId: "tse_0a1b2c",
  source: "wrapped",
  windows: [
    {
      seq: "12",
      responseSeq: "12",
      modelCallId: "req_12",
      provider: "anthropic",
      model: "claude-opus-5",
      promptTokens: 42_000,
      bytes: 20_000,
      blocks: [
        { kind: "system", bytes: 2000, items: 1, tokens: 4200 },
        { kind: "tools", bytes: 6000, items: 18, tokens: 12_600 },
        { kind: "conversation", bytes: 12_000, items: 40, tokens: 25_200 },
      ],
    },
    {
      seq: "30",
      responseSeq: "30",
      modelCallId: null,
      provider: "anthropic",
      model: null,
      promptTokens: null,
      bytes: 100,
      blocks: [{ kind: "system", bytes: 100, items: 1, tokens: null }],
    },
  ],
  unmeasured: 1,
  assemblies: [
    {
      seq: "0",
      budgetTokens: 2000,
      spentTokens: 1102,
      included: 14,
      cut: 24,
      textDigest: null,
    },
  ],
  complete: true,
};

describe("oxagen run context", () => {
  beforeEach(() => {
    post.mockReset();
  });

  it("posts the run id to runs/context and emits the exact payload as JSON", async () => {
    post.mockResolvedValue(CONTEXT);
    const { writer, out, err } = memoryWriter();
    await runContext("tse_0a1b2c", { json: true }, writer);
    expect(post).toHaveBeenCalledWith("runs/context", { runId: "tse_0a1b2c" });
    expect(JSON.parse(out[0] ?? "null")).toEqual(CONTEXT);
    expect(err).toEqual([]);
  });

  it("prints one row per window with each block's share of the prompt tokens", async () => {
    post.mockResolvedValue(CONTEXT);
    const { writer, out } = memoryWriter();
    await runContext("tse_0a1b2c", {}, writer);
    expect(out[0]).toBe(
      "tse_0a1b2c: 2 window(s) recorded, 1 model call(s) without one",
    );
    expect(out[1]).toBe(
      "Steering: 1,102 of 2,000 tokens spent, 14 included, 24 cut (frame 0)",
    );
    expect((out[3] ?? "").split(/\s{2,}/)).toEqual([
      "Frame",
      "Model",
      "Prompt tokens",
      "System",
      "Steering",
      "Tools",
      "Context",
      "Conversation",
    ]);
    expect((out[4] ?? "").split(/\s{2,}/)).toEqual([
      "12",
      "claude-opus-5",
      "42,000",
      "4,200",
      "-",
      "12,600",
      "-",
      "25,200",
    ]);
  });

  it("says what was not recorded rather than printing a zero (negative)", async () => {
    post.mockResolvedValue(CONTEXT);
    const { writer, out } = memoryWriter();
    await runContext("tse_0a1b2c", {}, writer);
    const second = (out[5] ?? "").trim().split(/\s{2,}/);
    expect(second.slice(0, 4)).toEqual([
      "30",
      "not recorded",
      "not recorded",
      "not recorded",
    ]);
  });

  it("says a run with no window recorded none, and a cut list is cut", async () => {
    post.mockResolvedValueOnce({
      ...CONTEXT,
      windows: [],
      assemblies: [],
      unmeasured: 3,
    });
    const empty = memoryWriter();
    await runContext("tse_0a1b2c", {}, empty.writer);
    expect(empty.out).toEqual([
      "tse_0a1b2c: 0 window(s) recorded, 3 model call(s) without one",
      "The run recorded no window. A window is recorded when the model call passes through the Oxagen gateway.",
    ]);
    post.mockResolvedValueOnce({ ...CONTEXT, complete: false });
    const cut = memoryWriter();
    await runContext("tse_0a1b2c", {}, cut.writer);
    expect(cut.out.at(-1)).toBe(
      "The run is longer than one read carries. These are its first 2 windows.",
    );
  });

  it("routes an API failure to stderr and writes nothing to stdout (negative)", async () => {
    post.mockRejectedValue(new Error("404 not_found: run_not_found"));
    const { writer, out, err } = memoryWriter();
    await runContext("tse_nope", {}, writer);
    expect(out).toEqual([]);
    expect(err.join("\n")).toMatch(/run_not_found/);
  });
});
