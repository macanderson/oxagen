// `get_run_transcript`: a run read as a transcript at one zoom level
// (Mission Control spec §14; ADR-058).
//
// The frames come from the run reader (lib/run-read.ts) and fold into
// entries with the pure `foldTranscript` (@oxagen/run-ledger). Each entry's
// opening frame then has its body read from the evidence store when one was
// retained, decoded as UTF-8 and cut at the contract's text cap. Bodies are
// read a few at a time; a body that is not text, or that no longer hashes
// to its recorded digest, leaves the entry with `text: null` rather than
// with bytes the record does not vouch for.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  runTranscriptGet,
  type RunTranscriptGetOutput,
  TRANSCRIPT_ENTRY_MAX,
  TRANSCRIPT_TEXT_MAX,
  type TranscriptEntry,
} from "@oxagen/oxagen/contracts/run.transcript.get";
import {
  foldTranscript,
  type RunFrame,
  type TranscriptFold,
  turnOrdinals,
} from "@oxagen/run-ledger";
import type { EvidenceStore } from "@oxagen/run-ledger/evidence-store";
import { evidenceStore } from "@oxagen/run-ledger/evidence-store";
import { digestBytes } from "@oxagen/tacho";
import { microsString, runScope, type RunScope } from "./run.list";
import {
  defaultRunReadDeps,
  readAllFrames,
  resolveRun,
  type RunReadDeps,
} from "./lib/run-read";

/** The most frames a transcript folds; past it the transcript is incomplete. */
const TRANSCRIPT_FRAME_CAP = 10_000;
/** Bodies read at once. */
const BODY_CONCURRENCY = 8;

export type RunTranscriptGetDeps = RunReadDeps & {
  bodies: Pick<EvidenceStore, "getBody">;
};

const decoder = new TextDecoder("utf-8", { fatal: true });

/** The body text of a frame, or null when there is none to show. */
async function bodyText(
  bodies: Pick<EvidenceStore, "getBody">,
  scope: RunScope,
  frame: RunFrame,
): Promise<{ text: string | null; truncated: boolean }> {
  const { bodyRef, bodyDigest } = frame.body;
  if (bodyRef === null || bodyDigest === null) {
    return { text: null, truncated: false };
  }
  const stored = await bodies.getBody(scope, bodyRef);
  if (digestBytes(stored.bytes) !== bodyDigest) {
    return { text: null, truncated: false };
  }
  let text: string;
  try {
    text = decoder.decode(stored.bytes);
  } catch {
    return { text: null, truncated: false };
  }
  if (text.length > TRANSCRIPT_TEXT_MAX) {
    return { text: text.slice(0, TRANSCRIPT_TEXT_MAX), truncated: true };
  }
  return { text, truncated: false };
}

async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      out[index] = await fn(items[index] as T);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return out;
}

function toEntry(
  fold: TranscriptFold,
  body: { text: string | null; truncated: boolean },
  turn: number | null,
): TranscriptEntry {
  const { opening } = fold;
  return {
    seq: opening.seq,
    endSeq: fold.endSeq,
    at: opening.observedAt.toISOString(),
    kind: fold.kind,
    type: opening.type,
    label: opening.summary,
    text: body.text,
    truncated: body.truncated,
    fidelity: opening.body.fidelity,
    frames: fold.frames,
    turn,
    cost:
      fold.costMicros === null
        ? null
        : {
            micros: microsString(fold.costMicros),
            currency: "USD",
            basis: "client_attested",
          },
  };
}

export function createRunTranscriptGetHandler(
  deps: RunTranscriptGetDeps,
): CapabilityHandler<typeof runTranscriptGet> {
  return async (input, ctx): Promise<RunTranscriptGetOutput> => {
    const scope = runScope(ctx);
    const run = await resolveRun(deps, ctx, input.runId);
    const read = await readAllFrames(deps, run, TRANSCRIPT_FRAME_CAP);
    const folds = foldTranscript(read.frames, input.zoom);
    const ordinals = turnOrdinals(read.frames);
    const turnOf = new Map(
      read.frames.map((frame, i) => [frame.seq, ordinals[i] ?? null]),
    );
    const kept = folds.slice(0, TRANSCRIPT_ENTRY_MAX);
    const texts = await mapConcurrent(kept, BODY_CONCURRENCY, (fold) =>
      bodyText(deps.bodies, scope, fold.opening),
    );
    return {
      zoom: input.zoom,
      entries: kept.map((fold, i) =>
        toEntry(
          fold,
          texts[i] as { text: string | null; truncated: boolean },
          turnOf.get(fold.opening.seq) ?? null,
        ),
      ),
      complete: read.complete && folds.length === kept.length,
    };
  };
}

export const runTranscriptGetHandler = createRunTranscriptGetHandler({
  ...defaultRunReadDeps(),
  get bodies() {
    return evidenceStore();
  },
});
