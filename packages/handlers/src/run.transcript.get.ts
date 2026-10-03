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
// the words `readWords` reads for the whole run at `steps`); a recall
// entry's items, parsed from the body it kept (`recallOf`); and each reply's
// `tool_use` blocks, which name the tool step that recorded the call
// (`toolUseClaimer`) and what came back. `counts` counts the run's entries at the zoom, and
// `figures` the run's steps, calls and time (`transcriptFigures`), whatever
// the chips.
//
// The digest of what a body says is kept per process (`WordsCache`, keyed by
// tenant, body reference and digest), because a body never changes. So a read
// reads the words of only the bodies no earlier read in the process has read.
// The cache keeps no text: every half on the page, and every half a search
// looks inside, is read from the evidence store. A read's body cost is its
// page's halves, at most one read each, plus the word bodies it has not read
// before, not the whole run's, plus at most one body per key its other reads
// taught it nothing about, to learn that erasure has not destroyed the key
// (`BodyKeys`). A body that could not be read settles nothing, so its entry
// stays as the fold said.
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
// `counts` and `figures` ride only a read from the run's first frame, the one
// read that holds the run from its start (#3823). A reader keeps the ones
// that read returned.
//
// A read from a cursor reads a window of the run, not the run again from its
// first frame. The cursor names the frame on the run's own chain that opens
// the latest turn the reader has been sent (`TranscriptWindowFrom`), and the
// window reads from there, every subagent chain spawned inside it included
// (`readTranscriptWindow`). A read with `query` set is not windowed, and a
// window that only a read of the whole run can place reads the whole run: a
// subagent chain that began before the window and has moved since, or one the
// cursor names and the window does not hold.
//
// A live run is often one long turn, so a read of a live run at `steps` also
// keeps, per process, a later start inside the turn for the next read from
// its cursor (`TailStart`, lib/transcript-tail-cache.ts, #4340): the latest
// model step the reader was sent whose frames have settled, with what the
// fold carries into it and the call keys the turn recorded before it. That
// read reads from there, and reads the turn's window instead when a frame it
// read names one of those keys, since the fold would join that frame to a
// step that opened before the tail start (`nextTailStart`).
//
// Three things belong to the whole run and not to the page: the cumulative
// cost, a prefix sum from the run's first frame (§8.4), the elapsed time,
// measured from the run's recorded start, and the turn each entry falls in,
// which the fold counts over every frame so a chip never renumbers the turns.
// A window starts on a turn's first frame and its cursor carries the run's
// turn and cost there, so a window's entries carry the run's turn and cost,
// never the window's own count of them.
//
// A subagent chain numbers its frames from 0, so a frame it records after a
// read can land before that read's cursor in fold order. Such an entry is
// neither new nor grown on the cursor's positions, and a live reader was not
// sent it until the run sealed (#4083). The cursor therefore also carries
// when the server had received every frame the reader was sent
// (`TranscriptReceipt`), and an entry with a frame received after that is sent
// again, after the grown ones and before the new ones.
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
import { CapabilityError } from "@oxagen/oxagen/kernel";
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
  bareToolName,
  countsAsError,
  filterFoldsByKind,
  frameCounts,
  frameFolds,
  frameKey,
  markWords,
  type MessageAssembly,
  type RecallBody,
  recallOf,
  replyPartsOf,
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
  turnOrdinals,
  type FrameRead,
  opensRunTurn,
  readTranscriptFrames,
  readTranscriptWindow,
  TRANSCRIPT_FRAME_CAP,
  wordsDigest,
  wordsHalf,
} from "@oxagen/run-ledger";
import {
  BodyKeyGoneError,
  BodyUnopenableError,
  type EvidenceStore,
  evidenceStore,
  parseEvidenceBodyRef,
} from "@oxagen/run-ledger/evidence-store";
import {
  loadPriceBookSliceInTenantScope,
  type PriceBook,
  type PriceBookSlice,
  resolvePriceEntry,
} from "@oxagen/billing";
import { assemblyView, readAssembly } from "./lib/transcript-assembly";
import { mapConcurrent } from "./lib/map-concurrent";
import { searchableText, searchFolds } from "./lib/transcript-search";
import {
  type BodyWords,
  createWordsCache,
  UNREADABLE,
  type WordsCache,
} from "./lib/transcript-words-cache";
import {
  createTailCache,
  type TailCache,
  type TailStart,
} from "./lib/transcript-tail-cache";
import { StorageNotFoundError } from "@oxagen/storage";
import { digestBytes } from "@oxagen/recorder";
import { logger } from "./logger";
import {
  invalidCursor,
  microsString,
  runScope,
  type RunScope,
} from "./run.list";
import { encodeFrameCursor } from "./run.get";
import {
  defaultRunReadDeps,
  resolveRun,
  type ResolvedRun,
  runChainReads,
  runChainWindowReads,
  startCursorSeq,
  type RunReadDeps,
} from "./lib/run-read";
import { assertContractRole } from "./lib/capability-role-guard";
/**
 * The largest recall body read to parse what it put in front of the model. A
 * steering manifest lists at most 2,000 items; a body past this is not one,
 * and the recall falls back to the count the frame recorded.
 */
const RECALL_BODY_MAX = 1_048_576;
/** Bodies read at once. */
const BODY_CONCURRENCY = 8;
/** The most further parts of one reply an entry carries; the contract's cap. */
const REPLY_PARTS_MAX = 256;
/**
 * The most bytes of bodies and reassemblies one read holds so that a second
 * ask for the same object is not a second read (`readEachOnce`).
 */
const BODY_HOLD_BYTES = 33_554_432;
/**
 * The most halves of one chain a read reads for their words (`readWords`):
 * about three per turn, the prompt, the reply and the model step before the
 * reply. An entry past it keeps what the fold said about it.
 *
 * The bound is per chain, so a subagent chain spliced in late cannot take a
 * slot another chain's entry already held (#4334). A read can therefore read
 * more than 2,000 halves when a run has subagents, up to the 10,000 frames
 * it folds (`TRANSCRIPT_FRAME_CAP`). A subagent chain can be as long as the
 * run's own, so a cold read of a run with subagents can read five times the
 * bodies one chain's bound allows.
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
  /**
   * The digests of what the bodies this process has read say
   * (`createWordsCache`). Omitted, the handler keeps its own, so the one
   * handler a process serves from keeps one cache for every read.
   */
  words?: WordsCache;
  /**
   * Where the next read of a live run from each cursor can start inside its
   * turn (`createTailCache`). Omitted, the handler keeps its own, like
   * `words`.
   */
  tails?: TailCache;
  /**
   * The server's clock in milliseconds, read once per read before its frames
   * to set the cursor's receipt (`TranscriptReceipt`). Omitted, `Date.now`.
   */
  now?: () => number;
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
 *
 * `received` is where the reader stands in the order the server received the
 * frames (`TranscriptReceipt`), absent on a ledger run, which has one chain.
 * `from` is where the next read's window of the run starts
 * (`TranscriptWindowFrom`), absent when the next read reads the run from its
 * first frame.
 */
export interface TranscriptCursor {
  through: string;
  high: string;
  received?: TranscriptReceipt | null;
  from?: TranscriptWindowFrom | null;
}

/**
 * Where a reader stands in the order the server received a wrapped run's
 * frames (`tacho_events.received_at`, in milliseconds since the epoch).
 *
 * Every entry with a frame received after `after` is looked at again, and one
 * the reader was not sent in that state is sent. A subagent's frame can land
 * before the cursor in fold order, so the cursor's positions cannot say it is
 * new (#4083). The server stamps one receipt time on a whole batch, so `sent`
 * counts the entries whose latest frame arrived at `after + 1` that were
 * already sent, in receipt then fold order. A page can then stop inside a
 * batch larger than itself and the next page carries on after it.
 */
export interface TranscriptReceipt {
  after: number;
  sent: number;
}

/**
 * Where the next read's window of the run starts: a frame on the run's own
 * chain, and what the run carried into that frame. A window counts its turns
 * and cost from its own first frame; these put them back on the run's count.
 */
export interface TranscriptWindowFrom {
  /** The seq of the window's first frame. */
  seq: string;
  /** The run's turn at that frame; null before the run's first turn. */
  turn: number | null;
  /** The run's cumulative cost before that frame, in micros; null before any cost. */
  cost: number | null;
  /**
   * The proxy observed a model call on the run's own chain before that
   * frame, so the harness's reports inside the window are late
   * (`withoutLateReports`).
   */
  observed: boolean;
}

/**
 * How long after its receipt time a frame can first become readable. Ingest
 * moves a chain's session row in Postgres, then stamps the batch's receipt
 * time, then inserts it into ClickHouse, so a read can miss a frame whose
 * receipt time is earlier than the read. The cursor's receipt therefore
 * trails the read by this margin, and an entry with a frame received inside
 * it is sent again on the next read.
 *
 * `insertTachoEvents` stamps the receipt before it awaits the ClickHouse
 * insert. The ClickHouse client sets no request timeout, so its 30-second
 * default applies. The host resends a batch whose insert failed, and the
 * resend carries a later stamp, which `FINAL` keeps (`ReplacingMergeTree`
 * on `received_at`). So a batch lands within 30 seconds of its stamp or
 * comes back as a later one. Sixty seconds covers that with room for the
 * server to finish a write the client stopped waiting for. It is the bound
 * batch A1 (#4384) set as `RECEIPT_OVERLAP_MS`.
 *
 * The cost is resends. Every live read sends again each entry with a frame
 * received in the minute before it, with its bodies. A live read asks for
 * the contract's largest page (`TRANSCRIPT_ENTRY_MAX`, 500), which a minute
 * of `steps` entries does not come near, so the resends do not hold new
 * entries back. A1's digest of the frames received in the last minute
 * resends only when a frame did land late. It needs every read to hold the
 * same frames, which a window of the run does not (#3823).
 */
export const RECEIPT_SETTLE_MS = 60_000;

/**
 * How far a chain's session row can run ahead of its batch's receipt time.
 * Ingest sets `last_event_at` to the time the request arrived, checks and
 * writes the batch in Postgres, and only then stamps the receipt, so the
 * row's time is earlier than the receipt by however long that work takes. A
 * window of the run counts a subagent chain as moved when its row moved
 * after the cursor's receipt less this lead (`readTranscriptWindow`). The
 * receipt already trails the read by the settle margin, so the lead covers
 * only the ingest's own work, and it does not grow with the margin.
 */
const SESSION_MOVE_LEAD_MS = 10_000;

/** The contract's cap on a cursor (`after`). */
const CURSOR_MAX = 256;

/**
 * The cursor as opaque text: `t:<through>,<high>` when it carries neither a
 * receipt nor a window, and otherwise
 * `t:<through>,<high>,<after>,<sent>,<seq>,<turn>,<cost>,<observed>` with an
 * empty field for each value it lacks. A window start the contract's cap
 * cannot carry is left out, and the next read reads the whole run.
 */
export function encodeTranscriptCursor(cursor: TranscriptCursor): string {
  const text = cursorText(cursor);
  if (text.length <= CURSOR_MAX || !cursor.from) return text;
  return cursorText({ ...cursor, from: null });
}

function cursorText({
  through,
  high,
  received = null,
  from = null,
}: TranscriptCursor): string {
  const parts = [through, high];
  if (received !== null || from !== null) {
    parts.push(
      received === null ? "" : String(received.after),
      received === null ? "" : String(received.sent),
      from === null ? "" : from.seq,
      from === null || from.turn === null ? "" : String(from.turn),
      from === null || from.cost === null ? "" : String(from.cost),
      from === null ? "" : from.observed ? "1" : "0",
    );
  }
  return Buffer.from(`t:${parts.join(",")}`, "utf8").toString("base64url");
}

const CHAIN_KEY =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d{1,19})$/i;
/** A count or a time in milliseconds: at most 15 digits, so a safe integer. */
const COUNT = /^\d{1,15}$/;
/** A cost in micros, which a credit can make negative. */
const MICROS = /^-?\d{1,15}$/;
/** The digest a `seen` receipt carries: 12 hex digits of a SHA-256. */
const SEEN_WINDOW = /^[0-9a-f]{12}$/;

function decodeKey(key: string): string | null {
  if (key === TACHO_START) return key;
  if (CHAIN_KEY.test(key)) return key.toLowerCase();
  return DECIMAL.test(key) && key.length <= 19 ? key : null;
}

/** A receipt's two fields: both empty for none, undefined when malformed. */
function decodeReceipt(
  after: string,
  sent: string,
): TranscriptReceipt | null | undefined {
  if (after === "" && sent === "") return null;
  if (!COUNT.test(after) || !COUNT.test(sent)) return undefined;
  return { after: Number(after), sent: Number(sent) };
}

/** A window start's four fields: all empty for none, undefined when malformed. */
function decodeFrom(
  seq: string,
  turn: string,
  cost: string,
  observed: string,
): TranscriptWindowFrom | null | undefined {
  if (seq === "")
    return turn === "" && cost === "" && observed === "" ? null : undefined;
  if (!DECIMAL.test(seq) || seq.length > 19) return undefined;
  if (turn !== "" && !COUNT.test(turn)) return undefined;
  if (cost !== "" && !MICROS.test(cost)) return undefined;
  if (observed !== "0" && observed !== "1") return undefined;
  return {
    seq,
    turn: turn === "" ? null : Number(turn),
    cost: cost === "" ? null : Number(cost),
    observed: observed === "1",
  };
}

/**
 * The position a cursor names, or null for a cursor this handler did not
 * write. A cursor issued before `high` existed names one frame, the last one
 * its page held (`t:<key>`), and reads as both halves. One issued before the
 * receipt and the window names two frames (`t:<through>,<high>`) and carries
 * neither.
 *
 * A cursor from the `seen` receipt that came before this one
 * (`t:<through>,<high>,<at>,<window>`, #4384) names the latest receipt time
 * its read held. It reads as a receipt the settle margin before that time,
 * the same minute A1 read back over, so the next read sends again every
 * entry with a frame received near it, and the reader replaces its copies. Its digest of those frames is checked
 * for form and then set aside. It names no window, so the next read reads the
 * whole run.
 */
export function decodeTranscriptCursor(raw: string): TranscriptCursor | null {
  const text = Buffer.from(raw, "base64url").toString("utf8");
  if (!text.startsWith("t:")) return null;
  const parts = text.slice(2).split(",");
  if (![1, 2, 4, 8].includes(parts.length)) return null;
  const through = decodeKey(parts[0] as string);
  const high = parts.length === 1 ? through : decodeKey(parts[1] as string);
  if (through === null || high === null) return null;
  if (parts.length === 4) {
    const at = parts[2] as string;
    if (!COUNT.test(at) || !SEEN_WINDOW.test(parts[3] as string)) return null;
    return {
      through,
      high,
      received: {
        after: Math.max(0, Number(at) - RECEIPT_SETTLE_MS),
        sent: 0,
      },
    };
  }
  if (parts.length !== 8) return { through, high };
  const [after, sent, seq, turn, cost, observed] = parts.slice(2) as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const received = decodeReceipt(after, sent);
  const from = decodeFrom(seq, turn, cost, observed);
  if (received === undefined || from === undefined) return null;
  return {
    through,
    high,
    ...(received === null ? {} : { received }),
    ...(from === null ? {} : { from }),
  };
}

/**
 * `b:<key>`: the opening frame of the first entry a page read `from` the end
 * or `before` a cursor sent. A read `before` it sends the entries ahead of
 * that entry. It carries no receipt: the page ahead of it is read as the run
 * stands then, whole.
 */
export function encodeBeforeCursor(key: string): string {
  return Buffer.from(`b:${key}`, "utf8").toString("base64url");
}

/** The frame a `before` cursor names, or null for one this handler did not write. */
export function decodeBeforeCursor(raw: string): string | null {
  const text = Buffer.from(raw, "base64url").toString("utf8");
  if (!text.startsWith("b:")) return null;
  return decodeKey(text.slice(2));
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

/**
 * The `get_run` cursor of the last frame on the run's own chain in `frames`,
 * or null when it holds none. A subagent's frames sit on chains of their own
 * and `get_run` reads only the run's chain, so they are passed over. The Run
 * stream opens after this frame: a reader holding the transcript is sent only
 * the frames the read did not hold, not the whole run from its first frame.
 */
export function frameCursorOf(frames: readonly RunFrame[]): string | null {
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const frame = frames[i];
    if (frame !== undefined && frame.chain === undefined)
      return encodeFrameCursor(frame.seq);
  }
  return null;
}

/**
 * An entry's extent: the positions of its opening and last frames in the run,
 * and when the server received its latest frame (`receivedOf`), null when no
 * frame carries a receipt time.
 */
export interface FoldSpan {
  open: number;
  end: number;
  received?: number | null;
}

/** What one page sends, and where the reader stands after it. */
export interface TranscriptPagePlan {
  /**
   * Fold indexes, in the order sent: grown entries first, then entries a late
   * frame changed, then new ones.
   */
  indexes: number[];
  /** The last fold index sent in fold order; -1 before the first. */
  through: number;
  /** The latest frame position delivered; -1 before the first. */
  high: number;
  /** The receipt the next page reads from; set only when the plan is given `settleAt`. */
  received?: TranscriptReceipt;
  /**
   * How many grown or late entries at or before `through` the limit left for
   * the next page. Set only when some are left. A sealed run keeps its cursor
   * while any remain, so a reader that stops on a null cursor still gets
   * them (Codex review on #4421).
   */
  unsent?: number;
}

/**
 * The folds a page sends after `cursor` (fold index, frame position and
 * receipt, as `TranscriptCursor` describes), at most `limit` of them.
 *
 * A grown entry is sent once per growth: after the page, `high` covers its new
 * last frame, so the next read finds it unchanged. Several grown entries are
 * sent in the order their last frames landed, so a page cut short by `limit`
 * leaves only entries that end past the new `high`, and the next page sends
 * them.
 *
 * An entry at or before `through` that did not grow, with a frame received
 * after the cursor's receipt, changed out of the cursor's sight: a subagent
 * frame that landed before the cursor in fold order (#4083). It is sent after
 * the grown entries, in the order its frames were received. New entries fill
 * whatever room is left. The plan counts the grown and late entries the
 * limit left (`unsent`), so the caller can tell a page that holds every
 * change from one cut short.
 *
 * `settleAt` is the receipt time every frame received by then has certainly
 * been read by (`RECEIPT_SETTLE_MS`). Given, the plan sets the next receipt:
 * inside the late entries when the page stops before the last of them or
 * fills with them, so the next page carries on after the ones sent, and
 * otherwise at `settleAt`, or at the cursor's receipt when that is later. A
 * reader that drains full pages therefore never reads the same late entry
 * twice in a row, and an idle run's receipt passes every frame it holds.
 */
export function planTranscriptPage(
  folds: readonly FoldSpan[],
  cursor: {
    through: number;
    high: number;
    received?: TranscriptReceipt | null;
  } | null,
  limit: number,
  settleAt?: number,
): TranscriptPagePlan {
  const through = cursor?.through ?? -1;
  let high = cursor?.high ?? -1;
  const receipt = cursor?.received ?? null;
  const receivedAt = (i: number) => (folds[i] as FoldSpan).received ?? null;
  const grown: number[] = [];
  const late: number[] = [];
  for (let i = 0; i <= through && i < folds.length; i += 1) {
    const fold = folds[i] as FoldSpan;
    const received = fold.received ?? null;
    if (fold.end > high) grown.push(i);
    else if (receipt !== null && received !== null && received > receipt.after)
      late.push(i);
  }
  grown.sort((a, b) => (folds[a] as FoldSpan).end - (folds[b] as FoldSpan).end);
  late.sort(
    (a, b) => (receivedAt(a) as number) - (receivedAt(b) as number) || a - b,
  );
  let skip = 0;
  while (
    receipt !== null &&
    skip < receipt.sent &&
    skip < late.length &&
    receivedAt(late[skip] as number) === receipt.after + 1
  ) {
    skip += 1;
  }
  const resent = grown.slice(0, limit);
  let room = limit - resent.length;
  const lateSent = late.slice(skip, skip + room);
  room -= lateSent.length;
  const fresh: number[] = [];
  for (let i = through + 1; i < folds.length && fresh.length < room; i += 1) {
    fresh.push(i);
  }
  const indexes = [...resent, ...lateSent, ...fresh];
  for (const i of indexes) high = Math.max(high, (folds[i] as FoldSpan).end);
  const plan: TranscriptPagePlan = {
    indexes,
    through: fresh.at(-1) ?? through,
    high,
  };
  const unsent =
    grown.length - resent.length + (late.length - skip - lateSent.length);
  if (unsent > 0) plan.unsent = unsent;
  if (settleAt === undefined) return plan;
  const stop = skip + lateSent.length;
  // How many of the late entries before `stop` arrived at `at`: those the
  // next page skips when its receipt stands just before `at`.
  const sentAt = (at: number) =>
    late.slice(0, stop).filter((i) => receivedAt(i) === at).length;
  const pinnedAt =
    stop < late.length
      ? receivedAt(late[stop] as number)
      : lateSent.length > 0 && room === 0
        ? receivedAt(late[stop - 1] as number)
        : null;
  if (pinnedAt !== null) {
    plan.received = { after: pinnedAt - 1, sent: sentAt(pinnedAt) };
  } else if (receipt !== null && receipt.after >= settleAt) {
    plan.received = { after: receipt.after, sent: sentAt(receipt.after + 1) };
  } else {
    plan.received = { after: settleAt, sent: 0 };
  }
  return plan;
}

/**
 * The page that ends just before fold `end`: at most `limit` folds, in fold
 * order, and `start`, the first of them. A read `from` the end passes the
 * number of folds, and a read `before` a cursor the fold the cursor names.
 *
 * `through` and `high` are where a reader stands who holds every fold up to
 * the page's last, as a reader that paged forward to it would. So a read
 * after the cursor they make sends what follows the page, and what grew past
 * `high` since. A fold ahead of the page that grows is sent that way too,
 * although the reader was never sent it: a reader that holds only a tail
 * places such an entry by its time, or leaves it for the page ahead.
 */
export function planPageBefore(
  folds: readonly FoldSpan[],
  end: number,
  limit: number,
): TranscriptPagePlan & { start: number } {
  const stop = Math.max(0, Math.min(end, folds.length));
  const start = Math.max(0, stop - limit);
  const indexes: number[] = [];
  for (let i = start; i < stop; i += 1) indexes.push(i);
  let high = -1;
  for (let i = 0; i < stop; i += 1) {
    high = Math.max(high, (folds[i] as FoldSpan).end);
  }
  return { indexes, through: stop - 1, high, start };
}

/**
 * The folds a page read from a cursor can still send, the cursor given as
 * frame positions in the run as read (`cursorPosition`): those that open
 * after its `through` frame, those at or before it whose last frame lies
 * past `high`, and those with a frame received after `receivedAfter`, which
 * `planTranscriptPage` sends again. Every other fold was sent and has not
 * changed since, so no page from this cursor on sends it. Null reads from
 * the start, where every fold can be sent.
 */
export function unsentFolds<T extends { span: FoldSpan }>(
  folds: readonly T[],
  cursor: {
    throughAt: number;
    highAt: number;
    receivedAfter?: number | null;
  } | null,
  received: (fold: T) => number | null = () => null,
): readonly T[] {
  if (cursor === null) return folds;
  const after = cursor.receivedAfter ?? null;
  return folds.filter((fold) => {
    if (fold.span.open > cursor.throughAt || fold.span.end > cursor.highAt)
      return true;
    if (after === null) return false;
    const at = received(fold);
    return at !== null && at > after;
  });
}

/**
 * When the server received a fold's latest frame, in milliseconds, or null
 * when none of its frames carries a receipt time (a ledger run's).
 */
export function receivedOf(fold: { members: readonly RunFrame[] }): number | null {
  let latest: number | null = null;
  for (const frame of fold.members) {
    const at = frame.receivedAt?.getTime();
    if (at !== undefined && (latest === null || at > latest)) latest = at;
  }
  return latest;
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

/**
 * The fold index a `before` cursor's entry opens at: the page ahead of it
 * ends just before this fold. When no fold opens at the key any longer (its
 * opening frame was a model call's copy a richer one replaced), the first
 * fold that opens after the frame's position, so every fold that opens at or
 * before it is ahead of the reader's first entry.
 */
function foldBefore(
  spans: readonly FoldSpan[],
  openKeys: readonly string[],
  shown: readonly RunFrame[],
  key: string,
): number {
  const exact = openKeys.indexOf(key);
  if (exact !== -1) return exact;
  return foldThrough(spans, openKeys, shown, key) + 1;
}

// ---- Bodies ---------------------------------------------------------------------------

/**
 * A half's kept body as the record vouches for it (`read`): the message a
 * recorded model stream was (`assembly`), or else its text. Otherwise why
 * there is none: the frame kept no body (`none`), the bytes are not UTF-8
 * text (`not_text`), the store has no such object or the bytes no longer hash
 * to the recorded digest (`gone`), the object is there and its key no longer
 * opens it, as after erasure (`erased`), or the read failed in a way that may
 * pass (`unread`). A body whose own envelope does not open while its key may
 * still open others (`BodyUnopenableError`) reads as `gone`, like bytes that
 * no longer hash.
 *
 * One body the store cannot answer (an object gone missing, a key id this
 * deployment no longer holds, a transient read failure) leaves its own half
 * unread. It must not fail the read: every other half is still readable, and
 * the Policy, Context and stats tabs read through this same handler.
 */
type BodyRead =
  | { state: "read"; text: string; assembly: MessageAssembly | null }
  | { state: "none" | "not_text" | "gone" | "erased" | "unread" };

/**
 * What one read has learned about the keys its bodies are sealed under,
 * named by the key id in each body's reference: a key that opened a body
 * (`opened`), and one KMS says no longer opens any (`gone`).
 *
 * Erasure destroys a key and leaves its bodies in the store (§13.5). KMS
 * then refuses the key itself (`BodyKeyGoneError`), so every body under it
 * fails, and a key that opened a body has not been destroyed. One body whose
 * own envelope does not open (`BodyUnopenableError`) says nothing about its
 * key: a reference names the deployment's KEK, which seals every body, so
 * that failure leaves this set alone and fails that body only.
 *
 * The words cache keeps what each body said with no expiry, and that stays
 * true after erasure; whether the body can still be read does not. So what a
 * read learns about its keys decides whether a kept digest stands
 * (`readWords`). It is learned per read and never kept across reads, so a
 * process that read a run before erasure answers what a process that never
 * read it answers. A read that waits on another's read of a body takes what
 * that read learned (`WordsRead`), so it learns as much as if it had opened
 * the body itself.
 */
interface BodyKeys {
  opened: Set<string>;
  gone: Set<string>;
}

function bodyKeys(): BodyKeys {
  return { opened: new Set(), gone: new Set() };
}

/**
 * One read of a body for its words (`readWords`): what the body says, or
 * null when it could not be read whole; whether it will fail again on a
 * retry; and what the read learned about the body's key. A read that waits
 * on another's read of the body (`WordsCache.share`) takes all three, so it
 * learns the key's state as the read that opened the body did.
 */
interface WordsRead {
  said: BodyWords | null;
  failed: boolean;
  learned: BodyKeys;
}

type BodyReader = Pick<EvidenceStore, "getBody" | "getAssembly">;

/**
 * `bodies`, asked at most once per object for one read of one run.
 *
 * One read asks for the same body more than once. `readWords` reads the word
 * halves before the page is cut, and reads one body again per key to learn
 * the key still opens bodies; then `half` reads each half the page shows, and
 * a recall entry's body is read for its half and again for its listing. Here
 * each object is asked for once, and every later ask gets the same answer, a
 * failure included, so a read never shows a half it could not read for its
 * words, or the reverse.
 *
 * What it holds is bounded by `maxBytes`. An object that would take the held
 * bytes past it is not held, and a later ask for it reads it again, so a read
 * of 2,000 word halves holds at most that much. Make one per read: nothing
 * held here is ever released.
 */
function readEachOnce(
  bodies: BodyReader,
  maxBytes: number = BODY_HOLD_BYTES,
): BodyReader {
  let heldBytes = 0;
  const once = <T>(
    ask: (scope: RunScope, ref: string) => Promise<T>,
    sizeOf: (answer: T) => number,
  ) => {
    const held = new Map<string, Promise<T>>();
    return (scope: RunScope, ref: string): Promise<T> => {
      const key = `${scope.orgId}/${scope.workspaceId}/${ref}`;
      const kept = held.get(key);
      if (kept !== undefined) return kept;
      const answer = ask(scope, ref);
      held.set(key, answer);
      void answer.then(
        (value) => {
          const size = sizeOf(value);
          if (heldBytes + size > maxBytes) held.delete(key);
          else heldBytes += size;
        },
        () => undefined,
      );
      return answer;
    };
  };
  return {
    getBody: once(
      (scope, ref) => bodies.getBody(scope, ref),
      (stored) => stored.bytes.byteLength,
    ),
    getAssembly: once(
      (scope, ref) => bodies.getAssembly(scope, ref),
      (bytes) => bytes?.byteLength ?? 0,
    ),
  };
}

/** The key id a frame's body reference names; null for a foreign reference. */
function keyIdOf(frame: RunFrame): string | null {
  const ref = frame.body.bodyRef;
  return ref === null ? null : (parseEvidenceBodyRef(ref)?.keyId ?? null);
}

/**
 * Add what one body read learned about keys to what a read has learned.
 * `readWords` reads a body into a `BodyKeys` of its own, because a read that
 * waits on it takes what it learned as well.
 */
function learnKeys(keys: BodyKeys, learned: BodyKeys): void {
  for (const keyId of learned.opened) keys.opened.add(keyId);
  for (const keyId of learned.gone) keys.gone.add(keyId);
}

/**
 * `frame`'s body, read whole. What the read learns about the body's key goes
 * into `keys`. `told` holds the keys this read has already logged as gone,
 * and is `keys.gone` unless the caller reads into a set of its own.
 */
async function readBody(
  bodies: Pick<EvidenceStore, "getBody" | "getAssembly">,
  scope: RunScope,
  frame: RunFrame,
  keys: BodyKeys,
  told: Set<string> = keys.gone,
): Promise<BodyRead> {
  const { bodyRef, bodyDigest } = frame.body;
  if (bodyRef === null || bodyDigest === null) return { state: "none" };
  let stored: Awaited<ReturnType<typeof bodies.getBody>>;
  try {
    stored = await bodies.getBody(scope, bodyRef);
  } catch (err) {
    if (err instanceof StorageNotFoundError) return { state: "gone" };
    if (err instanceof BodyKeyGoneError) {
      // Said once per key per read: an erased run has a body per frame, and
      // each would say the same thing.
      const first = !told.has(err.keyId);
      told.add(err.keyId);
      keys.gone.add(err.keyId);
      if (first) {
        logger.warn(
          { err, seq: frame.seq, type: frame.type, keyId: err.keyId },
          "get_run_transcript: a body key no longer opens its bodies; they are shown without text",
        );
      }
      return { state: "erased" };
    }
    if (err instanceof BodyUnopenableError) {
      logger.warn(
        { err, seq: frame.seq, type: frame.type, bytesRef: bodyRef },
        "get_run_transcript: a frame body does not open; its half is shown without text",
      );
      return { state: "gone" };
    }
    logger.warn(
      { err, seq: frame.seq, type: frame.type, bytesRef: bodyRef },
      "get_run_transcript: a frame body could not be read; its half is shown without text",
    );
    return { state: "unread" };
  }
  const keyId = keyIdOf(frame);
  if (keyId !== null) keys.opened.add(keyId);
  if (digestBytes(stored.bytes) !== bodyDigest) return { state: "gone" };
  let text: string;
  try {
    text = decoder.decode(stored.bytes);
  } catch {
    return { state: "not_text" };
  }
  try {
    return {
      state: "read",
      text,
      assembly: await readAssembly(bodies, scope, bodyRef, text, frame),
    };
  } catch (err) {
    logger.warn(
      { err, seq: frame.seq, type: frame.type, bytesRef: bodyRef },
      "get_run_transcript: a frame's reassembly could not be read; its half is shown without text",
    );
    return { state: "unread" };
  }
}

/**
 * What a body the store answered says, for the words cache: the digest of
 * its words, never the words (`wordsDigest`). A stream's words are its last
 * text block that has any.
 */
function bodyWords(body: {
  text: string;
  assembly: MessageAssembly | null;
}): BodyWords {
  if (body.assembly === null)
    return { stream: false, words: wordsDigest(body.text) };
  let last: TranscriptWords = null;
  for (const block of body.assembly.blocks) {
    if (block.kind !== "text") continue;
    last = wordsDigest(block.text) ?? last;
  }
  return { stream: true, last };
}

/**
 * The words `fold` shows from its words half's body: the text of a body that
 * is not a model stream, and of a stream only a model step's last text block.
 * A prompt or reply kept as a stream is shown no text, so it shows no words.
 */
function wordsOf(fold: TranscriptFold, words: BodyWords): TranscriptWords {
  if (!words.stream) return words.words;
  return fold.node === "model" ? words.last : null;
}

/**
 * One half of the exchange, read from the evidence store every time: the
 * words cache holds digests, never text, so no half is answered from it.
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
  keys: BodyKeys,
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
  const body = await readBody(bodies, scope, frame, keys);
  if (body.state !== "read")
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
 * The words each entry of `needed` shows a reader, for `markWords`, as the
 * digest of those words: read the way `half` reads the half a reader is
 * shown, whole rather than cut at the zoom's cap. A prompt or reply shows the
 * text of its half, and none when the half is a recorded model stream, which
 * a reader is shown as a message with no text. A model step shows the last
 * text block of its reply, or the reply's text where the recorder assembled
 * none.
 *
 * Only a body read whole answers for its entry. An entry whose body could
 * not be read, for any reason, is left out of the answer, so `markWords`
 * leaves it as the fold said: a read that failed says nothing about the
 * words, and an entry must not stop drawing because its body did not arrive.
 * A half with no kept body shows no words, costs no read and does not count
 * against the bound.
 *
 * The halves are taken in the run's order (each fold's opening position),
 * and counted per chain: the run's own chain, and each subagent chain on its
 * own. A chain only grows at its end, so a frame that lands later, on this
 * chain or any other, never takes the place of a half a chain already
 * settled. A subagent chain spliced in ahead of them does not move the bound
 * on the run's own chain (#4334).
 *
 * `only` narrows what is read, not the bound: a half it leaves out still
 * takes its place on its chain, and is left out of the answer. So a read
 * that asks for the prompts alone settles the prompts a read of every half
 * settles, and no others.
 *
 * At most `halfMax` halves of each chain are settled: the first ones in that
 * order, whether `cache` holds them or not. So which entries a read settles
 * does not depend on what earlier reads left in the cache, and every page of
 * a run, and every read of a live one, settles the same ones. An entry past
 * the bound is left out of the answer too.
 *
 * A half `cache` holds costs no read. What each read says is kept in it. A
 * body that will fail again on a retry (the store says it is gone, it no
 * longer hashes, it does not open, or its key no longer opens any body) is
 * kept as unreadable for the cache's failure TTL and left out of the answer.
 * A read that failed in a way that may pass is not kept, and is tried again
 * on the next read.
 *
 * A kept digest answers only while its body's key still opens bodies, which
 * this read learns (`keys`) from the bodies it reads under that key. For a
 * key it learns nothing about that way, one body is read again to find out,
 * at most once per key. So after
 * erasure a process that kept digests answers what a process that never
 * read the run answers, at the cost of at most one read per key. A body read
 * again that does not open fails only itself: its kept digest no longer
 * answers, and every other body under its key still does.
 *
 * Two reads of one run often run at once (the Run page reads `steps` and
 * `everything` together). Each asks `cache` again just before it opens a
 * body, since the other may have read it by then, and a body the other is
 * reading at that moment is waited on (`WordsCache.share`), not opened
 * twice. A read that waits takes what the other learned about the body's
 * key along with its words (`WordsRead`), so each read learns the keys its
 * words lean on. A read that finds the words already kept by the other knows
 * the key opened, since only a body that opened is kept. A read that finds
 * the body already failed, or whose own read failed before KMS answered,
 * learns nothing about the key, so where a kept digest leans on it, one body
 * under it is read again once the other reads are done. A read that tests a
 * key is never shared: it reads the body itself.
 */
export async function readWords(
  bodies: Pick<EvidenceStore, "getBody" | "getAssembly">,
  scope: RunScope,
  needed: readonly TranscriptFold[],
  options: {
    halfMax?: number;
    cache?: WordsCache | null;
    keys?: BodyKeys;
    only?: (fold: TranscriptFold) => boolean;
  } = {},
): Promise<Map<TranscriptFold, TranscriptWords>> {
  const halfMax = options.halfMax ?? TRANSCRIPT_WORDS_HALF_MAX;
  const cache = options.cache ?? null;
  const keys = options.keys ?? bodyKeys();
  const only = options.only ?? (() => true);
  const words = new Map<TranscriptFold, TranscriptWords>();
  const reads: { fold: TranscriptFold | null; frame: RunFrame }[] = [];
  const hits: { fold: TranscriptFold; frame: RunFrame; said: BodyWords }[] = [];
  const settled = new Map<string, number>();
  for (const fold of inRunOrder(needed)) {
    const frame = wordsHalf(fold);
    if (
      frame === null ||
      frame.body.bodyRef === null ||
      frame.body.bodyDigest === null
    ) {
      if (only(fold)) words.set(fold, null);
      continue;
    }
    const chain = frame.chain?.sessionUuid ?? "";
    const taken = settled.get(chain) ?? 0;
    if (taken >= halfMax) continue;
    settled.set(chain, taken + 1);
    if (!only(fold)) continue;
    const kept = cache?.get(scope, frame);
    if (kept === UNREADABLE) continue;
    if (kept === undefined) reads.push({ fold, frame });
    else hits.push({ fold, frame, said: kept });
  }
  // One body per key this read knows nothing about, read again to learn
  // whether the key still opens it. A key that one of `reads` names needs
  // none yet: that read, or the read it waits on, is the test. A key it
  // leaves untested is tested once the reads are done (below).
  const learning = new Set(reads.map(({ frame }) => keyIdOf(frame)));
  // Keys this read tests with a body of their own, so none is tested twice.
  const tested = new Set<string>();
  for (const { frame } of hits) {
    const keyId = keyIdOf(frame);
    if (
      keyId === null ||
      keys.opened.has(keyId) ||
      keys.gone.has(keyId) ||
      learning.has(keyId)
    )
      continue;
    learning.add(keyId);
    tested.add(keyId);
    reads.push({ fold: null, frame });
  }
  const gone = (frame: RunFrame) => {
    const keyId = keyIdOf(frame);
    return keyId !== null && keys.gone.has(keyId);
  };
  // Bodies this read found will fail again. A kept digest of one of them no
  // longer answers, as a read with no cache would not.
  const failed = new Set<RunFrame>();
  // The keys this read has logged as gone. Each body is read into a
  // `BodyKeys` of its own, so `readBody` cannot tell from that alone.
  const told = new Set(keys.gone);
  // What `frame`'s body says, kept in `cache` before a shared read settles,
  // so a read that asks once it has settled finds it there. What the read
  // learned about the body's key comes back with it rather than going into
  // `keys`, because a read beside this one may be waiting on it.
  const load = async (frame: RunFrame): Promise<WordsRead> => {
    const learned = bodyKeys();
    const body = await readBody(bodies, scope, frame, learned, told);
    if (body.state === "gone" || body.state === "erased") {
      cache?.fail(scope, frame);
      return { said: null, failed: true, learned };
    }
    // Bytes that are not text were read whole, and show no words.
    const said: BodyWords | null =
      body.state === "read"
        ? bodyWords(body)
        : body.state === "not_text"
          ? { stream: false, words: null }
          : null;
    if (said !== null) cache?.set(scope, frame, said);
    return { said, failed: false, learned };
  };
  // A body read, this read's own or one it waited on, added to this read.
  const take = (frame: RunFrame, read: WordsRead): BodyWords | null => {
    learnKeys(keys, read.learned);
    if (read.failed) failed.add(frame);
    return read.said;
  };
  const said = await mapConcurrent(
    reads,
    BODY_CONCURRENCY,
    async ({ fold, frame }): Promise<TranscriptWords | undefined> => {
      // A key another read found gone fails this body too: no need to ask.
      if (gone(frame)) {
        cache?.fail(scope, frame);
        return undefined;
      }
      // A key's test answers no entry, and is never shared: it reads the
      // body itself.
      if (fold === null) {
        take(frame, await load(frame));
        return undefined;
      }
      // A read running beside this one may have read the body by now.
      const landed = cache?.get(scope, frame);
      if (landed === UNREADABLE) return undefined;
      if (landed !== undefined) {
        // Only a body that opened is kept, so its key opened.
        const keyId = keyIdOf(frame);
        if (keyId !== null) keys.opened.add(keyId);
        return wordsOf(fold, landed);
      }
      const says = take(
        frame,
        cache === null
          ? await load(frame)
          : await cache.share(scope, frame, () => load(frame)),
      );
      return says === null ? undefined : wordsOf(fold, says);
    },
  );
  // A read that found a body another read had already failed, or whose own
  // read failed before KMS answered, learned nothing about the body's key.
  // Where a kept digest leans on a key still unknown, one body under it is
  // read again, unshared, as the test the read above did not make.
  const untested = new Map<string, RunFrame>();
  for (const { frame } of hits) {
    const keyId = keyIdOf(frame);
    if (
      keyId === null ||
      keys.opened.has(keyId) ||
      keys.gone.has(keyId) ||
      tested.has(keyId)
    )
      continue;
    if (!untested.has(keyId)) untested.set(keyId, frame);
  }
  await mapConcurrent(
    [...untested.values()],
    BODY_CONCURRENCY,
    async (frame) => {
      take(frame, await load(frame));
    },
  );
  reads.forEach(({ fold }, i) => {
    const answer = said[i];
    if (fold !== null && answer !== undefined) words.set(fold, answer);
  });
  for (const { fold, frame, said: kept } of hits) {
    if (gone(frame)) cache?.fail(scope, frame);
    else if (!failed.has(frame)) words.set(fold, wordsOf(fold, kept));
  }
  return words;
}

/**
 * `folds` by the position each opens at in the run as read. `markWords` asks
 * for the model step before a reply after the reply itself, so its order is
 * not quite the run's. `sort` is stable, so folds that open together keep
 * their order.
 */
function inRunOrder(folds: readonly TranscriptFold[]): TranscriptFold[] {
  return [...folds].sort((a, b) => a.span.open - b.span.open);
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
 * came back), `family` (`toolFamilyOf` its name) and `tool` (its name as the
 * harness knows it, `bareToolName`). A half with no assembly
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
              tool: bareToolName(block.name),
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

/** A prompt, the one entry `figures` needs the words of at every zoom. */
const isPrompt = (fold: TranscriptFold): boolean => fold.node === "prompt";

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
    // The rules the frame names, in evaluation order, and the taint a
    // producer assessed: null for every decision today, because none does
    // (#3971, ADR-201).
    rules: decision.rules,
    taint: decision.taint,
  };
}

/**
 * The reasoning effort the fold's model call ran at: the first of its frames
 * that recorded one, as the fold's `usage` chip reads it (`frameKinds`).
 * Null where none did, which is every ledger frame and every wrapped frame
 * from a harness that does not report it.
 */
function entryEffort(fold: TranscriptFold): string | null {
  for (const frame of fold.members) {
    const effort = frame.identity.effort;
    if (effort !== undefined && effort !== "") return effort;
  }
  return null;
}

// ---- Window ---------------------------------------------------------------------------

/** The subagent chains a cursor's frames lie on, by session uuid. */
function chainsNamed(cursor: TranscriptCursor): string[] {
  const named = new Set<string>();
  for (const key of [cursor.through, cursor.high]) {
    const chained = CHAIN_KEY.exec(key);
    if (chained) named.add((chained[1] as string).toLowerCase());
  }
  return [...named];
}

/**
 * Whether a window read from `fromSeq` holds the frame `key` names, so the
 * cursor finds the same place in it as in a read of the whole run. A frame
 * on a subagent chain needs that chain in the window, and one on the run's
 * own chain needs to lie between the window's first and last frames there.
 * The start of a read (`-1`) lies before every window.
 */
function windowHolds(
  frames: readonly RunFrame[],
  fromSeq: string,
  key: string,
): boolean {
  if (key === TACHO_START) return false;
  const chained = CHAIN_KEY.exec(key);
  if (chained) {
    const session = (chained[1] as string).toLowerCase();
    return frames.some((frame) => frame.chain?.sessionUuid === session);
  }
  let last: bigint | null = null;
  for (const frame of frames) {
    if (frame.chain === undefined) last = BigInt(frame.seq);
  }
  const seq = BigInt(key);
  return last !== null && seq >= BigInt(fromSeq) && seq <= last;
}

/**
 * The call keys a frame names, each with its chain: its call id and every key
 * of the model call it carries. The fold joins frames of one chain by these
 * inside a turn (rules 1 to 3 and a reply's further parts in
 * transcript-steps.ts) and drops a model call's second sighting by them
 * (`withoutDuplicateModelCalls`), so a frame past a tail start that names a
 * key from before it would fold differently in a read from the turn's start.
 */
function tailCallKeys(frame: RunFrame): string[] {
  const chain = frame.chain?.sessionUuid ?? "";
  const keys: string[] = [];
  if (frame.identity.callId !== null)
    keys.push(`${chain}\u0000${frame.identity.callId}`);
  for (const key of frame.llmCall?.keys ?? []) keys.push(`${chain}\u0000${key}`);
  return keys;
}

/** What one read starts from, and the window the cursor it writes carries on. */
interface TranscriptRead {
  read: FrameRead;
  /** The turn's window the cursor names, or null for the whole run. */
  from: TranscriptWindowFrom | null;
  /** Where this read starts: `from`, or a tail start inside its turn. */
  start: TranscriptWindowFrom | null;
  /** `turnOrdinals`' count for a read from a tail start; undefined otherwise. */
  byOpeners?: boolean;
  /** The tail start this read read from, when it read from one. */
  tail: TailStart | null;
}

/**
 * The frames a read folds, and the window they start at: from `from` when
 * the cursor names a window and the window can answer, and otherwise the
 * whole run from its first frame, with `from` null.
 *
 * Given a tail start for the cursor (`TailStart`), the read first reads from
 * there. That read answers only when no frame it holds names a call key the
 * turn recorded before the tail start (`tailCallKeys`), so the fold makes
 * the same steps of it as of the turn's window. Otherwise the read reads the
 * turn's window.
 *
 * A window cannot answer when a subagent chain that began before it moved
 * after the cursor's receipt, less the lead its session row can run ahead of
 * a receipt (`SESSION_MOVE_LEAD_MS`), since only a read of the whole run
 * places that chain's new frames (`readTranscriptWindow`). Nor when it does
 * not hold both of the cursor's frames: the positions the cursor names would
 * then read differently in it.
 */
async function transcriptFrames(
  deps: RunReadDeps,
  run: ResolvedRun,
  after: TranscriptCursor | null,
  from: TranscriptWindowFrom | null,
  tail: TailStart | null,
): Promise<TranscriptRead> {
  const reads = after === null ? null : runChainWindowReads(deps, run);
  const windowFrom = async (
    start: TranscriptWindowFrom,
  ): Promise<FrameRead | null> => {
    if (after === null || reads === null) return null;
    const received = after.received ?? null;
    const window = await readTranscriptWindow(
      reads,
      {
        fromSeq: start.seq,
        observed: start.observed,
        movedAfter:
          received === null
            ? null
            : new Date(received.after - SESSION_MOVE_LEAD_MS),
        holds: chainsNamed(after),
      },
      TRANSCRIPT_FRAME_CAP,
    );
    return window !== null &&
      windowHolds(window.frames, start.seq, after.through) &&
      windowHolds(window.frames, start.seq, after.high)
      ? window
      : null;
  };
  if (tail !== null) {
    const start: TranscriptWindowFrom = {
      seq: tail.seq,
      turn: tail.turn,
      cost: tail.cost,
      observed: tail.observed,
    };
    const window = await windowFrom(start);
    const kept = tail.keys;
    if (
      window !== null &&
      !window.frames.some((frame) =>
        tailCallKeys(frame).some((key) => kept.has(key)),
      )
    ) {
      const byOpeners = tail.byOpeners || window.frames.some(opensRunTurn);
      return { read: window, from, start, byOpeners, tail };
    }
  }
  if (from !== null) {
    const window = await windowFrom(from);
    if (window !== null) return { read: window, from, start: from, tail: null };
  }
  return {
    read: await readTranscriptFrames(
      runChainReads(deps, run),
      TRANSCRIPT_FRAME_CAP,
    ),
    from: null,
    start: null,
    tail: null,
  };
}

/** What `nextWindow` and `nextTailStart` read off one read. */
interface WindowFacts {
  shown: readonly RunFrame[];
  /** The turn of each frame in `shown`, as the fold counted it. */
  ordinals: readonly (number | null)[];
  /** Every entry's extent, at `steps` and at the zoom read. */
  spans: readonly FoldSpan[];
  /** The position of the frame that opens the last entry the reader was sent. */
  limitAt: number;
  /** The first frame of any entry at or before it that this page had no room for. */
  leftAt: number;
  /** The first frame of any call still waiting on a live run. */
  waitingAt: number;
  complete: boolean;
  /** The window the cursor this read was given names. */
  from: TranscriptWindowFrom | null;
  /** Where this read starts: `from`, or the tail start it read from. */
  start: TranscriptWindowFrom | null;
  /** The run's turn for a turn this read counted. */
  turnOf: (turn: number | null) => number | null;
  /** The run's cumulative cost through a frame of this read. */
  costThrough: (frame: RunFrame) => number | null;
}

/**
 * Whether each position of `shown` is a frame on the run's own chain that no
 * entry spans: no entry opens before it and ends at or after it.
 */
function cleanCuts(
  shown: readonly RunFrame[],
  spans: readonly FoldSpan[],
): boolean[] {
  const edges = new Array<number>(shown.length + 1).fill(0);
  for (const { open, end } of spans) {
    if (end <= open) continue;
    edges[open + 1] = (edges[open + 1] ?? 0) + 1;
    edges[end + 1] = (edges[end + 1] ?? 0) - 1;
  }
  let depth = 0;
  return shown.map((frame, q) => {
    depth += edges[q] ?? 0;
    return depth === 0 && frame.chain === undefined;
  });
}

/** Whether the proxy observed a model call on the run's own chain before position `q`. */
function observedBefore(
  facts: Pick<WindowFacts, "shown" | "start">,
  q: number,
): boolean {
  if (facts.start?.observed === true) return true;
  for (let i = 0; i < q; i += 1) {
    const frame = facts.shown[i] as RunFrame;
    if (frame.chain === undefined && frame.usageObserved === true) return true;
  }
  return false;
}

/**
 * Where the next read's window starts: the latest frame on the run's own
 * chain that opens a turn, at or before the frame that opens the last entry
 * the reader was sent. No entry may span it, and every entry the next read
 * may still send must lie at or after it: one this page had no room for,
 * and on a live run a call still waiting, which can gain its result.
 *
 * A read the frame cap cut short that finds no such turn takes one that
 * leaves a waiting call behind, and then a step boundary inside a turn, so
 * a long run's reader still moves past the cap. Otherwise the window stays
 * where it was: null for a read of the whole run.
 */
function nextWindow(facts: WindowFacts): TranscriptWindowFrom | null {
  const { shown, ordinals } = facts;
  const limit = Math.min(facts.limitAt, facts.leftAt);
  if (limit < 1) return facts.from;
  const clean = cleanCuts(shown, facts.spans);
  const latest = (bound: number, cut: (q: number) => boolean) => {
    for (let q = Math.min(bound, shown.length - 1); q >= 1; q -= 1) {
      if (clean[q] && cut(q)) return q;
    }
    return null;
  };
  const opensTurn = (q: number) => ordinals[q] !== ordinals[q - 1];
  let q = latest(Math.min(limit, facts.waitingAt), opensTurn);
  if (q === null && !facts.complete) {
    q =
      latest(limit, opensTurn) ??
      latest(limit, (at) => (shown[at] as RunFrame).turnIndex !== null);
  }
  if (q === null) return facts.from;
  return {
    seq: (shown[q] as RunFrame).seq,
    turn: facts.turnOf(ordinals[q] ?? null),
    cost: facts.costThrough(shown[q - 1] as RunFrame),
    observed: observedBefore(facts, q),
  };
}

/**
 * Where the next read of a live run from the cursor this read writes can
 * start inside its turn, or null when it cannot start past the turn's window
 * (`next`, the window that cursor names).
 *
 * The tail start is the opening frame of a model step on the run's own
 * chain, the latest that meets every rule below, so the frames a read from
 * it holds fold into the same entries as a read of the turn's window:
 *
 * - It is at or before the frame that opens the last entry the reader was
 *   sent, before any entry the page had no room for, and before any call
 *   still waiting, which can gain its result (as for `nextWindow`).
 * - No entry spans it.
 * - It is the latest model step the reader was sent, or one before it, so
 *   the words a reply is compared with (`markWords`: what was said last
 *   before it in its turn on its chain) lie inside the read.
 * - The server received it before this read's settle margin
 *   (`RECEIPT_SETTLE_MS`), so its own batch had landed. No frame before it
 *   on the run's own chain can land after it: the host ships one drain at a
 *   time from its WAL cursor and moves the cursor only once ingest accepts a
 *   batch (`Shipper.drain`, #3782), ingest answers only after the ClickHouse
 *   insert, and it refuses a batch that skips past the recorded head. So a
 *   batch is sent only after every earlier batch of its chain has landed.
 * - It lies past every later sighting of a model call that the read shows
 *   on the run's own chain. Such a copy stands in for a first sighting the
 *   read hides, and took that sighting's cost. On a run whose every model
 *   call shows as a copy, no frame qualifies and the read keeps reading the
 *   turn's window.
 * - On a run that counts turns by their recorded index rather than by the
 *   frames that open them, it carries an index, so the read from it counts
 *   from that index (`turnOrdinals`).
 *
 * It carries every call key the turn's window holds before it: the keys this
 * read holds from the window's start, and when this read itself started
 * from a tail start inside that window, the keys that start carried.
 */
function nextTailStart(
  facts: WindowFacts & {
    steps: readonly TranscriptFold[];
    next: TranscriptWindowFrom | null;
    settledBy: number;
    tail: TailStart | null;
    byOpeners: boolean;
  },
): TailStart | null {
  const { shown, ordinals } = facts;
  const bound = Math.min(facts.limitAt, facts.leftAt, facts.waitingAt);
  // Where the next cursor's window starts in this read, -1 when it starts
  // before this read. A cursor that names no window reads the whole run, so
  // its window starts at the run's first frame. One that starts before this
  // read is covered only when this read began at a tail start kept for that
  // same window, whose keys cover the frames from there to it.
  const { next } = facts;
  const nextAt =
    next === null
      ? facts.start === null
        ? 0
        : -1
      : shown.findIndex(
          (frame) => frame.chain === undefined && frame.seq === next.seq,
        );
  if (
    nextAt === -1 &&
    (facts.tail === null || (next?.seq ?? null) !== (facts.from?.seq ?? null))
  )
    return null;
  const clean = cleanCuts(shown, facts.spans);
  // A read from a tail start can keep that start for the next read while no
  // later model step has settled. Any other start needs a frame before it in
  // this read, for the cost the run carried into it.
  const keeps = (step: TranscriptFold) =>
    nextAt === -1 &&
    step.opening.chain === undefined &&
    step.opening.seq === facts.start?.seq;
  // The last later sighting of a model call on the run's own chain that this
  // read shows (`withoutDuplicateModelCalls` kept it and hid the first, giving
  // it the first's cost). That first sighting can lie anywhere before it, and
  // a read from a start between them would show the copy without the cost,
  // so the start lies past every such copy. A sighting that continues its own
  // source's reply is a further part, not a copy.
  let copiedAt = -1;
  shown.forEach((frame, at) => {
    const call = frame.llmCall;
    if (
      frame.chain === undefined &&
      call !== undefined &&
      call.duplicateOf !== null &&
      call.duplicateOf !== call.source
    )
      copiedAt = at;
  });
  let q: number | null = null;
  for (const step of facts.steps) {
    const at = step.span.open;
    if (at > bound) break;
    if (
      step.node === "model" &&
      (at >= 1 || keeps(step)) &&
      at > nextAt &&
      at > copiedAt &&
      clean[at] === true &&
      (facts.byOpeners || step.opening.turnIndex !== null)
    ) {
      const received = step.opening.receivedAt?.getTime();
      if (received !== undefined && received <= facts.settledBy) q = at;
    }
  }
  if (q === null) return null;
  const from = Math.max(nextAt, 0);
  const keys = new Set<string>(nextAt === -1 ? (facts.tail?.keys ?? []) : []);
  let byOpeners = nextAt === -1 && (facts.tail?.byOpeners ?? false);
  for (let i = from; i < q; i += 1) {
    const frame = shown[i] as RunFrame;
    for (const key of tailCallKeys(frame)) keys.add(key);
    if (opensRunTurn(frame)) byOpeners = true;
  }
  return {
    seq: (shown[q] as RunFrame).seq,
    turn: facts.turnOf(ordinals[q] ?? null),
    cost:
      q === 0
        ? (facts.start?.cost ?? null)
        : facts.costThrough(shown[q - 1] as RunFrame),
    observed: observedBefore(facts, q),
    byOpeners,
    keys,
  };
}

export function createRunTranscriptGetHandler(
  deps: RunTranscriptGetDeps,
): CapabilityHandler<typeof runTranscriptGet> {
  const words = deps.words ?? createWordsCache();
  const tails = deps.tails ?? createTailCache();
  return async (input, ctx): Promise<RunTranscriptGetOutput> => {
    const after =
      input.after === undefined ? null : decodeTranscriptCursor(input.after);
    if (input.after !== undefined && after === null) {
      throw invalidCursor(runTranscriptGet.name);
    }
    const before =
      input.before === undefined ? null : decodeBeforeCursor(input.before);
    if (input.before !== undefined && before === null) {
      throw invalidCursor(runTranscriptGet.name);
    }
    // A read stands in one place: after a cursor, before one, or at an end.
    const places = [input.after, input.before, input.from].filter(
      (place) => place !== undefined,
    );
    if (places.length > 1) {
      throw new CapabilityError(
        runTranscriptGet.name,
        "invalid_input",
        "conflicting_position",
      );
    }
    // A read from the end or before a cursor pages backward: it sends the
    // folds just ahead of a point, and says where the page ahead of it opens.
    const backward = input.from === "end" || before !== null;

    const scope = runScope(ctx);
    const run = await resolveRun(deps, ctx, input.runId);
    // Taken before any frame is read, so every frame received by then, less
    // the settle margin, is in this read (`RECEIPT_SETTLE_MS`).
    const readAt = (deps.now ?? Date.now)();
    // The run's own chain and every subagent chain under it, each spliced in
    // where it was spawned; late harness reports uncounted; each model call
    // once. `run.summarize` reads the same frames (`readTranscriptFrames`).
    // A read from a cursor reads the window the cursor names, and a search
    // reads the whole run, so it reaches entries past the reader's page. A
    // live reader's read at `steps` reads from the tail start the read before
    // it kept for its cursor, when this process kept one (`TailStart`).
    const followed = input.zoom === "steps" && input.query === undefined;
    const tailKey = (cursor: string) =>
      [
        scope.orgId,
        scope.workspaceId,
        input.runId,
        input.zoom,
        input.kinds.join(","),
        cursor,
      ].join("\n");
    const tail =
      followed && input.after !== undefined && after !== null
        ? tails.take(tailKey(input.after))
        : null;
    const {
      read,
      from,
      start,
      byOpeners,
      tail: readTail,
    } = await transcriptFrames(
      deps,
      run,
      after,
      input.query === undefined ? (after?.from ?? null) : null,
      tail,
    );
    const shown = read.frames;
    // A read with no `after` cursor (from the start, from the end, or before
    // a cursor) holds the run from its first frame, and is the only one that
    // counts the whole run (#3823).
    const first = input.after === undefined;
    // The fold runs over every frame, then the chips narrow its entries, so
    // a filtered read shows the same steps, turns and turn numbers as an
    // unfiltered one (ADR-182).
    //
    // The `steps` fold is taken at every zoom: `turns` groups it, and a model
    // reply's `tool_use` blocks are claimed by its tool steps.
    const steps = stepFolds(shown, byOpeners);
    const all =
      input.zoom === "steps"
        ? steps
        : input.zoom === "turns"
          ? turnFolds(shown, steps)
          : frameFolds(shown);
    // What this read learns about the keys its bodies are sealed under
    // (`BodyKeys`), so a kept digest whose body can no longer be read does
    // not count (`readWords`).
    const keys = bodyKeys();
    // Every body this read asks for more than once is read once.
    const bodies = readEachOnce(deps.bodies);
    // Which prompts and replies show nothing, and which reply repeats words
    // the reader was just shown, need their words. At `steps`, the zoom the
    // Run page draws rows from, they are read over every frame this read
    // holds (the whole run, or a cursor's window), before the counts, so an
    // entry that draws no row counts nowhere. The words cache answers every
    // body an earlier read read, so a later page or a live tail read reads
    // only the bodies that are new, and at most one body per key to learn
    // that the key still opens them. Which entries are settled does not
    // depend on the cache: the first 2,000 word halves of each chain in the
    // frames read are (`readWords`).
    //
    // `turns` is a group, and nothing in it is settled this way. At
    // `everything`, one entry per frame, the entries' words are not read
    // either: the Run page reads it only to list decisions, recalls and
    // governed actions, which never turn quiet on words, and `counts.frames`
    // needs none. There a prompt or reply is quiet only where the fold says
    // so, `echoOf` is null, and `counts` counts every prompt and reply the
    // fold keeps.
    //
    // The figures are counted over `steps` at every zoom, and count a prompt
    // as the prompt chip counts it at `steps`. So at the other two zooms the
    // first read reads the `steps` prompts' words: one body per prompt,
    // which the cache already holds once the run has been read at `steps`.
    // The bound is counted over every half `steps` would read, and only the
    // prompts inside it are read (`only`), so the prompts settled here are
    // the ones `steps` settles on a run past the bound. The figures then do
    // not move with the zoom (#4334). A read from a cursor carries no
    // figures, so it reads none of them.
    if (input.zoom === "steps" || first)
      await markWords(steps, (needed) =>
        readWords(bodies, scope, needed, {
          cache: words,
          keys,
          ...(input.zoom === "steps" ? {} : { only: isPrompt }),
        }),
      );
    // Counted over every entry at the zoom, whatever the chips or query, so
    // a chip's count and the rows it shows agree. The frames' own policy and
    // recall counts ride the same read, so a reader at `steps` never reads
    // `everything` for them. The figures are counted over the steps of every
    // frame read (ADR-182). Both ride only the first read: a window holds
    // part of the run, and its counts would not be the run's (#3823).
    const tallies = first
      ? {
          counts: {
            ...transcriptCounts(all, TRANSCRIPT_KINDS),
            frames: frameCounts(shown),
          },
          figures: transcriptFigures(shown, steps),
        }
      : {};
    const chipped = filterFoldsByKind(all, input.kinds);
    // Where the reader stands, as frame positions in the run as read, and in
    // the order the server received the frames.
    const receipt = after?.received ?? null;
    const at =
      after === null
        ? null
        : {
            throughAt: cursorPosition(shown, after.through),
            highAt: cursorPosition(shown, after.high),
            receivedAfter: receipt?.after ?? null,
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
            unsentFolds(chipped, at, receivedOf),
            input.query,
            async (frame) => {
              const body = await half(
                bodies,
                scope,
                frame,
                TRANSCRIPT_TEXT_MAX,
                () => null,
                keys,
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
    // A window starts from the run's cost before its first frame.
    const costThrough = new Map<RunFrame, number | null>();
    let running: number | null = start?.cost ?? null;
    for (const frame of shown) {
      running =
        frame.costMicros === null ? running : (running ?? 0) + frame.costMicros;
      costThrough.set(frame, running);
    }
    // The fold counts a window's turns from its first frame. The cursor
    // carries the run's turn there, so an entry carries the run's turn.
    const ordinals = turnOrdinals(shown, byOpeners);
    const turnBase =
      start === null || start.turn === null
        ? null
        : start.turn - (ordinals[0] ?? 0);
    const turnOf = (turn: number | null): number | null =>
      turnBase === null ? turn : (turn ?? 0) + turnBase;

    // A sealed run answers no cursor once the page holds every fold and
    // every change left. A live run keeps a resume point even when caught
    // up, so the next read can pick up frames that have not landed yet.
    const live = run.item.status === "live";
    const startKey = startCursorSeq(run);

    // Pages are cut on each frame's position in the run as read, not on its
    // `seq`: a subagent's chain is numbered from 0 like the root's, so a
    // sequence alone no longer orders the frames of a run. The fold states
    // each entry's span in those positions. A wrapped frame carries when the
    // server received it, and a ledger frame does not: a ledger run has one
    // chain, so its positions alone say what is new.
    const spans: FoldSpan[] = folds.map((fold) => ({
      ...fold.span,
      received: receivedOf(fold),
    }));
    const openKeys = folds.map((fold) => frameKey(fold.opening));
    const through =
      after === null || at === null
        ? -1
        : foldThrough(spans, openKeys, shown, after.through);
    const backPlan = backward
      ? planPageBefore(
          spans,
          before === null
            ? folds.length
            : foldBefore(spans, openKeys, shown, before),
          input.limit,
        )
      : null;
    // A read from the end stands where a reader that paged forward to the
    // run's last entry would, so its receipt is the one such a read sets
    // (`planTranscriptPage`). A page read before a cursor carries none: the
    // reader holds the entries after it already, and a receipt would stand
    // for frames it was not sent.
    if (backPlan !== null && before === null && run.source === "tacho")
      backPlan.received = { after: readAt - RECEIPT_SETTLE_MS, sent: 0 };
    const plan =
      backPlan ??
      planTranscriptPage(
        spans,
        at === null ? null : { through, high: at.highAt, received: receipt },
        input.limit,
        run.source === "tacho" ? readAt - RECEIPT_SETTLE_MS : undefined,
      );
    const page = plan.indexes.map((i) => folds[i] as TranscriptFold);
    // Where the next read's window starts. A search reads the whole run and
    // pages without one. While a page stops inside a batch of late entries
    // (`TranscriptReceipt.sent`), the window stays put, so the entries the
    // next page skips are the ones this one sent.
    const sentNow = new Set(plan.indexes);
    let leftAt = Number.POSITIVE_INFINITY;
    for (let i = 0; i <= through && i < spans.length; i += 1) {
      const span = spans[i] as FoldSpan;
      const received = span.received ?? null;
      const late =
        receipt !== null && received !== null && received > receipt.after;
      if (!sentNow.has(i) && (late || span.end > (at?.highAt ?? -1)))
        leftAt = Math.min(leftAt, span.open);
    }
    let waitingAt = Number.POSITIVE_INFINITY;
    if (live) {
      for (const step of steps) {
        if (step.outcome === "pending" || step.outcome === "parked")
          waitingAt = Math.min(waitingAt, step.span.open);
      }
    }
    const facts: WindowFacts | null =
      plan.through === -1
        ? null
        : {
            shown,
            ordinals,
            spans:
              all === steps
                ? steps.map((step) => step.span)
                : [...steps, ...all].map((fold) => fold.span),
            limitAt: (folds[plan.through] as TranscriptFold).span.open,
            leftAt,
            waitingAt,
            complete: read.complete,
            from,
            start,
            turnOf,
            costThrough: (frame) => costThrough.get(frame) ?? null,
          };
    const nextFrom =
      input.query !== undefined
        ? null
        : (plan.received?.sent ?? 0) > 0 || facts === null
          ? from
          : nextWindow(facts);
    // The cursor names frames by key, so it survives a later read that holds
    // more frames, or hides one this read showed. The reader's place in fold
    // order moves only when the page sends a new entry: a page of grown
    // entries alone leaves `through` where the cursor had it, which a fold
    // before it (the one `foldThrough` falls back to) would move backward.
    // The same holds for `high`: a page that delivers no later frame keeps
    // the cursor's, which a read of the whole run past the frame cap may
    // not hold.
    const nextCursor = (): string =>
      encodeTranscriptCursor({
        through:
          plan.through === through
            ? (after?.through ?? startKey)
            : frameKey((folds[plan.through] as TranscriptFold).opening),
        high:
          plan.high === (at?.highAt ?? -1)
            ? (after?.high ?? startKey)
            : frameKey(shown[plan.high] as RunFrame),
        received: plan.received ?? null,
        from: nextFrom,
      });
    // A page the limit cut off before every grown or late entry was sent
    // leaves the rest for the next page, on a sealed run too.
    const more = plan.through + 1 < folds.length || (plan.unsent ?? 0) > 0;
    // A read the frame cap cut short goes on while its window can move on,
    // so a reader pages past the run's first 10,000 frames.
    const onward =
      !read.complete && nextFrom !== null && nextFrom.seq !== from?.seq;
    const cursor = live || more || onward ? nextCursor() : null;
    // Where the next read from this cursor can start inside its turn, kept
    // for it in this process. Only a live run at `steps` keeps one, and only
    // when the receipt stands at this read's settle line: a receipt pinned
    // inside a batch of late entries sends entries again that may lie
    // before any later start.
    const settledBy = readAt - RECEIPT_SETTLE_MS;
    if (
      cursor !== null &&
      facts !== null &&
      followed &&
      live &&
      run.source === "tacho" &&
      before === null &&
      (plan.received?.sent ?? 0) === 0 &&
      (plan.received?.after ?? Number.NEGATIVE_INFINITY) >= settledBy
    ) {
      const next = nextTailStart({
        ...facts,
        steps,
        next: decodeTranscriptCursor(cursor)?.from ?? null,
        settledBy,
        tail: readTail,
        byOpeners: byOpeners ?? shown.some(opensRunTurn),
      });
      if (next !== null) tails.put(tailKey(cursor), next);
    }
    const frameCursor = frameCursorOf(read.frames);
    // Where the page ahead of a backward page opens: null once the page
    // opens at the first entry.
    const ahead =
      backPlan === null
        ? {}
        : {
            before:
              backPlan.start > 0 && backPlan.indexes.length > 0
                ? encodeBeforeCursor(
                    frameKey((folds[backPlan.start] as TranscriptFold).opening),
                  )
                : null,
          };
    if (page.length === 0) {
      return {
        zoom: input.zoom,
        kinds: input.kinds,
        entries: [],
        cursor,
        ...ahead,
        complete: read.complete,
        frameCursor,
        ...tallies,
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
    // A reply's further parts, which the fold gathered into its model step
    // (#4351). Each is read as a half is read, one after another, so a page
    // holds no more reads at once than BODY_CONCURRENCY.
    const partsOf = async (fold: TranscriptFold) => {
      const out: { frame: RunFrame; body: TranscriptEntryBody | null }[] = [];
      for (const frame of replyPartsOf(fold).slice(0, REPLY_PARTS_MAX)) {
        out.push({
          frame,
          body: await half(bodies, scope, frame, textMax, outputRate, keys),
        });
      }
      return out;
    };
    const halves = await mapConcurrent(
      page,
      BODY_CONCURRENCY,
      async (fold) => ({
        request: await half(
          bodies,
          scope,
          fold.request,
          textMax,
          outputRate,
          keys,
        ),
        response: await half(
          bodies,
          scope,
          fold.response,
          textMax,
          outputRate,
          keys,
        ),
        parts: await partsOf(fold),
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
              await recallBody(bodies, scope, fold.opening),
            )
          : null,
    );
    // Each reply's `tool_use` blocks name the tool step that recorded the
    // call, and what came back, so a reader draws each call once.
    const claimer = toolUseClaimer(steps);
    const results = toolResultsOf(
      halves.flatMap((pair) => [
        pair.request,
        pair.response,
        ...pair.parts.map((part) => part.body),
      ]),
    );

    const entries: TranscriptEntry[] = page.map((fold, i) => {
      const { opening } = fold;
      const pair = halves[i] as {
        request: TranscriptEntryBody | null;
        response: TranscriptEntryBody | null;
        parts: { frame: RunFrame; body: TranscriptEntryBody | null }[];
      };
      // Each half, and each further part of a reply, is claimed from the
      // frame that carried it, so a turn's reply claims its calls as the
      // model step that made it does. Declared before the parts read it: a
      // const read earlier in the same scope throws (#4936 CI).
      const claimFrom =
        (carrier: RunFrame | null) =>
        (uses: { name: string; callKey: string | null }[]) =>
          claimer(carrier, uses);
      const parts = pair.parts.flatMap(({ frame, body }) => {
        const part = withToolUseFacts(body, claimFrom(frame), results);
        return part === null ? [] : [part];
      });
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
        request: withToolUseFacts(
          pair.request,
          claimFrom(fold.request),
          results,
        ),
        response: withToolUseFacts(
          pair.response,
          claimFrom(fold.response),
          results,
        ),
        ...(parts.length > 0 ? { parts } : {}),
        decision: fold.decision === null ? null : decisionView(fold.decision),
        frames: fold.frames,
        turn: turnOf(fold.turn),
        cost: cost(fold.costMicros),
        cumulativeCost: cost(costThrough.get(fold.last) ?? null),
        key: fold.key,
        parentKey: fold.parentKey,
        node: fold.node,
        quiet: fold.quiet,
        outcome: fold.outcome,
        error: countsAsError(fold),
        approvalId: fold.approvalId,
        gates: fold.gates.map(decisionView),
        subject: fold.subject,
        tool: fold.subject === null ? null : bareToolName(fold.subject),
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
      ...ahead,
      complete: read.complete,
      frameCursor,
      ...tallies,
      ...search,
    };
  };
}

const readTranscript = createRunTranscriptGetHandler({
  ...defaultRunReadDeps(),
  get bodies() {
    return evidenceStore();
  },
  priceBook: loadPriceBookSliceInTenantScope,
});

/**
 * The registered handler. The kernel allows every call below Enterprise, so
 * this checks the contract's roles before any read: a workspace Viewer may
 * not read a transcript (#3458). The check sits here and not in the factory,
 * so the factory's tests build a reader with no role fixture.
 */
export const runTranscriptGetHandler: CapabilityHandler<
  typeof runTranscriptGet
> = async (input, ctx) => {
  await assertContractRole(runTranscriptGet, ctx);
  return readTranscript(input, ctx);
};
