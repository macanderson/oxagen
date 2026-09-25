// The Transcript tab's counts and its rows come from one rule (ADR-182).
//
// The server folds the run, settles which entries have nothing to show, and
// counts the rest (`transcriptCounts`). The tab draws each entry's rows
// (`feedOf`) and shows the server's counts beside them. If the two ever
// disagree about which entries draw, a chip says one number and shows
// another. So this test runs a recorded run through the real handler, then
// through the port's mapper and the tab's row function, and checks every
// count against the entries that drew rows under it.
//
// The unit is the entry, not the row: a model step that said two things is
// one entry under `responses`, drawn as two rows.
import { createHash } from "node:crypto";
import type { TachoFrameRow } from "@oxagen/telemetry";
import { runTranscriptGet } from "@oxagen/oxagen/contracts/run.transcript.get";
import { createRunTranscriptGetHandler } from "@oxagen/handlers/run.transcript.get";
import {
  ctx,
  memoryEvents,
  memoryStores,
  memoryTachoFrames,
  tachoRow,
  tachoSession,
} from "@oxagen/handlers/run.test-support";
import { describe, expect, it } from "vitest";
import { RunTranscript } from "@/data/contracts/run";
import { toRunTranscript } from "@/data/live/mappers/run";
import { FEED_GROUPS, feedOf } from "./transcript-rows";

const TACHO_ID = "tse_4q8r1t6v3x5z0b2d7h2k9m";
const SESSION_UUID = "0192d4a8-7c1e-7a00-8000-00000000c0de";

const enc = new TextEncoder();
const objects = new Map<string, Uint8Array>();

/** A body the recorder kept, stored under its digest. */
function stored(text: string) {
  const bytes = enc.encode(text);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const ref = `evb:v1:k:${digest.slice(7)}`;
  objects.set(ref, bytes);
  return { contentDigest: digest, bytesRef: ref };
}

/** A recorded model stream that says `text`, then calls Write as `toolu_w`. */
function modelStream(text: string): string {
  const events = [
    { type: "message_start", message: { usage: { input_tokens: 10 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text" } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "toolu_w", name: "Write" },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify({ file_path: "/p/notes.md" }),
      },
    },
    { type: "content_block_stop", index: 1 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 20 },
    },
    { type: "message_stop" },
  ];
  return events
    .map((data) => `event: e\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
}

const none = { toolName: "", toolStatus: "", toolUseId: "" };

/**
 * Two turns: a prompt, a model step that says something and calls Write, the
 * Write call, a failed Bash call, and a closing message that repeats the
 * model's words; then a prompt of only whitespace, a closing message that
 * says something new, and the run's stop.
 */
const rows: TachoFrameRow[] = [
  tachoRow(0, {
    kind: "turn_start",
    ...none,
    turnSeq: 1,
    ...stored("Ship it."),
  }),
  tachoRow(1, {
    kind: "llm_call",
    ...none,
    model: "claude-opus-5",
    provider: "anthropic",
    costUsdMicros: 40,
    turnSeq: 1,
    ...stored(modelStream("Writing the notes.")),
  }),
  tachoRow(2, {
    kind: "tool_call",
    toolName: "Write",
    toolStatus: "ok",
    toolUseId: "toolu_w",
    turnSeq: 1,
  }),
  tachoRow(3, {
    kind: "tool_call",
    toolName: "Bash",
    toolStatus: "error",
    toolUseId: "tu_b",
    turnSeq: 1,
  }),
  tachoRow(4, {
    kind: "turn_end",
    ...none,
    turnSeq: 1,
    ...stored("Writing the notes.\n"),
  }),
  tachoRow(5, { kind: "turn_start", ...none, turnSeq: 2, ...stored(" \n") }),
  tachoRow(6, {
    kind: "turn_end",
    ...none,
    turnSeq: 2,
    ...stored("Nothing more to do."),
  }),
  tachoRow(7, { kind: "agent_stop", ...none, turnSeq: 2 }),
];

function transcript() {
  const stores = memoryStores([], [tachoSession({ publicId: TACHO_ID })]);
  return createRunTranscriptGetHandler({
    queries: stores.queries,
    store: {
      getRunByPublicId: () => Promise.resolve(null),
      readAttemptEventsSince: memoryEvents([]),
    },
    readRunRollups: stores.readRunRollups,
    readWitnessFor: stores.readWitnessFor,
    tachoFrames: memoryTachoFrames(SESSION_UUID, rows),
    tachoSubagentFrames: () => Promise.resolve([]),
    bodies: {
      getBody: (_scope, ref) => {
        const bytes = objects.get(ref);
        return bytes === undefined
          ? Promise.reject(new Error(`no object for ${ref}`))
          : Promise.resolve({
              bytes,
              contentType: "text/plain",
              digestHex: ref.slice(-64),
            });
      },
      getAssembly: () => Promise.resolve(null),
    },
    priceBook: () => Promise.resolve([]),
  });
}

describe("the Transcript tab's counts and rows", () => {
  it("count exactly the entries that draw rows, chip by chip", async () => {
    const out = await transcript()(
      runTranscriptGet.input.parse({
        runId: TACHO_ID,
        zoom: "steps",
        text: "full",
      }),
      ctx(),
    );
    const read = RunTranscript.parse(toRunTranscript(out));
    const drawn = feedOf(read.entries);
    const entriesOf = (keep: (row: (typeof drawn)[number]) => boolean) =>
      new Set(drawn.filter(keep).map((row) => row.entry)).size;
    const counts = read.counts;
    if (counts === null) throw new Error("the read carried no counts");

    for (const group of FEED_GROUPS) {
      expect({ group, count: counts.kinds[group] }).toEqual({
        group,
        count: entriesOf((row) => row.group === group),
      });
    }
    expect(counts.entries).toBe(entriesOf(() => true));
    expect(counts.errors).toBe(entriesOf((row) => row.failed));

    // The fixture holds what used to split them: a closing message that
    // repeats the model's streamed words, and a prompt of only whitespace.
    expect(drawn.map((row) => [row.entry, row.kind])).toEqual([
      ["0", "prompt"],
      ["1", "text"],
      ["1", "usage"],
      ["2", "tool"],
      ["3", "tool"],
      ["6", "text"],
      ["7", "seal"],
    ]);
    expect(counts.entries).toBe(6);
  });
});
