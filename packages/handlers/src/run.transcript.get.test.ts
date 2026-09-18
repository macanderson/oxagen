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
  it("everything: one entry per frame, with the body text where one was retained", async () => {
    const { transcript } = harness(rows);
    const out = await transcript(
      { runId: TACHO_ID, zoom: "everything" },
      ctx(),
    );
    expect(runTranscriptGet.output.parse(out)).toEqual(out);
    expect(out.complete).toBe(true);
    expect(out.entries.map((e) => [e.seq, e.kind, e.text, e.fidelity])).toEqual(
      [
        ["0", "frame", null, "digest_only"],
        ["1", "frame", null, "digest_only"],
        ["2", "model_call", "What is in README?", "full"],
        ["3", "tool_call", '{"path":"README.md"}', "full"],
        ["4", "frame", null, "digest_only"],
        ["5", "model_call", null, "digest_only"],
        ["6", "frame", null, "digest_only"],
      ],
    );
    expect(out.entries.map((e) => e.turn)).toEqual([null, 1, 1, 1, 2, 2, 2]);
    expect(out.entries[2]?.cost).toEqual({
      micros: "40",
      currency: "USD",
      basis: "client_attested",
    });
  });

  it("steps: model and tool calls, folding the frames between and summing their cost", async () => {
    const { transcript } = harness(rows);
    const out = await transcript({ runId: TACHO_ID, zoom: "steps" }, ctx());
    expect(out.entries.map((e) => [e.seq, e.endSeq, e.kind, e.frames])).toEqual(
      [
        ["0", "1", "frame", 2],
        ["2", "2", "model_call", 1],
        ["3", "4", "tool_call", 2],
        ["5", "6", "model_call", 2],
      ],
    );
  });

  it("turns: one entry per turn with the turn's cost, and the text of the turn's opening frame", async () => {
    const { transcript } = harness(rows);
    const out = await transcript({ runId: TACHO_ID, zoom: "turns" }, ctx());
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
    expect(out.entries.map((e) => e.turn)).toEqual([null, 1, 2]);
  });

  it("a digest_only recording answers every entry with text null and says so", async () => {
    const { transcript, getBody } = harness(
      rows.map((r) => ({ ...r, bytesRef: "" })),
    );
    const out = await transcript(
      { runId: TACHO_ID, zoom: "everything" },
      ctx(),
    );
    expect(out.entries.every((e) => e.text === null)).toBe(true);
    expect(out.entries.every((e) => e.fidelity === "digest_only")).toBe(true);
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
    const out = await transcript(
      { runId: TACHO_ID, zoom: "everything" },
      ctx(),
    );
    expect(out.entries[0]).toMatchObject({
      text: "x".repeat(TRANSCRIPT_TEXT_MAX),
      truncated: true,
    });
    expect(out.entries[1]).toMatchObject({ text: null, fidelity: "full" });
    expect(out.entries[2]).toMatchObject({ text: null, fidelity: "full" });
  });

  it("is not_found for a run outside the workspace (negative) and empty for a run with no frames", async () => {
    const { transcript } = harness([]);
    await expect(
      transcript({ runId: "tse_nope", zoom: "turns" }, ctx()),
    ).rejects.toSatisfy((e) => isHandlerError(e) && e.code === "not_found");
    expect(await transcript({ runId: TACHO_ID, zoom: "turns" }, ctx())).toEqual(
      {
        zoom: "turns",
        entries: [],
        complete: true,
      },
    );
  });
});
