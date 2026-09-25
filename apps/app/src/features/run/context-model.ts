// What the Context tab reads out of the whole-run transcript (mockup
// `promptRow`, `runManifestPanel` and `contextTab`): the operator's first
// prompt, the first model step and the input it reported, and the
// `steering.manifest` frame the host sealed at the session's start.
//
// Pure, so each reading is tested without a render. Nothing here pairs,
// counts or estimates: the server folds a model call's request and response
// into one step and counts what a manifest put in front of the model
// (ADR-182), the window is not recorded block by block (G10), and a figure
// the record did not carry is null.
import { z } from "zod";
import type { TranscriptEntry } from "@/data/contracts/run";
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
 * The body of a `steering.manifest` frame, as the host seals it
 * (`steeringManifestFrameSchema`, packages/tacho/src/wire.ts). Read loosely:
 * a word the vocabulary gains later still renders as the recorded word.
 */
const ManifestItem = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  force: z.string().min(1),
  tokens: z.number().int().nonnegative(),
  outcome: z.enum(["included", "cut"]),
  reason: z.string().optional(),
  superseded_by: z.string().optional(),
});
export type ManifestItem = z.infer<typeof ManifestItem>;

const ManifestBody = z.object({
  budget_tokens: z.number().int().nonnegative(),
  spent_tokens: z.number().int().nonnegative(),
  text_digest: z.string().nullable().optional(),
  items: z.array(ManifestItem),
  bundle_version: z.number().int().nonnegative().optional(),
});
type ManifestBody = z.infer<typeof ManifestBody>;

/** A manifest body's text, parsed; null when it is not a manifest. */
export function parseManifest(text: string): ManifestBody | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = ManifestBody.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** Where a manifest's items came from, or why they could not be read. */
export type ManifestRead =
  | { state: "read"; entry: TranscriptEntry; body: ManifestBody }
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
