// `get_run_transcript`: a run read as a transcript at one zoom level
// (Mission Control spec §8.4, §14; ADR-058).
//
// The frames come from the run reader (lib/run-read.ts), are narrowed to the
// chips the caller pressed (`filterFramesByKind`), and fold into entries with
// the pure `foldTranscript` (@oxagen/run-ledger). Each entry's two halves —
// what went out and what came back — then have their bodies read from the
// evidence store, decoded as UTF-8 and cut at the contract's text cap.
//
// Three things are computed over the whole run and not over the page: the
// cumulative cost, which is a prefix sum from the run's first frame (§8.4),
// the elapsed time, which is measured from the run's recorded start, and the
// turn each entry falls in, which is counted over the unfiltered frames so a
// chip never renumbers the turns. A page that computed any of them from its
// own first entry would restate the run's cost, clock and turns as the page's,
// which is wrong on every page but the first.
//
// Bodies are read a few at a time; a body that is not text, or that no longer
// hashes to its recorded digest, leaves its half with `text: null` rather than
// with bytes the record does not vouch for.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  runTranscriptGet,
  type RunTranscriptGetOutput,
  transcriptTextMax,
  type TranscriptEntry,
  type TranscriptEntryBody,
  type TranscriptZoom,
} from "@oxagen/oxagen/contracts/run.transcript.get";
import {
  filterFramesByKind,
  foldTranscript,
  frameKinds,
  type RunFrame,
  type TranscriptFold,
  type TranscriptKind,
  turnOrdinals,
} from "@oxagen/run-ledger";
import type { EvidenceStore } from "@oxagen/run-ledger/evidence-store";
import { evidenceStore } from "@oxagen/run-ledger/evidence-store";
import { digestBytes } from "@oxagen/tacho";
import {
  invalidCursor,
  microsString,
  runScope,
  type RunScope,
} from "./run.list";
import {
  defaultRunReadDeps,
  readAllFrames,
  resolveRun,
  startCursorSeq,
  type RunReadDeps,
} from "./lib/run-read";

/** The most frames a transcript folds; past it the transcript is incomplete. */
const TRANSCRIPT_FRAME_CAP = 10_000;
/** Bodies read at once. */
const BODY_CONCURRENCY = 8;

const DECIMAL = /^\d+$/;
/** The tacho start cursor: frames are numbered from 0, so a read from the start sits at -1. */
const TACHO_START = "-1";

export type RunTranscriptGetDeps = RunReadDeps & {
  bodies: Pick<EvidenceStore, "getBody">;
};

const decoder = new TextDecoder("utf-8", { fatal: true });

// ---- Cursor ---------------------------------------------------------------------------

/** The cursor for an entry: the last frame it folded, wrapped so the shape stays ours. */
export function encodeTranscriptCursor(endSeq: string): string {
  return Buffer.from(`t:${endSeq}`, "utf8").toString("base64url");
}

/** The sequence a cursor names, or null for a cursor this handler did not write. */
export function decodeTranscriptCursor(raw: string): string | null {
  const text = Buffer.from(raw, "base64url").toString("utf8");
  if (!text.startsWith("t:")) return null;
  const seq = text.slice(2);
  if (seq === TACHO_START) return seq;
  return DECIMAL.test(seq) && seq.length <= 19 ? seq : null;
}

/**
 * The fold index a page starts at after `after` (the endSeq of the last fold
 * the previous page returned), or -1 when nothing remains.
 *
 * Folds are not stable, non-overlapping sequence ranges. Parallel tool calls
 * produce `start A, start B, complete A, complete B`, so fold A owns 1..3 and
 * fold B owns 2..4. Comparing `opening.seq > after` against an endSeq cursor
 * skips B after a page that returned A (finding 4052061731). Resume in fold
 * order: find the fold that owned the cursor seq, re-emit it when it has
 * grown past the cursor (a live request that later gained its response), and
 * otherwise advance to the next fold.
 */
export function foldPageStart(
  folds: readonly { opening: { seq: string }; endSeq: string }[],
  after: string | null,
): number {
  if (after === null) return folds.length === 0 ? -1 : 0;
  const cursor = BigInt(after);
  const owned = folds.findIndex(
    (fold) =>
      BigInt(fold.opening.seq) <= cursor && BigInt(fold.endSeq) >= cursor,
  );
  if (owned === -1) {
    return folds.findIndex((fold) => BigInt(fold.opening.seq) > cursor);
  }
  // Same fold, not yet grown: advance past it. Grown: re-emit from here.
  if (BigInt(folds[owned]!.endSeq) > cursor) return owned;
  const next = owned + 1;
  return next < folds.length ? next : -1;
}

// ---- Bodies ---------------------------------------------------------------------------

/** One half of the exchange, with its body text when there is one to show. */
async function half(
  bodies: Pick<EvidenceStore, "getBody">,
  scope: RunScope,
  frame: RunFrame | null,
  textMax: number,
): Promise<TranscriptEntryBody | null> {
  if (frame === null) return null;
  const { bodyRef, bodyDigest, fidelity, redactions } = frame.body;
  const base = {
    seq: frame.seq,
    type: frame.type,
    digest: bodyDigest,
    bytesRef: bodyRef,
    redactions: (redactions ?? []).map((r) => ({
      path: r.path,
      reason: r.reason,
      originalDigest: r.original_digest,
    })),
    fidelity,
  };
  if (bodyRef === null || bodyDigest === null) {
    return { ...base, text: null, truncated: false };
  }
  const stored = await bodies.getBody(scope, bodyRef);
  if (digestBytes(stored.bytes) !== bodyDigest) {
    return { ...base, text: null, truncated: false };
  }
  let text: string;
  try {
    text = decoder.decode(stored.bytes);
  } catch {
    return { ...base, text: null, truncated: false };
  }
  return text.length > textMax
    ? { ...base, text: text.slice(0, textMax), truncated: true }
    : { ...base, text, truncated: false };
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

// ---- Entries --------------------------------------------------------------------------

const cost = (micros: number | null) =>
  micros === null
    ? null
    : {
        micros: microsString(micros),
        currency: "USD",
        basis: "client_attested" as const,
      };

/** Milliseconds from the run's start; never negative (see the contract). */
export function elapsedMs(startedAt: number, at: Date): number {
  return Math.max(0, Math.round(at.getTime() - startedAt));
}

/** The chips an entry answers to: the union over the frames it folds. */
function entryKinds(fold: TranscriptFold): TranscriptKind[] {
  const kinds = new Set<TranscriptKind>();
  for (const frame of [fold.opening, fold.request, fold.response]) {
    if (frame === null) continue;
    for (const kind of frameKinds(frame)) kinds.add(kind);
  }
  if (fold.decision !== null) kinds.add("policy");
  return [...kinds];
}

export function createRunTranscriptGetHandler(
  deps: RunTranscriptGetDeps,
): CapabilityHandler<typeof runTranscriptGet> {
  return async (input, ctx): Promise<RunTranscriptGetOutput> => {
    const after =
      input.after === undefined ? null : decodeTranscriptCursor(input.after);
    if (input.after !== undefined && after === null) {
      throw invalidCursor(runTranscriptGet.name);
    }

    const scope = runScope(ctx);
    const run = await resolveRun(deps, ctx, input.runId);
    const read = await readAllFrames(deps, run, TRANSCRIPT_FRAME_CAP);
    const frames = filterFramesByKind(read.frames, input.kinds);
    const folds = foldTranscript(frames, input.zoom);
    // Turns are counted over every frame of the run, so a chip filter never
    // renumbers them: turn 2 is turn 2 whichever kinds the page shows.
    const ordinals = turnOrdinals(read.frames);
    const turnOf = new Map(
      read.frames.map((frame, i) => [frame.seq, ordinals[i] ?? null]),
    );

    // The prefix sum runs over every fold of the run, so an entry's cumulative
    // cost is what the run had spent by then and not what this page has.
    const cumulative: (number | null)[] = [];
    let running: number | null = null;
    for (const fold of folds) {
      running =
        fold.costMicros === null ? running : (running ?? 0) + fold.costMicros;
      cumulative.push(running);
    }

    // A sealed run answers no cursor once the page holds every fold left. A
    // live run keeps a resume point even when caught up, so the next read can
    // pick up frames that have not landed yet.
    const live = run.item.status === "live";
    const resumeCursor = (): string =>
      encodeTranscriptCursor(after ?? startCursorSeq(run));

    const start = foldPageStart(folds, after);
    if (start === -1) {
      return {
        zoom: input.zoom,
        kinds: input.kinds,
        entries: [],
        cursor: live ? resumeCursor() : null,
        complete: read.complete,
      };
    }
    const page = folds.slice(start, start + input.limit);
    const runStartedAt = Date.parse(run.item.startedAt);

    // A folded zoom carries an excerpt; `everything` carries the whole body.
    const textMax = transcriptTextMax(input.zoom as TranscriptZoom);
    const halves = await mapConcurrent(
      page,
      BODY_CONCURRENCY,
      async (fold) => ({
        request: await half(deps.bodies, scope, fold.request, textMax),
        response: await half(deps.bodies, scope, fold.response, textMax),
      }),
    );

    const entries: TranscriptEntry[] = page.map((fold, i) => {
      const { opening } = fold;
      const pair = halves[i] as {
        request: TranscriptEntryBody | null;
        response: TranscriptEntryBody | null;
      };
      return {
        seq: opening.seq,
        endSeq: fold.endSeq,
        at: opening.observedAt.toISOString(),
        elapsedMs: elapsedMs(runStartedAt, opening.observedAt),
        kind: fold.kind,
        type: opening.type,
        label: opening.summary,
        kinds: entryKinds(fold),
        request: pair.request,
        response: pair.response,
        decision:
          fold.decision === null
            ? null
            : {
                seq: fold.decision.seq,
                decision: fold.decision.decision,
                type: fold.decision.type,
                at: fold.decision.at.toISOString(),
              },
        frames: fold.frames,
        turn: turnOf.get(opening.seq) ?? null,
        cost: cost(fold.costMicros),
        cumulativeCost: cost(cumulative[start + i] ?? null),
      };
    });

    const last = page.at(-1);
    const more = start + page.length < folds.length;
    const cursor = live
      ? last
        ? encodeTranscriptCursor(last.endSeq)
        : resumeCursor()
      : more && last
        ? encodeTranscriptCursor(last.endSeq)
        : null;
    return {
      zoom: input.zoom,
      kinds: input.kinds,
      entries,
      cursor,
      complete: read.complete,
    };
  };
}

export const runTranscriptGetHandler = createRunTranscriptGetHandler({
  ...defaultRunReadDeps(),
  get bodies() {
    return evidenceStore();
  },
});
