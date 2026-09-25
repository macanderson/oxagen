// `get_run_transcript`: a run read as a transcript at one zoom level
// (Mission Control spec §8.4, §14; ADR-058).
//
// The frames come from the run reader (lib/run-read.ts) and fold into entries
// with the one transcript fold, `foldTranscript` (@oxagen/run-ledger,
// ADR-182). The chips the caller pressed then narrow the entries
// (`filterFoldsByKind`), so a filtered read shows the same steps as an
// unfiltered one. Each entry's two halves (what went out and what came back)
// have their bodies read from the evidence store, decoded as UTF-8 and cut at
// the contract's text cap.
//
// Three things are computed over the whole run and not over the page: the
// cumulative cost, which is a prefix sum from the run's first frame (§8.4),
// the elapsed time, which is measured from the run's recorded start, and the
// turn each entry falls in, which the fold counts over every frame so a chip
// never renumbers the turns. A page that computed any of them from its own
// first entry would restate the run's cost, clock and turns as the page's,
// which is wrong on every page but the first.
//
// A wrapped run's subagents record on chains of their own, each numbered from
// 0. The read takes every chain under the root and places each one after the
// `subagent_start` that spawned it, so an entry from a subagent carries
// `subagent` and its halves carry `sessionUuid`: its `seq` names a frame only
// together with that chain. Pages are therefore cut on each frame's position
// in the run as read, and a cursor names its frames as `<seq>` on the run's
// own chain or `<session uuid>:<seq>` on a subagent's (`TranscriptCursor`).
//
// Bodies are read a few at a time; a body that is not text, or that no longer
// hashes to its recorded digest, leaves its half with `text: null` rather than
// with bytes the record does not vouch for. So does a body the store cannot
// answer at all: one missing object must not blank the whole page.
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
  filterFoldsByKind,
  foldTranscript,
  frameKey,
  type RunFrame,
  type TranscriptFold,
  withoutDuplicateModelCalls,
} from "@oxagen/run-ledger";
import type { EvidenceStore } from "@oxagen/run-ledger/evidence-store";
import { evidenceStore } from "@oxagen/run-ledger/evidence-store";
import {
  loadPriceBookSliceInTenantScope,
  type PriceBook,
  type PriceBookSlice,
  resolvePriceEntry,
} from "@oxagen/billing";
import { assemblyView, readAssembly } from "./lib/transcript-assembly";
import { digestBytes } from "@oxagen/tacho";
import { logger } from "./logger";
import {
  invalidCursor,
  microsString,
  runScope,
  type RunScope,
} from "./run.list";
import {
  defaultRunReadDeps,
  readRunFrames,
  resolveRun,
  startCursorSeq,
  type RunReadDeps,
  withoutLateReports,
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
   * The rows of the organization's price book that could price the page's
   * frames, read once per page. A block's cost is its share of the message's
   * output tokens at the model's output rate; a model the book prices no
   * output for leaves every block's cost null rather than drawing a zero.
   *
   * The slice is the page's models over the page's span, never the whole
   * book: the whole history is tens of thousands of rows, and a transcript
   * page is one of the reads that ran the API out of heap (#4202).
   *
   * `get_run_transcript` is a scoped capability serving one organization, so
   * the default reads the book inside the caller's tenant scope. It used to
   * take the system connection, which made every nonempty transcript page an
   * unscoped access in the record for a read that is as ordinary as a page
   * view (#3526).
   */
  priceBook: (slice: PriceBookSlice) => Promise<PriceBook>;
};

const decoder = new TextDecoder("utf-8", { fatal: true });

// ---- Cursor ---------------------------------------------------------------------------

/**
 * Where a reader stands in a transcript: two frames, each named by `frameKey`
 * (`<seq>` on the run's own chain, `<session uuid>:<seq>` on a subagent's).
 *
 * `through` opens the last entry the reader was sent in fold order. The next
 * page starts at the entry after it. `high` is the latest frame any page has
 * delivered. An entry at or before `through` whose last frame now lies past
 * `high` has grown since it was sent (a turn that gained a step, a tool call
 * that gained its result), and is sent once more with what it gained.
 *
 * One frame could not do both jobs. An entry's range can overlap the next
 * one's (parallel tool calls fold `start A, start B, done A, done B` into A
 * over 1..3 and B over 2..4), so a single end position cannot say which
 * entries were sent. The single-frame cursor that did re-sent a grown entry
 * together with every entry after it, and left the cursor where it was, so
 * each read of a live run returned the same page again (#4048).
 */
export interface TranscriptCursor {
  through: string;
  high: string;
}

export function encodeTranscriptCursor(cursor: TranscriptCursor): string {
  return Buffer.from(`t:${cursor.through},${cursor.high}`, "utf8").toString(
    "base64url",
  );
}

const CHAIN_KEY =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d{1,19})$/i;

function decodeKey(key: string): string | null {
  if (key === TACHO_START) return key;
  if (CHAIN_KEY.test(key)) return key.toLowerCase();
  return DECIMAL.test(key) && key.length <= 19 ? key : null;
}

/**
 * The position a cursor names, or null for a cursor this handler did not
 * write. A cursor issued before `high` existed names one frame, the last one
 * its page held (`t:<key>`), and reads as both halves.
 */
export function decodeTranscriptCursor(raw: string): TranscriptCursor | null {
  const text = Buffer.from(raw, "base64url").toString("utf8");
  if (!text.startsWith("t:")) return null;
  const parts = text.slice(2).split(",");
  if (parts.length > 2) return null;
  const through = decodeKey(parts[0] as string);
  const high = parts.length === 2 ? decodeKey(parts[1] as string) : through;
  if (through === null || high === null) return null;
  return { through, high };
}

/**
 * The position in `frames` a cursor's frame holds, or the position just
 * before the next frame of its chain when that frame is no longer shown (a
 * model call's copy that a richer one replaced). -1 reads from the start.
 */
export function cursorPosition(
  frames: readonly RunFrame[],
  key: string,
): number {
  if (key === TACHO_START) return -1;
  const exact = frames.findIndex((frame) => frameKey(frame) === key);
  if (exact !== -1) return exact;
  const chained = CHAIN_KEY.exec(key);
  const session = chained ? (chained[1] as string).toLowerCase() : null;
  const seq = BigInt(chained ? (chained[2] as string) : key);
  const sameChain = (frame: RunFrame) =>
    (frame.chain?.sessionUuid ?? null) === session;
  const next = frames.findIndex(
    (frame) => sameChain(frame) && BigInt(frame.seq) > seq,
  );
  if (next !== -1) return next - 1;
  // Nothing of that chain lies past the cursor: resume after its last frame.
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const frame = frames[i];
    if (frame !== undefined && sameChain(frame)) return i;
  }
  // A chain this read does not hold. The run's own chain with no frames
  // reads from the start; a subagent chain past the frame cap has nothing
  // this read can resume into.
  return session === null ? -1 : frames.length - 1;
}

/** An entry's extent: the positions of its opening and last frames in the run. */
export interface FoldSpan {
  open: number;
  end: number;
}

/** What one page sends, and where the reader stands after it. */
export interface TranscriptPagePlan {
  /** Fold indexes, in the order sent: grown entries first, then new ones. */
  indexes: number[];
  /** The last fold index sent in fold order; -1 before the first. */
  through: number;
  /** The latest frame position delivered; -1 before the first. */
  high: number;
}

/**
 * The folds a page sends after `cursor` (fold index and frame position, as
 * `TranscriptCursor` describes), at most `limit` of them.
 *
 * A grown entry is sent once per growth: after the page, `high` covers its new
 * last frame, so the next read finds it unchanged. Several grown entries are
 * sent in the order their last frames landed, so a page cut short by `limit`
 * leaves only entries that end past the new `high`, and the next page sends
 * them. New entries fill whatever room the grown ones leave.
 */
export function planTranscriptPage(
  folds: readonly FoldSpan[],
  cursor: { through: number; high: number } | null,
  limit: number,
): TranscriptPagePlan {
  const through = cursor?.through ?? -1;
  let high = cursor?.high ?? -1;
  const grown: number[] = [];
  for (let i = 0; i <= through && i < folds.length; i += 1) {
    const fold = folds[i] as FoldSpan;
    if (fold.end > high) grown.push(i);
  }
  grown.sort((a, b) => (folds[a] as FoldSpan).end - (folds[b] as FoldSpan).end);
  const resent = grown.slice(0, limit);
  const room = limit - resent.length;
  const fresh: number[] = [];
  for (let i = through + 1; i < folds.length && fresh.length < room; i += 1) {
    fresh.push(i);
  }
  const indexes = [...resent, ...fresh];
  for (const i of indexes) high = Math.max(high, (folds[i] as FoldSpan).end);
  return { indexes, through: fresh.at(-1) ?? through, high };
}

/**
 * The fold index `key` opens, or when no fold opens there any longer (its
 * opening frame was a model call's copy a richer one replaced), the last fold
 * that opens at or before the frame's position.
 */
function foldThrough(
  spans: readonly FoldSpan[],
  openKeys: readonly string[],
  shown: readonly RunFrame[],
  key: string,
): number {
  const exact = openKeys.indexOf(key);
  if (exact !== -1) return exact;
  const position = cursorPosition(shown, key);
  let through = -1;
  for (let i = 0; i < spans.length; i += 1) {
    if ((spans[i] as FoldSpan).open <= position) through = i;
  }
  return through;
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
    ...(frame.chain === undefined
      ? {}
      : { sessionUuid: frame.chain.sessionUuid }),
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
  const unread = { ...base, text: null, truncated: false, assembly: null };
  // One body the store cannot answer (an object gone missing, a key id this
  // deployment no longer holds, a transient read failure) leaves its own half
  // unread. It must not fail the page: every other half is still readable,
  // and the Policy, Context and stats tabs read through this same page.
  let stored: Awaited<ReturnType<typeof bodies.getBody>>;
  try {
    stored = await bodies.getBody(scope, bodyRef);
  } catch (err) {
    logger.warn(
      { err, seq: frame.seq, type: frame.type, bytesRef: bodyRef },
      "get_run_transcript: a frame body could not be read; its half is shown without text",
    );
    return unread;
  }
  if (digestBytes(stored.bytes) !== bodyDigest) return unread;
  let text: string;
  try {
    text = decoder.decode(stored.bytes);
  } catch {
    return unread;
  }
  let assembly: Awaited<ReturnType<typeof readAssembly>>;
  try {
    assembly = await readAssembly(bodies, scope, bodyRef, text, frame);
  } catch (err) {
    logger.warn(
      { err, seq: frame.seq, type: frame.type, bytesRef: bodyRef },
      "get_run_transcript: a frame's reassembly could not be read; its half is shown without text",
    );
    return unread;
  }
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
 * The part of the price book a page's blocks are priced from: the models of
 * the frames `outputRate` is asked about, which are the request and response
 * halves of each fold, from the earliest of those frames to the latest.
 */
export function pagePriceSlice(
  orgId: string,
  page: readonly TranscriptFold[],
): PriceBookSlice {
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  const models = new Set<string>();
  for (const fold of page) {
    for (const frame of [fold.request, fold.response]) {
      if (frame === null || frame.identity.model === null) continue;
      models.add(frame.identity.model);
      const at = frame.observedAt.getTime();
      if (at < from) from = at;
      if (at > to) to = at;
    }
  }
  if (models.size === 0) {
    const epoch = new Date(0);
    return { orgId, models: [], from: epoch, to: epoch };
  }
  return { orgId, models: [...models], from: new Date(from), to: new Date(to) };
}

/**
 * The reasoning effort the fold's model call ran at: the first of its frames
 * that recorded one. Null where none did, which is every ledger frame and
 * every wrapped frame from a harness that does not report it.
 */
function entryEffort(fold: TranscriptFold): string | null {
  for (const frame of [fold.opening, fold.request, fold.response]) {
    const effort = frame?.identity.effort;
    if (effort !== undefined && effort !== "") return effort;
  }
  return null;
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
    // The run's own chain and every subagent chain under it, each spliced in
    // where it was spawned (`readRunFrames`).
    const read = await readRunFrames(deps, run, TRANSCRIPT_FRAME_CAP);
    // Once a chain's model calls are observed by the proxy, the harness's own
    // report of the same calls counts neither its tokens nor its cost.
    withoutLateReports(read.frames);
    // One model call reported by several sources is one step
    // (`withoutDuplicateModelCalls`): a proxied call drew twice.
    const shown = withoutDuplicateModelCalls(read.frames);
    // The fold runs over every frame, then the chips narrow its entries, so
    // a filtered read shows the same steps, turns and turn numbers as an
    // unfiltered one (ADR-182).
    const folds = filterFoldsByKind(
      foldTranscript(shown, input.zoom),
      input.kinds,
    );

    // Cumulative cost is a prefix over every frame of the run (§8.4), before
    // any chip filter. Building it from the filtered folds understated spend
    // whenever a costly model call was hidden and a later tool entry showed.
    const costThrough = new Map<RunFrame, number | null>();
    let running: number | null = null;
    for (const frame of shown) {
      running =
        frame.costMicros === null ? running : (running ?? 0) + frame.costMicros;
      costThrough.set(frame, running);
    }

    // A sealed run answers no cursor once the page holds every fold left. A
    // live run keeps a resume point even when caught up, so the next read can
    // pick up frames that have not landed yet.
    const live = run.item.status === "live";
    const startKey = startCursorSeq(run);

    // Pages are cut on each frame's position in the run as read, not on its
    // `seq`: a subagent's chain is numbered from 0 like the root's, so a
    // sequence alone no longer orders the frames of a run. The fold states
    // each entry's span in those positions.
    const spans = folds.map((fold) => fold.span);
    const plan = planTranscriptPage(
      spans,
      after === null
        ? null
        : {
            through: foldThrough(
              spans,
              folds.map((fold) => frameKey(fold.opening)),
              shown,
              after.through,
            ),
            high: cursorPosition(shown, after.high),
          },
      input.limit,
    );
    const page = plan.indexes.map((i) => folds[i] as TranscriptFold);
    // The cursor names frames by key, so it survives a later read that holds
    // more frames, or hides one this read showed.
    const nextCursor = (): string =>
      encodeTranscriptCursor({
        through:
          plan.through === -1
            ? (after?.through ?? startKey)
            : frameKey((folds[plan.through] as TranscriptFold).opening),
        high:
          plan.high === -1
            ? (after?.high ?? startKey)
            : frameKey(shown[plan.high] as RunFrame),
      });
    const more = plan.through + 1 < folds.length;
    const cursor = live || more ? nextCursor() : null;
    if (page.length === 0) {
      return {
        zoom: input.zoom,
        kinds: input.kinds,
        entries: [],
        cursor,
        complete: read.complete,
      };
    }
    const runStartedAt = Date.parse(run.item.startedAt);

    // A folded zoom carries an excerpt; `everything` carries the whole body.
    const textMax = transcriptTextMax(input.zoom as TranscriptZoom);
    // Read once for the page, not once per block: a block's cost is the
    // model's output rate applied to its apportioned share.
    const book = await deps.priceBook(pagePriceSlice(ctx.orgId, page));
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
    const halves = await mapConcurrent(
      page,
      BODY_CONCURRENCY,
      async (fold) => ({
        request: await half(
          deps.bodies,
          scope,
          fold.request,
          textMax,
          outputRate,
        ),
        response: await half(
          deps.bodies,
          scope,
          fold.response,
          textMax,
          outputRate,
        ),
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
        ...(opening.chain === undefined
          ? {}
          : {
              subagent: {
                sessionUuid: opening.chain.sessionUuid,
                id: opening.chain.subagentId,
                type: opening.chain.subagentType,
                spawnCallId: opening.chain.spawnToolUseId,
              },
            }),
        at: opening.observedAt.toISOString(),
        elapsedMs: elapsedMs(runStartedAt, opening.observedAt),
        kind: fold.kind,
        type: opening.type,
        label: opening.summary,
        callId: opening.identity.callId,
        target: opening.identity.target ?? null,
        effort: entryEffort(fold),
        usage: fold.usage ?? null,
        kinds: [...fold.kinds],
        request: pair.request,
        response: pair.response,
        decision:
          fold.decision === null
            ? null
            : {
                seq: fold.decision.seq,
                ...(fold.decision.sessionUuid === undefined
                  ? {}
                  : { sessionUuid: fold.decision.sessionUuid }),
                decision: fold.decision.decision,
                type: fold.decision.type,
                source: fold.decision.source,
                at: fold.decision.at.toISOString(),
              },
        frames: fold.frames,
        turn: fold.turn,
        cost: cost(fold.costMicros),
        cumulativeCost: cost(costThrough.get(fold.last) ?? null),
      };
    });

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
  priceBook: loadPriceBookSliceInTenantScope,
});
