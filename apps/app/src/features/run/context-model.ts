// What the Context tab reads out of the whole-run transcript (mockup
// `promptRow`, `runManifestPanel` and `contextTab`): the operator's first
// prompt, the first model step and the input it reported, and the
// `steering.manifest` frame the host sealed at the session's start.
//
// Pure, so each reading is tested without a render. Nothing here pairs,
// counts, parses or estimates: the server folds a model call's request and
// response into one step and reads what a manifest put in front of the model
// and cut (ADR-182), the window is not recorded block by block (G10), and a
// figure the record did not carry is null.
import type { TranscriptEntry, TranscriptRecall } from "@/data/contracts/run";
import { soleBody } from "./transcript-rows";

/** The frame type the host seals the assembler's manifest into (ADR-093, ADR-144). */
const MANIFEST_TYPE = "steering.manifest";

/** An entry on the run's own chain; a subagent's prompt and calls are its own. */
function own(entry: TranscriptEntry): boolean {
  return entry.subagent === undefined;
}

export type FirstPrompt = {
  seq: string;
  /** The operator's words; null when the recorder kept no text. */
  text: string | null;
};

/** The first turn's prompt: the first `turn_start` on the run's own chain. */
export function firstPrompt(
  entries: readonly TranscriptEntry[],
): FirstPrompt | null {
  const entry = entries.find(
    (candidate) => own(candidate) && candidate.type === "turn_start",
  );
  if (entry === undefined) return null;
  return { seq: entry.seq, text: soleBody(entry)?.text ?? null };
}

export type FirstRequest = {
  /** The frame the model step opens on, and its type, for its link. */
  seq: string;
  type: string;
  /** Every input class the call reported, summed; null when a class was not reported. */
  input: number | null;
  /** The part of that input read from cache; null when not reported. */
  cached: number | null;
};

/**
 * The run's first model step on its own chain, and the input it reported.
 * `steps` is the transcript at `steps`, where the server folded the request
 * and the response that reported its usage into one entry, so no reading
 * here pairs one call's request with another's figures.
 */
export function firstRequest(
  steps: readonly TranscriptEntry[],
): FirstRequest | null {
  const step = steps.find((entry) => own(entry) && entry.node === "model");
  if (step === undefined) return null;
  const usage = step.usage ?? null;
  const input =
    usage === null ||
    usage.inputUncached === null ||
    usage.cacheRead === null ||
    usage.cacheWrite === null
      ? null
      : usage.inputUncached + usage.cacheRead + usage.cacheWrite;
  return {
    seq: step.seq,
    type: step.type,
    input,
    cached: usage?.cacheRead ?? null,
  };
}

/**
 * The Context tab's reading of the manifest: the server's reading of the
 * frame's body (`recall`, ADR-182), or why it has no items to show. The
 * page never parses the body itself.
 */
export type ManifestRead =
  | { state: "read"; entry: TranscriptEntry; recall: TranscriptRecall }
  | {
      state: "unretained" | "unparsed" | "failed";
      entry: TranscriptEntry;
    };

/** The manifest frame on the run's own chain, if the run recorded one. */
export function manifestEntry(
  entries: readonly TranscriptEntry[],
): TranscriptEntry | null {
  return (
    entries.find((entry) => own(entry) && entry.type === MANIFEST_TYPE) ?? null
  );
}

/**
 * The run's manifest as the server read it: its items when the body listed
 * them, or which of the server's reasons it listed none. Null when the run
 * recorded no manifest frame.
 */
export function manifestOf(
  entries: readonly TranscriptEntry[],
): ManifestRead | null {
  const entry = manifestEntry(entries);
  if (entry === null) return null;
  const recall = entry.recall;
  if (recall?.body === "listed" && recall.unit === "items")
    return { state: "read", entry, recall };
  switch (recall?.body) {
    case "unretained":
      return { state: "unretained", entry };
    case "unreadable":
      return { state: "failed", entry };
    default:
      return { state: "unparsed", entry };
  }
}
