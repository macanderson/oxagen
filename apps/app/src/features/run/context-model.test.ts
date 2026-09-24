// What the Context tab reads out of the transcript, without a render: the
// first prompt, the first request and the usage that answers it (never a
// later call's), and the manifest body read loosely but refused when it is
// not a manifest.
import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "@/data/contracts/run";
import {
  firstPrompt,
  firstRequest,
  manifestEntry,
  parseManifest,
  tallyOf,
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
});

describe("firstRequest", () => {
  it("pairs the first request with the usage its response reported", () => {
    const request = firstRequest(entries);
    expect(request?.entry.seq).toBe("4");
    expect(request?.usageSeq).toBe("5");
    expect(request?.input).toBe(15_368);
    expect(request?.cached).toBe(12_000);
  });

  it("never takes a later call's usage for the first call's (negative)", () => {
    const request = firstRequest([
      frame({ seq: "1", kind: "model_call", type: "model.request" }),
      frame({ seq: "2", kind: "model_call", type: "model.response" }),
      frame({ seq: "3", kind: "model_call", type: "model.request" }),
      frame({
        seq: "4",
        kind: "model_call",
        type: "model.response",
        usage: {
          inputUncached: 10,
          cacheRead: 5,
          cacheWrite: 0,
          output: 1,
          reasoning: null,
        },
      }),
    ]);
    expect(request?.entry.seq).toBe("1");
    expect(request?.input).toBeNull();
    expect(request?.cached).toBeNull();
    expect(request?.usageSeq).toBeNull();
  });

  it("leaves the total unstated when a class was not reported, and keeps the cache read that was (negative)", () => {
    const request = firstRequest([
      frame({
        seq: "1",
        kind: "model_call",
        type: "model.call_completed",
        usage: {
          inputUncached: 100,
          cacheRead: 900,
          cacheWrite: null,
          output: 10,
          reasoning: null,
        },
      }),
    ]);
    expect(request?.input).toBeNull();
    expect(request?.cached).toBe(900);
  });

  it("answers null when no model call is in view", () => {
    expect(firstRequest([frame({ kind: "frame", type: "agent_start" })])).toBe(
      null,
    );
  });
});

describe("the manifest", () => {
  it("finds the manifest frame and reads its items and tally", () => {
    expect(manifestEntry(entries)?.seq).toBe("1");
    const manifest = parseManifest(manifestText());
    expect(manifest?.bundle_version).toBe(41);
    if (manifest === null) throw new Error("a manifest");
    expect(tallyOf(manifest)).toEqual({ rendered: 3, cut: 5, tokens: 435 });
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
