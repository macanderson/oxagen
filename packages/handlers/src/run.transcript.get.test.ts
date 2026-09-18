import { isHandlerError } from "@oxagen/oxagen/handler-error";
import {
  runTranscriptGet,
  TRANSCRIPT_TEXT_MAX,
} from "@oxagen/oxagen/contracts/run.transcript.get";
import { digestBytes } from "@oxagen/tacho";
import type { TachoFrameRow } from "@oxagen/telemetry";
import { describe, expect, it, vi } from "vitest";
import {
  createRunTranscriptGetHandler,
  decodeTranscriptCursor,
  elapsedMs,
  encodeTranscriptCursor,
  type RunTranscriptGetDeps,
} from "./run.transcript.get";
import {
  ctx,
  memoryEvents,
  memoryStores,
  memoryTachoFrames,
  tachoRow,
  tachoSession,
} from "./run.test-support";

const TACHO_ID = "tse_4q8r1t6v3x5z0b2d7h2k9m";
const SESSION_UUID = "0192d4a8-7c1e-7a00-8000-00000000c0de";

const enc = new TextEncoder();
const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
function stored(text: string | Uint8Array, contentType = "text/plain") {
  const bytes = typeof text === "string" ? enc.encode(text) : text;
  const digest = digestBytes(bytes);
  const ref = `evb:v1:k:${digest.slice(7)}`;
  objects.set(ref, { bytes, contentType });
  return { contentDigest: digest, bytesRef: ref };
}

/** The input defaults the contract fills in, so a test names only what it varies. */
const input = (over: Record<string, unknown>) =>
  runTranscriptGet.input.parse({ runId: TACHO_ID, ...over });

function harness(rows: TachoFrameRow[]) {
  const stores = memoryStores([], [tachoSession({ publicId: TACHO_ID })]);
  const getBody = vi.fn((_scope: unknown, ref: string) => {
    const object = objects.get(ref);
    if (!object) return Promise.reject(new Error(`no object for ${ref}`));
    return Promise.resolve({ ...object, digestHex: ref.slice(-64) });
  });
  const deps: RunTranscriptGetDeps = {
    queries: stores.queries,
    store: {
      getRunByPublicId: () => Promise.resolve(null),
      readAttemptEventsSince: memoryEvents([]),
    },
    readRunRollups: stores.readRunRollups,
    readWitnessFor: stores.readWitnessFor,
    tachoFrames: memoryTachoFrames(SESSION_UUID, rows),
    bodies: { getBody },
  };
  return { transcript: createRunTranscriptGetHandler(deps), getBody };
}

const rows = [
  tachoRow(0, { kind: "agent_start", toolName: "", toolStatus: "" }),
  tachoRow(1, { kind: "turn_start", toolName: "", toolStatus: "", turnSeq: 1 }),
  tachoRow(2, {
    kind: "llm_call",
    toolName: "",
    toolStatus: "",
    model: "haiku",
    provider: "anthropic",
    costUsdMicros: 40,
    turnSeq: 1,
    ...stored("What is in README?"),
  }),
  tachoRow(3, {
    turnSeq: 1,
    ...stored('{"path":"README.md"}', "application/json"),
  }),
  tachoRow(4, {
    kind: "turn_start",
    toolName: "",
    toolStatus: "",
    turnSeq: 2,
  }),
  tachoRow(5, {
    kind: "llm_call",
    toolName: "",
    toolStatus: "",
    model: "haiku",
    provider: "anthropic",
    costUsdMicros: 60,
    turnSeq: 2,
    contentDigest: `sha256:${"9".repeat(64)}`,
  }),
  tachoRow(6, { kind: "agent_stop", toolName: "", toolStatus: "" }),
];

describe("get_run_transcript", () => {
  it("everything: one entry per frame, the body on the half that carried it", async () => {
    const { transcript } = harness(rows);
    const out = await transcript(input({ zoom: "everything" }), ctx());
    expect(runTranscriptGet.output.parse(out)).toEqual(out);
    expect(out.complete).toBe(true);
    expect(out.cursor).toBeNull();
    expect(
      out.entries.map((e) => [
        e.seq,
        e.kind,
        e.response?.text ?? null,
        e.response?.fidelity ?? null,
      ]),
    ).toEqual([
      ["0", "frame", null, "digest_only"],
      ["1", "frame", null, "digest_only"],
      ["2", "model_call", "What is in README?", "full"],
      ["3", "tool_call", '{"path":"README.md"}', "full"],
      ["4", "frame", null, "digest_only"],
      ["5", "model_call", null, "digest_only"],
      ["6", "frame", null, "digest_only"],
    ]);
    // A single terminal receipt has no request half to show.
    expect(out.entries.every((e) => e.request === null)).toBe(true);
    expect(out.entries[2]?.cost).toEqual({
      micros: "40",
      currency: "USD",
      basis: "client_attested",
    });
  });

  it("cumulative cost is a prefix sum over the run, not over the entry", async () => {
    const { transcript } = harness(rows);
    const out = await transcript(input({ zoom: "everything" }), ctx());
    expect(
      out.entries.map((e) => [
        e.seq,
        e.cost?.micros ?? null,
        e.cumulativeCost?.micros ?? null,
      ]),
    ).toEqual([
      ["0", null, null],
      ["1", null, null],
      ["2", "40", "40"],
      ["3", null, "40"],
      ["4", null, "40"],
      ["5", "60", "100"],
      ["6", null, "100"],
    ]);
  });

  it("elapsed is measured from the run's start and never reads negative", async () => {
    const { transcript } = harness(rows);
    const out = await transcript(input({ zoom: "everything" }), ctx());
    const first = out.entries[0]?.elapsedMs ?? -1;
    const last = out.entries.at(-1)?.elapsedMs ?? -1;
    expect(first).toBeGreaterThanOrEqual(0);
    expect(last).toBeGreaterThan(first);
    // A frame observed before the run's recorded start reports 0, not a
    // negative duration.
    expect(elapsedMs(Date.parse("2026-09-11T10:00:00Z"), new Date(0))).toBe(0);
  });

  it("steps: a tool call is ONE entry carrying what went in and what came back", async () => {
    // The two halves a wrapped session writes: `tool_requested` then
    // `tool_call`. Before the fold paired them this was two entries, each with
    // half the exchange.
    const { transcript } = harness([
      tachoRow(0, {
        kind: "tool_requested",
        toolStatus: "",
        ...stored('{"path":"README.md"}', "application/json"),
      }),
      tachoRow(1, { kind: "tool_call", ...stored("# Oxagen") }),
    ]);
    const out = await transcript(input({ zoom: "steps" }), ctx());
    expect(out.entries).toHaveLength(1);
    const entry = out.entries[0];
    expect(entry?.kind).toBe("tool_call");
    expect(entry?.frames).toBe(2);
    expect(entry?.request).toMatchObject({
      seq: "0",
      type: "tool_requested",
      text: '{"path":"README.md"}',
      fidelity: "full",
    });
    expect(entry?.response).toMatchObject({
      seq: "1",
      type: "tool_call",
      text: "# Oxagen",
      fidelity: "full",
    });
  });

  it("steps: a second response of the same kind opens a new step, it does not join the first", async () => {
    const { transcript } = harness([
      tachoRow(0, { kind: "tool_requested", toolStatus: "" }),
      tachoRow(1, { kind: "tool_call" }),
      tachoRow(2, { kind: "tool_call" }),
    ]);
    const out = await transcript(input({ zoom: "steps" }), ctx());
    expect(out.entries.map((e) => [e.seq, e.endSeq, e.frames])).toEqual([
      ["0", "1", 2],
      ["2", "2", 1],
    ]);
  });

  it("steps: model and tool calls, folding the frames between and summing their cost", async () => {
    const { transcript } = harness(rows);
    const out = await transcript(input({ zoom: "steps" }), ctx());
    expect(out.entries.map((e) => [e.seq, e.endSeq, e.kind, e.frames])).toEqual([
      ["0", "1", "frame", 2],
      ["2", "2", "model_call", 1],
      ["3", "4", "tool_call", 2],
      ["5", "6", "model_call", 2],
    ]);
  });

  it("turns: one entry per turn with the turn's cost", async () => {
    const { transcript } = harness(rows);
    const out = await transcript(input({ zoom: "turns" }), ctx());
    expect(
      out.entries.map((e) => [
        e.seq,
        e.endSeq,
        e.frames,
        e.cost?.micros ?? null,
      ]),
    ).toEqual([
      ["0", "0", 1, null],
      ["1", "3", 3, "40"],
      ["4", "6", 3, "60"],
    ]);
  });

  it("folds a policy decision into the step it was made about, and names it", async () => {
    const { transcript } = harness([
      tachoRow(0, { kind: "tool_requested", toolStatus: "" }),
      tachoRow(1, {
        kind: "policy_decision",
        toolName: "",
        toolStatus: "",
        policyDecision: "route",
      }),
      tachoRow(2, { kind: "tool_call" }),
    ]);
    const out = await transcript(input({ zoom: "steps" }), ctx());
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]?.decision).toMatchObject({
      seq: "1",
      decision: "route",
      type: "policy_decision",
    });
    expect(out.entries[0]?.kinds).toContain("policy");
  });

  it("filters frames by the chips pressed before folding, and echoes the selection", async () => {
    const { transcript } = harness(rows);
    const out = await transcript(
      input({ zoom: "everything", kinds: ["tools"] }),
      ctx(),
    );
    expect(out.kinds).toEqual(["tools"]);
    expect(out.entries.map((e) => e.seq)).toEqual(["3"]);
    // An empty selection is not every chip off: it keeps every frame.
    const all = await transcript(
      input({ zoom: "everything", kinds: [] }),
      ctx(),
    );
    expect(all.entries).toHaveLength(rows.length);
  });

  it("pages on a cursor it owns and refuses one it did not write (negative)", async () => {
    const { transcript } = harness(rows);
    const first = await transcript(
      input({ zoom: "everything", limit: 3 }),
      ctx(),
    );
    expect(first.entries.map((e) => e.seq)).toEqual(["0", "1", "2"]);
    expect(first.cursor).not.toBeNull();
    const second = await transcript(
      input({ zoom: "everything", limit: 3, after: first.cursor as string }),
      ctx(),
    );
    expect(second.entries.map((e) => e.seq)).toEqual(["3", "4", "5"]);
    // The prefix sum keeps counting from the run's start across the page break.
    expect(second.entries.at(-1)?.cumulativeCost?.micros).toBe("100");
    const last = await transcript(
      input({ zoom: "everything", limit: 3, after: second.cursor as string }),
      ctx(),
    );
    expect(last.entries.map((e) => e.seq)).toEqual(["6"]);
    expect(last.cursor).toBeNull();

    await expect(
      transcript(input({ zoom: "everything", after: "not-ours" }), ctx()),
    ).rejects.toThrow();
    expect(decodeTranscriptCursor("not-a-cursor")).toBeNull();
    expect(decodeTranscriptCursor(encodeTranscriptCursor("42"))).toBe("42");
  });

  it("a digest_only recording answers every half with text null and says so", async () => {
    const { transcript, getBody } = harness(
      rows.map((r) => ({ ...r, bytesRef: "" })),
    );
    const out = await transcript(input({ zoom: "everything" }), ctx());
    expect(out.entries.every((e) => e.response?.text === null)).toBe(true);
    expect(out.entries.every((e) => e.response?.fidelity === "digest_only")).toBe(
      true,
    );
    expect(getBody).not.toHaveBeenCalled();
  });

  it("cuts a long body at the text cap and marks it, and shows nothing for a body that is not text or does not hash (negative)", async () => {
    const long = "x".repeat(TRANSCRIPT_TEXT_MAX + 5);
    const binary = new Uint8Array([0xff, 0xfe, 0x00, 0xc3]);
    const forged = stored("real");
    objects.set(forged.bytesRef, {
      bytes: enc.encode("forged"),
      contentType: "text/plain",
    });
    const { transcript } = harness([
      tachoRow(0, { ...stored(long) }),
      tachoRow(1, { ...stored(binary, "application/octet-stream") }),
      tachoRow(2, { ...forged }),
    ]);
    const out = await transcript(input({ zoom: "everything" }), ctx());
    expect(out.entries[0]?.response).toMatchObject({
      text: "x".repeat(TRANSCRIPT_TEXT_MAX),
      truncated: true,
    });
    expect(out.entries[1]?.response).toMatchObject({
      text: null,
      fidelity: "full",
    });
    expect(out.entries[2]?.response).toMatchObject({
      text: null,
      fidelity: "full",
    });
  });

  it("is not_found for a run outside the workspace (negative) and empty for a run with no frames", async () => {
    const { transcript } = harness([]);
    await expect(
      transcript(input({ runId: "tse_nope", zoom: "turns" }), ctx()),
    ).rejects.toSatisfy((e) => isHandlerError(e) && e.code === "not_found");
    expect(await transcript(input({ zoom: "turns" }), ctx())).toEqual({
      zoom: "turns",
      kinds: [],
      entries: [],
      cursor: null,
      complete: true,
    });
  });
});
