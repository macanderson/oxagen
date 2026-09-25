// What the Context tab reads out of the transcript, without a render: the
// first prompt, the first model step and the input it reported, and the
// manifest body read loosely but refused when it is not a manifest. Pairing a
// request with the response that reported its usage is the server's fold
// (`packages/run-ledger/src/transcript-steps.test.ts`), so the first model
// step arrives here as one entry.
import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "@/data/contracts/run";
import {
  firstPrompt,
  firstRequest,
  manifestEntry,
  parseManifest,
} from "./context-model";
import { transcriptBody, transcriptEntry } from "./run.builders";
import { evidenceTranscript, manifestText } from "./sections.builders";

const entries = evidenceTranscript().entries;

function frame(overrides: Partial<TranscriptEntry>): TranscriptEntry {
  return transcriptEntry({ usage: null, request: null, ...overrides });
}

describe("firstPrompt", () => {
  it("reads the first turn's prompt from the run's own chain", () => {
    expect(firstPrompt(entries)).toEqual({
      seq: "3",
      text: "Cut 4.11.0 release notes. Task a-intel/platform#482.",
    });
  });

  it("skips a subagent's prompt, and says the text was not kept rather than inventing one (negative)", () => {
    const prompt = firstPrompt([
      frame({
        seq: "1",
        type: "turn_start",
        subagent: { chainRef: "c1", type: "Explore" },
        response: transcriptBody({ text: "the subagent's words" }),
      }),
      frame({
        seq: "2",
        type: "turn_start",
        response: transcriptBody({ text: null, fidelity: "digest_only" }),
      }),
    ]);
    expect(prompt).toEqual({ seq: "2", text: null });
    expect(firstPrompt([])).toBeNull();
  });

  it("reads a prompt recorded as the request half of its turn_start", () => {
    expect(
      firstPrompt([
        frame({
          seq: "2",
          type: "turn_start",
          kind: "frame",
          request: transcriptBody({ seq: "2", text: "Cut 4.11.0." }),
          response: null,
        }),
      ]),
    ).toEqual({ seq: "2", text: "Cut 4.11.0." });
  });
});

describe("firstRequest", () => {
  const usage = {
    inputUncached: 3_368,
    cacheRead: 12_000,
    cacheWrite: 0,
    output: 412,
    reasoning: null,
  };

  it("reads the first model step on the run's own chain, and the input it reported", () => {
    const request = firstRequest([
      frame({ seq: "1", kind: "frame", type: "turn_start", node: "prompt" }),
      frame({
        seq: "2",
        kind: "model_call",
        type: "model.request",
        node: "model",
        subagent: { chainRef: "c1", type: "Explore" },
        usage,
      }),
      frame({
        seq: "4",
        kind: "model_call",
        type: "model.request",
        node: "model",
        usage,
      }),
    ]);
    expect(request).toEqual({
      seq: "4",
      type: "model.request",
      input: 15_368,
      cached: 12_000,
    });
  });

  it("leaves the total unstated when a class was not reported, and keeps the cache read that was (negative)", () => {
    const request = firstRequest([
      frame({
        seq: "1",
        kind: "model_call",
        type: "model.call_completed",
        node: "model",
        usage: {
          ...usage,
          inputUncached: 100,
          cacheRead: 900,
          cacheWrite: null,
        },
      }),
    ]);
    expect(request?.input).toBeNull();
    expect(request?.cached).toBe(900);
  });

  it("reads no usage for a model step that reported none (negative)", () => {
    const request = firstRequest([
      frame({
        seq: "1",
        kind: "model_call",
        type: "model.request",
        node: "model",
      }),
    ]);
    expect(request).toEqual({
      seq: "1",
      type: "model.request",
      input: null,
      cached: null,
    });
  });

  it("answers null when no model step is in view", () => {
    expect(
      firstRequest([
        frame({ kind: "frame", type: "agent_start", node: "control" }),
      ]),
    ).toBeNull();
  });
});

describe("the manifest", () => {
  it("finds the manifest frame and reads its items", () => {
    expect(manifestEntry(entries)?.seq).toBe("1");
    const manifest = parseManifest(manifestText());
    expect(manifest?.bundle_version).toBe(41);
    expect(manifest?.items).toHaveLength(8);
  });

  it("reads a word the vocabulary gains later as the recorded word", () => {
    const manifest = parseManifest(
      manifestText({
        items: [
          {
            id: "x",
            kind: "playbook",
            force: "must",
            tokens: 3,
            outcome: "included",
            recorded_at: "",
          },
        ],
      }),
    );
    expect(manifest?.items[0]?.kind).toBe("playbook");
  });

  it("refuses a body that is not JSON or not a manifest (negative)", () => {
    expect(parseManifest("{not json")).toBeNull();
    expect(parseManifest(JSON.stringify({ items: "none" }))).toBeNull();
  });
});
