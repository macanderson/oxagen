// What the Context tab reads out of the whole-run transcript (mockup
// `promptRow`, `runManifestPanel` and `contextTab`): the operator's first
// prompt, the first model request and the input it reported, and the
// `steering.manifest` frame the host sealed at the session's start.
//
// Pure, so each reading is tested without a render. Nothing here estimates a
// token or splits a window: the window is not recorded block by block (G10),
// and a figure the frames did not carry is null.
import { z } from "zod";
import type { TranscriptBody, TranscriptEntry } from "@/data/contracts/run";

/** The frame type the host seals the assembler's manifest into (ADR-093, ADR-144). */
const MANIFEST_TYPE = "steering.manifest";

/** The one body an entry at `everything` carries: what went out, or what came back. */
export function bodyOf(entry: TranscriptEntry): TranscriptBody | null {
  if (entry.request !== null && entry.response !== null) return null;
  return entry.response ?? entry.request;
}

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
  return { seq: entry.seq, text: bodyOf(entry)?.text ?? null };
}

export type FirstRequest = {
  entry: TranscriptEntry;
  /** Every input class the call reported, summed; null when a class was not reported. */
  input: number | null;
  /** The part of that input read from cache; null when not reported. */
  cached: number | null;
  /** The entry that reported the usage; null when none did. */
  usageSeq: string | null;
};

/**
 * The run's first model call, and the input it reported. The request frame
 * carries no usage; the response that answers it does. The usage is taken
 * from the first model frame after the request that reports any, unless a
 * second request opened first, so one call's figures are never another's.
 */
export function firstRequest(
  entries: readonly TranscriptEntry[],
): FirstRequest | null {
  const start = entries.findIndex(
    (entry) => own(entry) && entry.kind === "model_call",
  );
  const request = entries[start];
  if (request === undefined) return null;
  let reported: TranscriptEntry | null = null;
  for (const entry of entries.slice(start)) {
    if (!own(entry) || entry.kind !== "model_call") continue;
    if (entry !== request && entry.type === request.type) break;
    if (entry.usage !== null && entry.usage !== undefined) {
      reported = entry;
      break;
    }
  }
  const usage = reported?.usage ?? null;
  const input =
    usage === null ||
    usage.inputUncached === null ||
    usage.cacheRead === null ||
    usage.cacheWrite === null
      ? null
      : usage.inputUncached + usage.cacheRead + usage.cacheWrite;
  return {
    entry: request,
    input,
    cached: usage?.cacheRead ?? null,
    usageSeq: reported?.seq ?? null,
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

type ManifestTally = {
  rendered: number;
  cut: number;
  /** The rendered items' tokens, summed from the items listed. */
  tokens: number;
};

export function tallyOf(manifest: ManifestBody): ManifestTally {
  const rendered = manifest.items.filter((item) => item.outcome === "included");
  return {
    rendered: rendered.length,
    cut: manifest.items.length - rendered.length,
    tokens: rendered.reduce((sum, item) => sum + item.tokens, 0),
  };
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
