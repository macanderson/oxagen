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
// Every fact a reader would otherwise derive from an entry's frames is the
// fold's, and goes out as a field of the entry: its key, parent, node,
// outcome, gates, subject, family and duration. Three need bytes the fold
// does not read, so the bodies are read here and the rule that needs them
// runs over what was read: which prompts and replies have nothing to show,
// and which reply repeats words the reader was just shown (`markWords`, over
// the words `readWords` reads for the whole run); a recall entry's items,
// parsed from the body it kept (`recallOf`); and each reply's `tool_use`
// blocks, which name the tool step that recorded the call (`toolUseClaimer`)
// and what came back. `counts` counts the run's entries at the zoom, and
// `figures` the run's steps, calls and time (`transcriptFigures`), whatever
// the chips.
//
// A `query` narrows the entries the chips kept (`searchFolds`). Label, tool
// and target are matched on the entry; each half of an entry they do not
// match is read from the evidence store, at most TRANSCRIPT_SEARCH_HALF_MAX
// halves per read, and `search.unsearched` counts the halves the read could
// not look inside. A read from a cursor searches only the entries it can
// still send (`unsentFolds`), so paging through a search reads each body
// once rather than once per page.
//
// `counts.frames` carries the policy and recall counts at `everything`, one
// entry per frame (`frameCounts`), at every zoom: the Run page reads `steps`
// and takes its tab badges from there, with no second read of the run.
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
  TRANSCRIPT_SEARCH_HALF_MAX,
  TRANSCRIPT_TEXT_MAX,
  transcriptTextMax,
  type TranscriptEntry,
  type TranscriptEntryBody,
  type TranscriptRecallView,
  type TranscriptZoom,
} from "@oxagen/oxagen/contracts/run.transcript.get";
import {
  filterFoldsByKind,
  frameCounts,
  frameFolds,
  frameKey,
  markWords,
  type MessageAssembly,
  type RecallBody,
  recallOf,
  type RunFrame,
  stepFolds,
  toolFamilyOf,
  toolUseClaimer,
  TRANSCRIPT_KINDS,
  transcriptCounts,
  transcriptFigures,
  type TranscriptDecision,
  type TranscriptFold,
  type TranscriptWords,
  turnFolds,
  readTranscriptFrames,
  TRANSCRIPT_FRAME_CAP,
  wordsHalf,
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
import { mapConcurrent } from "./lib/map-concurrent";
import { searchableText, searchFolds } from "./lib/transcript-search";
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
  resolveRun,
  runChainReads,
  startCursorSeq,
  type RunReadDeps,
} from "./lib/run-read";
/**
 * The largest recall body read to parse what it put in front of the model. A
 * steering manifest lists at most 2,000 items; a body past this is not one,
 * and the recall falls back to the count the frame recorded.
 */
const RECALL_BODY_MAX = 1_048_576;
/** Bodies read at once. */
const BODY_CONCURRENCY = 8;
/**
 * The most halves one read reads for their words (`readWords`): about three
 * per turn, the prompt, the reply and the model step before the reply. An
 * entry past it keeps what the fold said about it.
 */
export const TRANSCRIPT_WORDS_HALF_MAX = 2_000;

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
 * The folds a page read from a cursor can still send, the cursor given as
 * frame positions in the run as read (`cursorPosition`): those that open
 * after its `through` frame, and those at or before it whose last frame lies
 * past `high`, which `planTranscriptPage` sends again. Every other fold was
 * sent and has not changed since, so no page from this cursor on sends it.
 * Null reads from the start, where every fold can be sent.
 */
export function unsentFolds<T extends { span: FoldSpan }>(
  folds: readonly T[],
  cursor: { throughAt: number; highAt: number } | null,
): readonly T[] {
  if (cursor === null) return folds;
  return folds.filter(
    (fold) =>
      fold.span.open > cursor.throughAt || fold.span.end > cursor.highAt,
  );
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
 * A half's kept body as the record vouches for it: the message a recorded
 * model stream was (`assembly`), or else its text. Null when no body was
 * kept, the store cannot answer, the bytes no longer hash to the recorded
 * digest, or they are not UTF-8 text.
 *
 * One body the store cannot answer (an object gone missing, a key id this
 * deployment no longer holds, a transient read failure) leaves its own half
 * unread. It must not fail the read: every other half is still readable, and
 * the Policy, Context and stats tabs read through this same handler.
 */
async function readBody(
  bodies: Pick<EvidenceStore, "getBody" | "getAssembly">,
  scope: RunScope,
  frame: RunFrame,
): Promise<{ text: string; assembly: MessageAssembly | null } | null> {
  const { bodyRef, bodyDigest } = frame.body;
  if (bodyRef === null || bodyDigest === null) return null;
  let stored: Awaited<ReturnType<typeof bodies.getBody>>;
  try {
    stored = await bodies.getBody(scope, bodyRef);
  } catch (err) {
    logger.warn(
      { err, seq: frame.seq, type: frame.type, bytesRef: bodyRef },
      "get_run_transcript: a frame body could not be read; its half is shown without text",
    );
    return null;
  }
  if (digestBytes(stored.bytes) !== bodyDigest) return null;
  let text: string;
  try {
    text = decoder.decode(stored.bytes);
  } catch {
    return null;
  }
  try {
    return {
      text,
      assembly: await readAssembly(bodies, scope, bodyRef, text, frame),
    };
  } catch (err) {
    logger.warn(
      { err, seq: frame.seq, type: frame.type, bytesRef: bodyRef },
      "get_run_transcript: a frame's reassembly could not be read; its half is shown without text",
    );
    return null;
  }
}

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
  const body = await readBody(bodies, scope, frame);
  if (body === null)
    return { ...base, text: null, truncated: false, assembly: null };
  if (body.assembly !== null) {
    return {
      ...base,
      text: null,
      truncated: false,
      assembly: assemblyView(body.assembly, outputRate(frame)),
    };
  }
  const { text } = body;
  return text.length > textMax
    ? { ...base, text: text.slice(0, textMax), truncated: true, assembly: null }
    : { ...base, text, truncated: false, assembly: null };
}

/**
 * The words each entry of `needed` shows a reader, for `markWords`: read the
 * way `half` reads the half a reader is shown, whole rather than cut at the
 * zoom's cap. A prompt or reply shows the text of its half, and none when the
 * half is a recorded model stream, which a reader is shown as a message with
 * no text. A model step shows the last text block of its reply, or the
 * reply's text where the recorder assembled none.
 *
 * At most `halfMax` halves are read, in the order given. An entry past the
 * bound is left out of the answer, so `markWords` leaves it as the fold said.
 * A half with no kept body shows no words and costs no read.
 */
export async function readWords(
  bodies: Pick<EvidenceStore, "getBody" | "getAssembly">,
  scope: RunScope,
  needed: readonly TranscriptFold[],
  halfMax: number = TRANSCRIPT_WORDS_HALF_MAX,
): Promise<Map<TranscriptFold, TranscriptWords>> {
  const words = new Map<TranscriptFold, TranscriptWords>();
  const reads: { fold: TranscriptFold; frame: RunFrame }[] = [];
  for (const fold of needed) {
    const frame = wordsHalf(fold);
    if (frame === null || frame.body.bodyRef === null) words.set(fold, null);
    else if (reads.length < halfMax) reads.push({ fold, frame });
  }
  const said = await mapConcurrent(
    reads,
    BODY_CONCURRENCY,
    async ({ fold, frame }): Promise<TranscriptWords> => {
      const body = await readBody(bodies, scope, frame);
      if (body === null) return null;
      if (body.assembly === null) return body.text;
      if (fold.node !== "model") return null;
      const blocks = body.assembly.blocks.filter(
        (block) => block.kind === "text" && block.text.trim() !== "",
      );
      const last = blocks[blocks.length - 1];
      return last?.kind === "text" ? last.text : null;
    },
  );
  reads.forEach(({ fold }, i) => words.set(fold, said[i] ?? null));
  return words;
}

/**
 * A recall frame's whole body as text, for `recallOf` to parse, or why there
 * is none: the frame kept no body, the body cannot be read or no longer
 * hashes to its digest, or it is larger than any manifest. A half's text is
 * cut at the zoom's cap, and a manifest cut short does not parse, so this
 * reads the body on its own.
 */
async function recallBody(
  bodies: Pick<EvidenceStore, "getBody">,
  scope: RunScope,
  frame: RunFrame,
): Promise<RecallBody> {
  const { bodyRef, bodyDigest } = frame.body;
  if (bodyRef === null || bodyDigest === null) return { state: "unretained" };
  try {
    const stored = await bodies.getBody(scope, bodyRef);
    if (stored.bytes.byteLength > RECALL_BODY_MAX) return { state: "unlisted" };
    if (digestBytes(stored.bytes) !== bodyDigest)
      return { state: "unreadable" };
    return { state: "kept", text: decoder.decode(stored.bytes) };
  } catch (err) {
    logger.warn(
      { err, seq: frame.seq, type: frame.type, bytesRef: bodyRef },
      "get_run_transcript: a recall body could not be read; its recall falls back to the recorded count",
    );
    return { state: "unreadable" };
  }
}

/** A tool call's result from a `tool_result` block, by the call it answers. */
type ToolResults = ReadonlyMap<string, { ok: boolean; summary: string }>;

/** Every `tool_result` block the page's halves hold, by the call key it answers. */
export function toolResultsOf(
  halves: readonly (TranscriptEntryBody | null)[],
): ToolResults {
  const results = new Map<string, { ok: boolean; summary: string }>();
  for (const half of halves) {
    for (const block of half?.assembly?.blocks ?? []) {
      if (block.kind === "tool_result")
        results.set(block.forId, { ok: block.ok, summary: block.summary });
    }
  }
  return results;
}

/**
 * `half` with each `tool_use` block's `stepKey` (the tool step that recorded
 * the call, from `claim`), `result` (what the page's `tool_result` blocks say
 * came back) and `family` (`toolFamilyOf` its name). A half with no assembly
 * is returned as it is.
 */
export function withToolUseFacts(
  half: TranscriptEntryBody | null,
  claim: (
    uses: { name: string; callKey: string | null }[],
  ) => (string | null)[],
  results: ToolResults,
): TranscriptEntryBody | null {
  const blocks = half?.assembly?.blocks;
  if (half === null || half.assembly === null || blocks === undefined)
    return half;
  const uses = blocks.flatMap((block) =>
    block.kind === "tool_use" ? [block] : [],
  );
  if (uses.length === 0) return half;
  const keys = claim(
    uses.map((use) => ({ name: use.name, callKey: use.callKey })),
  );
  const stepKeys = new Map(uses.map((use, i) => [use, keys[i] ?? null]));
  return {
    ...half,
    assembly: {
      ...half.assembly,
      blocks: blocks.map((block) =>
        block.kind === "tool_use"
          ? {
              ...block,
              stepKey: stepKeys.get(block) ?? null,
              result:
                block.callKey === null
                  ? null
                  : (results.get(block.callKey) ?? null),
              family: toolFamilyOf(block.name),
            }
          : block,
      ),
    },
  };
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

/** A decision as the contract carries it. */
function decisionView(decision: TranscriptDecision) {
  return {
    seq: decision.seq,
    ...(decision.sessionUuid === undefined
      ? {}
      : { sessionUuid: decision.sessionUuid }),
    decision: decision.decision,
    type: decision.type,
    source: decision.source,
    harness: decision.harness,
    at: decision.at.toISOString(),
  };
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
    // where it was spawned; late harness reports uncounted; each model call
    // once. `run.summarize` reads the same frames (`readTranscriptFrames`).
    const read = await readTranscriptFrames(
      runChainReads(deps, run),
      TRANSCRIPT_FRAME_CAP,
    );
    const shown = read.frames;
    // The fold runs over every frame, then the chips narrow its entries, so
    // a filtered read shows the same steps, turns and turn numbers as an
    // unfiltered one (ADR-182).
    //
    // The `steps` fold is taken at every zoom: `turns` groups it, and a model
    // reply's `tool_use` blocks are claimed by its tool steps.
    const steps = stepFolds(shown);
    const all =
      input.zoom === "steps"
        ? steps
        : input.zoom === "turns"
          ? turnFolds(shown, steps)
          : frameFolds(shown);
    // Which prompts and replies show nothing, and which reply repeats words
    // the reader was just shown, need their words. They are read over the
    // whole run, before the counts, so an entry that draws no row counts
    // nowhere. A turn is a group, and nothing in it is settled this way.
    if (input.zoom !== "turns")
      await markWords(all, (needed) => readWords(deps.bodies, scope, needed));
    // Counted over every entry at the zoom, whatever the chips or query, so
    // a chip's count and the rows it shows agree. The frames' own policy and
    // recall counts ride every read, so a reader at `steps` never reads
    // `everything` for them.
    const counts = {
      ...transcriptCounts(all, TRANSCRIPT_KINDS),
      frames: frameCounts(shown),
    };
    // The page's figures, over the steps of every frame read (ADR-182).
    const figures = transcriptFigures(shown, steps);
    const chipped = filterFoldsByKind(all, input.kinds);
    // Where the reader stands, as frame positions in the run as read.
    const at =
      after === null
        ? null
        : {
            throughAt: cursorPosition(shown, after.through),
            highAt: cursorPosition(shown, after.high),
          };
    // A query narrows what the chips kept, and the matches page on the same
    // cursor as any other read. Each half is searched as far as a full read
    // carries it, so a match is one a reader can see. A page read from a
    // cursor searches only the entries it can still send (`unsentFolds`):
    // the pages before it searched the rest, and a search reads bodies.
    const found =
      input.query === undefined
        ? null
        : await searchFolds(
            unsentFolds(chipped, at),
            input.query,
            async (frame) => {
              const body = await half(
                deps.bodies,
                scope,
                frame,
                TRANSCRIPT_TEXT_MAX,
                () => null,
              );
              return body === null ? null : searchableText(body);
            },
            {
              halfMax: TRANSCRIPT_SEARCH_HALF_MAX,
              concurrency: BODY_CONCURRENCY,
            },
          );
    const folds = found?.folds ?? chipped;
    const search = found === null ? {} : { search: found.search };

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
    const through =
      after === null || at === null
        ? -1
        : foldThrough(
            spans,
            folds.map((fold) => frameKey(fold.opening)),
            shown,
            after.through,
          );
    const plan = planTranscriptPage(
      spans,
      at === null ? null : { through, high: at.highAt },
      input.limit,
    );
    const page = plan.indexes.map((i) => folds[i] as TranscriptFold);
    // The cursor names frames by key, so it survives a later read that holds
    // more frames, or hides one this read showed. The reader's place in fold
    // order moves only when the page sends a new entry: a page of grown
    // entries alone leaves `through` where the cursor had it, which a fold
    // before it (the one `foldThrough` falls back to) would move backward.
    const nextCursor = (): string =>
      encodeTranscriptCursor({
        through:
          plan.through === through
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
        counts,
        figures,
        ...search,
      };
    }
    const runStartedAt = Date.parse(run.item.startedAt);

    // A folded zoom carries an excerpt and `everything` the whole body,
    // unless the caller asked for one or the other.
    const textMax = transcriptTextMax(input.zoom as TranscriptZoom, input.text);
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
    // What each recall entry put in front of the model, parsed here from the
    // body it kept (ADR-182), so no reader parses a manifest of its own.
    const recalls = await mapConcurrent(
      page,
      BODY_CONCURRENCY,
      async (fold): Promise<TranscriptRecallView | null> =>
        fold.node === "recall"
          ? recallOf(
              fold.opening,
              await recallBody(deps.bodies, scope, fold.opening),
            )
          : null,
    );
    // Each reply's `tool_use` blocks name the tool step that recorded the
    // call, and what came back, so a reader draws each call once.
    const claimer = toolUseClaimer(steps);
    const results = toolResultsOf(
      halves.flatMap((pair) => [pair.request, pair.response]),
    );

    const entries: TranscriptEntry[] = page.map((fold, i) => {
      const { opening } = fold;
      const pair = halves[i] as {
        request: TranscriptEntryBody | null;
        response: TranscriptEntryBody | null;
      };
      const claim = (uses: { name: string; callKey: string | null }[]) =>
        claimer(fold, uses);
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
                parentSessionUuid: opening.chain.parentSessionUuid,
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
        request: withToolUseFacts(pair.request, claim, results),
        response: withToolUseFacts(pair.response, claim, results),
        decision: fold.decision === null ? null : decisionView(fold.decision),
        frames: fold.frames,
        turn: fold.turn,
        cost: cost(fold.costMicros),
        cumulativeCost: cost(costThrough.get(fold.last) ?? null),
        key: fold.key,
        parentKey: fold.parentKey,
        node: fold.node,
        quiet: fold.quiet,
        outcome: fold.outcome,
        approvalId: fold.approvalId,
        gates: fold.gates.map(decisionView),
        subject: fold.subject,
        family: fold.family,
        model: fold.model,
        durationMs: fold.durationMs,
        echoOf: fold.echoOf,
        recall: recalls[i] ?? null,
        ...(found === null ? {} : { matches: found.matches.get(fold) }),
      };
    });

    return {
      zoom: input.zoom,
      kinds: input.kinds,
      entries,
      cursor,
      complete: read.complete,
      counts,
      figures,
      ...search,
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
