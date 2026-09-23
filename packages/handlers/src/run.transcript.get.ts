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
import {
  loadPriceBookInTenantScope,
  type PriceBook,
  resolvePriceEntry,
} from "@oxagen/billing";
import { assemblyView, readAssembly } from "./lib/transcript-assembly";
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
  bodies: Pick<EvidenceStore, "getBody" | "getAssembly">;
  /**
   * The organization's price book, read once per transcript. A block's cost
   * is its share of the message's output tokens at the model's output rate;
   * a model the book prices no output for leaves every block's cost null
   * rather than drawing a zero.
   *
   * `get_run_transcript` is a scoped capability serving one organization, so
   * the default reads the book inside the caller's tenant scope. It used to
   * take the system connection, which made every nonempty transcript page an
   * unscoped access in the record for a read that is as ordinary as a page
   * view (#3526).
   */
  priceBook: (orgId: string) => Promise<PriceBook>;
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
 * order: the fold that owned the cursor is the one whose endSeq equals it
 * (the fold the previous page returned). A cursor can sit inside several
 * overlapping folds once an earlier fold grows past a later fold's opening,
 * so ownership must not be inferred from the first containing range
 * (finding 4052307522). When an earlier fold has grown past that exact
 * owner (parallel B finished before A; the client holds B's endSeq while A
 * then completes), re-emit the earlier grown fold before advancing past the
 * exact match — otherwise A's response is never emitted (Codex P1 on #3352).
 * When no fold ends at the cursor anymore, re-emit the last fold that still
 * contains it and has grown past it. Otherwise advance to the next fold
 * whose opening is after the cursor.
 */
export function foldPageStart(
  folds: readonly { opening: { seq: string }; endSeq: string }[],
  after: string | null,
): number {
  if (after === null) return folds.length === 0 ? -1 : 0;
  const cursor = BigInt(after);
  const owned = folds.findIndex((fold) => BigInt(fold.endSeq) === cursor);
  if (owned !== -1) {
    // An earlier fold that grew past the exact owner still needs a page.
    // Walked backwards rather than with findLastIndex (ES2023), same as below.
    for (let i = owned - 1; i >= 0; i -= 1) {
      const fold = folds[i];
      if (
        fold !== undefined &&
        BigInt(fold.opening.seq) <= cursor &&
        BigInt(fold.endSeq) > cursor
      ) {
        return i;
      }
    }
    const next = owned + 1;
    return next < folds.length ? next : -1;
  }
  // No fold ends at the cursor: the fold the previous page returned has
  // grown. Prefer the last containing range so an earlier fold that expanded
  // over a later fold's opening does not reclaim the cursor.
  let grown = -1;
  for (let i = folds.length - 1; i >= 0; i -= 1) {
    const fold = folds[i];
    if (
      fold !== undefined &&
      BigInt(fold.opening.seq) <= cursor &&
      BigInt(fold.endSeq) > cursor
    ) {
      grown = i;
      break;
    }
  }
  if (grown !== -1) return grown;
  return folds.findIndex((fold) => BigInt(fold.opening.seq) > cursor);
}

// ---- Bodies ---------------------------------------------------------------------------

/**
 * One half of the exchange.
 *
 * A half whose bytes are a recorded model stream carries the REASSEMBLY —
 * the message those bytes were — and no text at all. The wire is the
 * transport; `get_run_frame_body` answers it byte for byte when somebody asks
 * for it. Every other half carries its text as it always did.
 */
async function half(
  bodies: Pick<EvidenceStore, "getBody" | "getAssembly">,
  scope: RunScope,
  frame: RunFrame | null,
  textMax: number,
  outputRate: (frame: RunFrame) => number | null,
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
    return { ...base, text: null, truncated: false, assembly: null };
  }
  const stored = await bodies.getBody(scope, bodyRef);
  if (digestBytes(stored.bytes) !== bodyDigest) {
    return { ...base, text: null, truncated: false, assembly: null };
  }
  let text: string;
  try {
    text = decoder.decode(stored.bytes);
  } catch {
    return { ...base, text: null, truncated: false, assembly: null };
  }
  const assembly = await readAssembly(bodies, scope, bodyRef, text, frame);
  if (assembly !== null) {
    return {
      ...base,
      text: null,
      truncated: false,
      assembly: assemblyView(assembly, outputRate(frame)),
    };
  }
  return text.length > textMax
    ? { ...base, text: text.slice(0, textMax), truncated: true, assembly: null }
    : { ...base, text, truncated: false, assembly: null };
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

/**
 * A turn boundary's own body, read as the half it is. The fold keeps a turn
 * boundary out of both slots because it is not a step (`foldTranscript`'s
 * `open()`), and that is right for pairing calls. It also meant the prompt a
 * turn opened with, which the recorder kept in full on `turn_start`, reached
 * no half and so no page: every run read as if nobody had typed anything.
 *
 * The prompt is what went out, so it is the `request`; a `turn_end` reply is
 * what came back, so it is the `response`. A step half the fold already
 * placed is never displaced, and a boundary with no retained body adds
 * nothing.
 */
const BOUNDARY_HALF: Readonly<Record<string, "request" | "response">> = {
  turn_start: "request",
  turn_end: "response",
};

export function boundaryHalves(fold: TranscriptFold): {
  request: RunFrame | null;
  response: RunFrame | null;
} {
  const { opening } = fold;
  const slot = BOUNDARY_HALF[opening.type];
  if (slot === undefined || opening.body.bodyRef === null) {
    return { request: fold.request, response: fold.response };
  }
  return {
    request: fold.request ?? (slot === "request" ? opening : null),
    response: fold.response ?? (slot === "response" ? opening : null),
  };
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
    let observedUsage = false;
    for (const frame of read.frames) {
      if (frame.usageObserved) observedUsage = true;
      else if (observedUsage && frame.type === "llm_call") frame.usage = null;
    }
    const frames = filterFramesByKind(read.frames, input.kinds);
    const folds = foldTranscript(frames, input.zoom);
    // Turns are counted over every frame of the run, so a chip filter never
    // renumbers them: turn 2 is turn 2 whichever kinds the page shows.
    const ordinals = turnOrdinals(read.frames);
    const turnOf = new Map(
      read.frames.map((frame, i) => [frame.seq, ordinals[i] ?? null]),
    );

    // Cumulative cost is a prefix over every frame of the run (§8.4), before
    // any chip filter. Building it from the filtered folds understated spend
    // whenever a costly model call was hidden and a later tool entry showed.
    const costThrough = new Map<string, number | null>();
    let running: number | null = null;
    for (const frame of read.frames) {
      running =
        frame.costMicros === null ? running : (running ?? 0) + frame.costMicros;
      costThrough.set(frame.seq, running);
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
    // Read once for the page, not once per block: a block's cost is the
    // model's output rate applied to its apportioned share.
    const book = await deps.priceBook(ctx.orgId);
    const outputRate = (frame: RunFrame): number | null => {
      const model = frame.identity.model;
      if (model === null) return null;
      const entry = resolvePriceEntry(book, {
        orgId: ctx.orgId,
        modelId: model,
        tokenClass: "output",
        at: frame.observedAt,
      });
      return entry === null ? null : Number(entry.microsPerMillion);
    };
    const halves = await mapConcurrent(page, BODY_CONCURRENCY, async (fold) => {
      const { request, response } = boundaryHalves(fold);
      return {
        request: await half(deps.bodies, scope, request, textMax, outputRate),
        response: await half(deps.bodies, scope, response, textMax, outputRate),
      };
    });

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
        callId: opening.identity.callId,
        usage: fold.usage ?? null,
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
        cumulativeCost: cost(costThrough.get(fold.endSeq) ?? null),
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
  priceBook: (orgId) => loadPriceBookInTenantScope({ orgId }),
});
