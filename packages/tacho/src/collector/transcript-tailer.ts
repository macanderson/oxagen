/**
 * Tails Claude Code session transcripts, and Codex rollouts, into their
 * recorders.
 *
 * The transcript (`~/.claude/projects/<project>/<session>.jsonl`) is the one
 * source that carries a model call's full usage: the 5m/1h cache split, the
 * thinking tokens, the message and request ids. `transcript.ts` has
 * normalized it since the package existed, and `SessionRecorder.
 * ingestTranscriptLine` has sealed it, but nothing in the daemon ever read
 * the file: the detector only stats its mtime. Production showed the gap as
 * zero `llm_call` rows in a session record of 496 events, so the Run page's
 * Cost tab had nothing to price.
 *
 * The tailer keeps one byte cursor per session transcript and advances it on
 * the daemon's tick. One tick reads at most `budgetBytes` from each file and
 * starts no further file once it has read `tickBudgetBytes` in all. The next
 * tick picks up the rest. A new install can find hundreds of transcripts it
 * has never read, and one tick used to read all of them (#4394).
 *
 * The tick reads a transcript's bytes outside the daemon's hook queues and
 * takes the session's queue (`exclusive`) only to seal what it read, the way
 * the git lane splits its reads from applying them (ADR-231). A hook
 * therefore never waits on the tick's reads, and waits on its seals only when
 * they are its own session's. The seals of one read go in slices of at most
 * `SEAL_SLICE_BYTES`, with a turn of the event loop between them, so the
 * synchronous work of sealing never holds the loop for a whole read. A hook
 * can move the cursor while the tick reads, a `Stop` draining its transcript
 * for one, so each slice checks, inside the queue, that the cursor still
 * stands where the read began. When it does not, the tick drops what it read
 * and the next tick reads from where the cursor is now.
 *
 * A subagent transcript gets a byte cursor of its own and is tailed the same
 * way, fed with the subagent id so the child chain receives it. Claude Code
 * writes it to `<session>/subagents/agent-<agent id>.jsonl` beside the
 * session's own `<session>.jsonl`, or, for an agent a workflow runs, one
 * level further down in `subagents/workflows/<workflow id>/`. The tick finds
 * both by listing those directories. `SubagentStart` names no path, and a
 * hook can be lost, so the listing is what finds a subagent whose hooks
 * never arrived. `SubagentStop` drains what is left before the child chain
 * closes, then retires the cursor. The transcript used to be read only
 * there, whole, up to 64 MiB, inside the hook the harness waits on: a longer
 * one lost its tail, and a lost `SubagentStop` meant it was never read
 * (R-11).
 *
 * Cursors are persisted next to the daemon state. Without that a restart
 * would re-read every open transcript from byte 0 and seal every message a
 * second time onto a chain that already holds it. A reader that keeps state
 * between lines keeps it on the cursor too (`FileCursor.codex`), so the
 * state and the offset are always written together.
 *
 * A Codex subagent's rollout is tailed on a subagent cursor as well, but
 * Codex writes it beside the parent's rollout, so the daemon opens that
 * cursor from the subagent's hooks (`noteSubagentTranscript`) rather than
 * from a directory listing.
 *
 * A cursor outlives its session in the registry. `forgetSealed` drops a
 * sealed session a week after it was last seen and keeps a chain tombstone
 * for `TOMBSTONE_RETAIN_MS` (thirty days), because Claude Code can resume
 * the session under the same id for as long as it keeps the transcript. The
 * tailer keeps the forgotten session's cursor for the same span, stamped
 * with `forgottenAtMs`, and reopens it when the session is listed again. A
 * resume then reads on from the last line read before the session was
 * forgotten. Dropping the cursor made the resume start a fresh one at byte
 * 0, and every earlier model call sealed a second `llm_call` on the
 * continued chain (#4345).
 *
 * Every file call goes through `fs.promises`. The daemon's tick runs on the
 * same thread that answers hooks and `GET /health`, and a synchronous read
 * of 4 MiB holds both; the detector's synchronous scan already showed what
 * that costs (see detector.ts).
 */
import { promises as fs } from "node:fs";
import { basename, join } from "node:path";
import type { SessionRecorder } from "../claude-code/recorder";
import type { CodexRolloutState } from "../codex/rollout";
import type { TachoEvent } from "../envelope";
import type { FrameBody } from "../evidence/frame-body";
import { readJsonStateFile, writeSensitiveFileAtomic } from "../host/fs";
import type { TachoHarness } from "../wire";
import { MAX_TOMBSTONES, sessionMapKey, TOMBSTONE_RETAIN_MS } from "./registry";

/** The most bytes one tick reads from one transcript. */
export const DEFAULT_TAIL_BUDGET_BYTES = 4 * 1024 * 1024;

/**
 * The most bytes one tick reads across all transcripts, subagents' included.
 * A file is read a full budget or not at all, so the tick starts no file once
 * less than one budget of this is left. The next tick starts with the session
 * and the file this one could not start.
 */
export const DEFAULT_TICK_BUDGET_BYTES = 16 * 1024 * 1024;

/**
 * The most transcript bytes sealed in one synchronous stretch. Sealing a line
 * parses it, hashes the frame, and appends it to the WAL on the event loop,
 * so a 4 MiB read sealed at once held every hook and `/status` for as long.
 */
export const SEAL_SLICE_BYTES = 256 * 1024;

/**
 * Harnesses whose transcript the recorder has a reader for. Claude Code's
 * JSONL goes through `claude-code/transcript.ts`, and a session whose
 * harness is `undefined` speaks Claude Code's own hook shape too (custom
 * agent sessions and legacy records both default this way) and is tailed
 * the same. Codex's rollout goes through `codex/rollout.ts`; the recorder
 * picks the reader by the session's harness (ADR-262).
 *
 * A Cursor session can carry a `transcript_path` too: Cursor's hook payload
 * has none, but a session can inherit one from an earlier Claude Code
 * identity. Nothing reads Cursor's transcript shape yet, and tailing it fed
 * every line through a reader that does not understand it: nothing sealed,
 * and once a refused line seals a `telemetry_gap` (see `advance`), a gap
 * frame every pass for a transcript this reader was never going to make
 * sense of. So Cursor stays out of this set until it has a reader.
 */
const TRANSCRIPT_NORMALIZED_HARNESSES: ReadonlySet<TachoHarness> = new Set([
  "claude-code",
  "codex",
]);

/** Whether the recorder has a transcript reader for this session's harness. */
function hasTranscriptNormalizer(
  session: Pick<TailedSession, "harness">,
): boolean {
  return (
    session.harness === undefined ||
    TRANSCRIPT_NORMALIZED_HARNESSES.has(session.harness)
  );
}

/**
 * The directory Claude Code writes a session's subagent transcripts to:
 * `<dir>/<session>/subagents/`, beside the session's `<dir>/<session>.jsonl`.
 * Undefined for a transcript path that does not end in `.jsonl`.
 */
export function subagentDirOf(transcriptPath: string): string | undefined {
  if (!transcriptPath.endsWith(".jsonl")) return undefined;
  return join(transcriptPath.slice(0, -".jsonl".length), "subagents");
}

/**
 * The agent id a subagent transcript's file name carries, the same id the
 * `SubagentStart` and `SubagentStop` hooks send as `agent_id`: `agent-<id>.jsonl`.
 * Undefined for anything else in the directory, such as the
 * `agent-<id>.meta.json` beside each transcript or a workflow's
 * `journal.jsonl`.
 */
export function subagentIdOf(path: string): string | undefined {
  return /^agent-(.+)\.jsonl$/.exec(basename(path))?.[1];
}

/** What the tailer needs from a registered session. */
export interface TailedSession {
  harnessSessionId: string;
  /** Which harness runs the session; keys the cursor with the registry. */
  harness?: TachoHarness;
  /** A custom agent's name; keys the cursor with the registry. */
  customAgent?: string;
  transcriptPath?: string;
  sealed: boolean;
  recorder: Pick<
    SessionRecorder,
    | "ingestTranscriptLine"
    | "takeBodies"
    | "markChain"
    | "rollbackChain"
    | "sealCollectorEvent"
  >;
}

export interface TranscriptTailerOptions {
  sessions: () => readonly TailedSession[];
  session: (harnessSessionId: string) => TailedSession | undefined;
  /** Takes the events and, in the same call, the bodies sealed with them. */
  record: (events: readonly TachoEvent[], bodies: readonly FrameBody[]) => void;
  /** Where cursors persist; omitted in tests that want none. */
  statePath?: string;
  budgetBytes?: number;
  /** See `DEFAULT_TICK_BUDGET_BYTES`. */
  tickBudgetBytes?: number;
  /**
   * Run `apply` where the session's hooks cannot interleave with it: the
   * daemon's queue for that session. The tick seals through this. `drain`
   * and `ingestSubagentTranscript` do not, because a hook calls them from
   * inside that queue. Omitted, `apply` runs at once.
   */
  exclusive?: <T>(session: TailedSession, apply: () => T) => Promise<T>;
  log?: (line: string) => void;
  /** Epoch ms; defaults to `Date.now`. A test supplies a controllable clock. */
  now?: () => number;
  /** How long a sealed session's transcript may sit unchanged before its cursor drains; see `DEFAULT_SEALED_TAIL_IDLE_MS`. */
  sealedIdleMs?: number;
}

/**
 * How long a sealed session's transcript may go without growing before the
 * tailer stops reading it. `agent_stop` is not always the transcript's last
 * write: Claude Code has flushed a `cost-state` or a final `assistant`
 * record after it before, and a chain that stopped reading the instant it
 * saw `sealed` lost whatever landed after. Five minutes is long enough for
 * that kind of trailing write and short enough that a transcript from a
 * session that will never write again does not hold a cursor (and a stat
 * call every tick) indefinitely.
 */
export const DEFAULT_SEALED_TAIL_IDLE_MS = 5 * 60 * 1000;

/** Where one transcript file has been read to. */
interface FileCursor {
  path: string;
  /** The byte offset of the first line not yet fed to the recorder. */
  offset: number;
  /** The inode last seen at `path`; a different one is a new file. */
  ino?: number;
  /**
   * The file's first bytes (base64, at most `HEAD_BYTES`) as the cursor last
   * read them. Linux hands a freed inode number straight to the next file
   * created, so a transcript deleted and rewritten at the same path can keep
   * its inode and outgrow the cursor; a changed head is how that is seen.
   * A transcript only grows, so its head never changes on its own.
   */
  head?: string;
  /**
   * Lines this cursor moved past that the recorder refused, and that no gap
   * frame on the chain accounts for yet. Held here, and persisted with the
   * offset, until the gap is written, so a gap that cannot be written this
   * pass is carried to the next one rather than lost.
   */
  refused?: { count: number; detail: string };
  /**
   * What the Codex rollout reader keeps from one line to the next: the
   * thread's model and provider, and the text of a response whose usage
   * record has not arrived yet. It sits beside the offset and persists with
   * it, so a restart between a response's text and its record reads on with
   * the text in hand. Absent for every other harness.
   */
  codex?: CodexRolloutState;
}

interface Cursor extends FileCursor {
  /**
   * Subagents whose transcript is finished: drained at their `SubagentStop`,
   * or read whole there by a build before subagents were tailed. None of
   * them is read again, so a replayed `SubagentStop` feeds nothing twice and
   * an upgrade does not feed a finished transcript a second time.
   */
  subagents: string[];
  /**
   * Subagent transcripts still being tailed, by agent id. A build before
   * subagents were tailed ignores this field. A daemon rolled back to one
   * reads each of these subagents from byte 0 at its `SubagentStop`, and
   * seals again what this build already fed.
   */
  agents?: Record<string, FileCursor>;
  /**
   * Set once a sealed session's transcript has gone `sealedIdleMs` without
   * growing, so the cursor stops reading it. The cursor then stays as a
   * tombstone for as long as the registry lists the sealed session (seven
   * days), and for `TOMBSTONE_RETAIN_MS` after it forgets the session (see
   * `forgottenAtMs`). Nothing reads the transcript again unless the session
   * resumes. Dropping it sooner lets the next tick make a fresh cursor at
   * byte 0 and append the whole transcript after `agent_stop`.
   */
  drained?: boolean;
  /**
   * Epoch ms this cursor last saw its transcript grow while the session was
   * sealed. Unset while the session is still open, and reset every time a
   * sealed transcript grows, so `drained` is set only once it has been
   * genuinely quiet for `sealedIdleMs`, not merely stopped for one tick.
   */
  sealedQuietSinceMs?: number;
  /**
   * Epoch ms of the first tick that found the session missing from the
   * registry. The cursor is kept, read position and subagent cursors
   * included, for `TOMBSTONE_RETAIN_MS` after that, the span the registry
   * keeps the chain tombstone a resume continues from. A resume inside it
   * reads only what the transcript gained after the last line read. Cleared
   * when the session is listed again. Absent in state files written before
   * forgotten cursors were kept, and a build that predates it drops the
   * cursor as before.
   */
  forgottenAtMs?: number;
}

interface PersistedTailState {
  schema: "tacho.transcript-tail.v1";
  cursors: Record<string, Cursor>;
}

function isPersistedTailState(value: unknown): value is PersistedTailState {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { schema?: unknown }).schema === "tacho.transcript-tail.v1" &&
    typeof (value as { cursors?: unknown }).cursors === "object"
  );
}

interface FileStat {
  size: number;
  ino: number;
}

async function statIfExists(path: string): Promise<FileStat | undefined> {
  try {
    const st = await fs.stat(path);
    return { size: st.size, ino: st.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** How many leading bytes of a transcript the cursor fingerprints. */
const HEAD_BYTES = 64;

/**
 * What one pass over a transcript did: the lines it fed, refused ones
 * included, whether a stat or read failed and stopped it short of the end of
 * the file, and the bytes it moved the cursor past.
 */
interface Pass {
  fed: number;
  failed: boolean;
  bytes: number;
}

/**
 * Where a pass seals what it read, and how it knows its cursor still stands.
 * The tick seals through the session's queue and checks that the cursor it
 * read with is still the one kept for the file. A drain runs inside that
 * queue already, so it seals at once and its cursor always stands.
 */
interface Sealer {
  run<T>(apply: () => T): Promise<T>;
  current(): boolean;
}

/** The sealer of a pass that already runs inside the session's queue. */
const IN_QUEUE: Sealer = {
  run: async (apply) => apply(),
  current: () => true,
};

/**
 * The session's own transcript in a tick's list of files, beside its
 * subagents' ids. A subagent id is a string, so `null` cannot equal one.
 */
const OWN_TRANSCRIPT = null;

/** One turn of the event loop, so a hook or `/status` waiting on it runs. */
function yieldTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Read `length` bytes at `offset`, or fewer at end of file. */
async function readAt(
  path: string,
  offset: number,
  length: number,
): Promise<Buffer> {
  const handle = await fs.open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** An error's message, or the thrown value as text. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Split a chunk at its last newline. Bytes after it are a line the writer has
 * not finished; they stay on disk and are re-read once the newline lands.
 * UTF-8 never encodes a byte 0x0A inside a multibyte character, so splitting
 * on the byte is safe before decoding.
 */
export function completeLines(chunk: Buffer): {
  lines: string[];
  consumed: number;
} {
  const end = chunk.lastIndexOf(0x0a);
  if (end < 0) return { lines: [], consumed: 0 };
  const text = chunk.subarray(0, end).toString("utf8");
  return { lines: text.split("\n"), consumed: end + 1 };
}

export class TranscriptTailer {
  private readonly cursors = new Map<string, Cursor>();
  private readonly options: TranscriptTailerOptions;
  private readonly budget: number;
  private readonly tickBudget: number;
  private dirty = false;
  /** The tick running now, or the last one, settled either way. */
  private ticking: Promise<void> = Promise.resolve();
  /** The cursor key of the first session the last tick's budget left unread. */
  private resumeAt: string | undefined;
  /**
   * For each session the last tick's budget cut short, the file it did not
   * start: a subagent id, or `OWN_TRANSCRIPT` for the session's own.
   */
  private readonly fileResumeAt = new Map<
    string,
    string | typeof OWN_TRANSCRIPT
  >();

  constructor(options: TranscriptTailerOptions) {
    this.options = options;
    this.budget = options.budgetBytes ?? DEFAULT_TAIL_BUDGET_BYTES;
    this.tickBudget = Math.max(
      options.tickBudgetBytes ?? DEFAULT_TICK_BUDGET_BYTES,
      this.budget,
    );
    if (options.statePath !== undefined) {
      const persisted = readJsonStateFile(options.statePath, (movedTo) =>
        options.log?.(
          movedTo === undefined
            ? "transcript tail state did not parse and could not be moved aside; starting without it"
            : `transcript tail state did not parse; moved it to ${movedTo} and started without it`,
        ),
      );
      if (isPersistedTailState(persisted)) {
        for (const [id, cursor] of Object.entries(persisted.cursors))
          this.cursors.set(id, {
            ...cursor,
            subagents: cursor.subagents ?? [],
          });
      }
    }
  }

  /** The cursors, for persistence and for tests. */
  state(): PersistedTailState {
    return {
      schema: "tacho.transcript-tail.v1",
      cursors: Object.fromEntries(this.cursors),
    };
  }

  private persist(): void {
    if (!this.dirty || this.options.statePath === undefined) return;
    writeSensitiveFileAtomic(
      this.options.statePath,
      JSON.stringify(this.state()),
    );
    this.dirty = false;
  }

  /** The cursor map key: agent identity plus the raw harness session id. */
  private cursorKey(session: TailedSession): string {
    return sessionMapKey(session.harnessSessionId, session);
  }

  /**
   * The cursor for this session under its agent-qualified key.
   */
  private cursorFor(session: TailedSession, path: string): Cursor {
    this.reopenIfResumed(session);
    const key = this.cursorKey(session);
    const existing = this.cursors.get(key) ?? this.adoptLegacy(session, key);
    // A drained cursor is final whatever path the session reports now.
    if (existing?.drained) return existing;
    if (existing !== undefined && existing.path === path) return existing;
    // A session that reports a different transcript path (a resume that
    // moved projects) starts over on the new file; the old one is done.
    const cursor: Cursor = {
      path,
      offset: 0,
      subagents: existing?.subagents ?? [],
      // A subagent cursor names its own file, so the new path leaves it
      // where it was reading.
      ...(existing?.agents !== undefined ? { agents: existing.agents } : {}),
    };
    this.cursors.set(key, cursor);
    this.dirty = true;
    return cursor;
  }

  /**
   * A resume reopens a sealed session, and its cursor with it: the
   * transcript is read again from where the cursor stopped. Left drained,
   * every model call the resumed session made was lost. A cursor still in
   * its quiet grace kept the sealed session's `sealedQuietSinceMs`, and the
   * next seal drained it with no grace at all. Only the read position
   * carries over, nothing the sealed session left on the cursor.
   * A cursor kept after the registry forgot its session reopens the same
   * way when a resume opens the session again, and its `forgottenAtMs` goes
   * with the rest.
   * A drained cursor that never read its file (the one `tick` makes for a
   * sealed session it holds none for) does not know where the recorded part
   * ends, so it stays final rather than feed the whole transcript a second
   * time.
   */
  private reopenIfResumed(session: TailedSession): void {
    if (session.sealed) return;
    const key = this.cursorKey(session);
    const cursor = this.cursors.get(key) ?? this.adoptLegacy(session, key);
    if (cursor === undefined) return;
    const reopens =
      cursor.drained === true
        ? cursor.ino !== undefined
        : cursor.sealedQuietSinceMs !== undefined;
    if (!reopens) return;
    this.cursors.set(key, {
      path: cursor.path,
      offset: cursor.offset,
      ...(cursor.ino !== undefined ? { ino: cursor.ino } : {}),
      ...(cursor.head !== undefined ? { head: cursor.head } : {}),
      subagents: cursor.subagents,
      // Each subagent cursor keeps its place too, or the next tick would
      // read its transcript from byte 0 onto a chain that holds it.
      ...(cursor.agents !== undefined ? { agents: cursor.agents } : {}),
      // Lines already passed that no gap names yet: still owed to the chain.
      ...(cursor.refused !== undefined ? { refused: cursor.refused } : {}),
      // The reader's state belongs to the offset, so it reopens with it.
      ...(cursor.codex !== undefined ? { codex: cursor.codex } : {}),
    });
    this.dirty = true;
  }

  /**
   * Advance every live cursor by at most the budget, and keep the cursors of
   * sessions that left the registry as tombstones (`keepForgotten`). A
   * drained cursor is reopened when its session is.
   *
   * Ticks run one after another. The daemon's interval and a caller stepping
   * it by hand can both ask for one, and a tick asked for while another runs
   * starts once that one ends, so it still reads what was written before it
   * was asked for.
   */
  tick(): Promise<void> {
    const run = this.ticking.then(() => this.tickOnce());
    this.ticking = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * A session's files in tick order: its open subagents' transcripts, then
   * its own, starting from the file the last tick left unread in it.
   */
  private filesInTickOrder(
    key: string,
    cursor: Cursor,
  ): Array<string | typeof OWN_TRANSCRIPT> {
    const files: Array<string | typeof OWN_TRANSCRIPT> = [
      ...Object.keys(cursor.agents ?? {}),
      OWN_TRANSCRIPT,
    ];
    const at = this.fileResumeAt.has(key)
      ? files.indexOf(this.fileResumeAt.get(key) as string | null)
      : -1;
    return at <= 0 ? files : [...files.slice(at), ...files.slice(0, at)];
  }

  /** The sessions in tick order: from the one the last tick left unread. */
  private inTickOrder(sessions: readonly TailedSession[]): TailedSession[] {
    const at =
      this.resumeAt === undefined
        ? -1
        : sessions.findIndex(
            (session) => this.cursorKey(session) === this.resumeAt,
          );
    return at <= 0
      ? [...sessions]
      : [...sessions.slice(at), ...sessions.slice(0, at)];
  }

  /**
   * The sealer for a cursor the tick reads outside the session's queue.
   * `current` answers whether the cursor is still the one kept for its file,
   * since a hook in the queue can replace it while the tick reads.
   */
  private tickSealer(session: TailedSession, current: () => boolean): Sealer {
    const exclusive = this.options.exclusive;
    return {
      run: (apply) =>
        exclusive === undefined
          ? Promise.resolve().then(apply)
          : exclusive(session, apply),
      // The tick took `session` before it read, and its seal waits in the
      // session's queue behind any host task. A host task can replace the
      // record (the registry's restore builds new ones), and a seal through
      // the old recorder would write past the chain the new one holds, so
      // every later seal on that chain is refused. A replaced record seals
      // nothing and the cursor stays put: the next tick reads the same lines
      // through the record the registry lists then.
      current: () =>
        current() && this.options.sessions().includes(session),
    };
  }

  private async tickOnce(): Promise<void> {
    for (const session of this.options.sessions())
      this.reopenIfResumed(session);
    const live = new Set<string>();
    let left = this.tickBudget;
    let cutAt: string | undefined;
    for (const session of this.inTickOrder(this.options.sessions())) {
      const key = this.cursorKey(session);
      live.add(key);
      if (session.transcriptPath === undefined) continue;
      if (!hasTranscriptNormalizer(session)) continue;
      // A session is read in full budget or not at all this tick. Read short,
      // a sealed session would count the bytes it did not reach as quiet.
      if (left < this.budget) {
        cutAt ??= key;
        continue;
      }
      // One session's advance is caught here, not only inside `advance`
      // itself: a throw this loop did not expect — from `cursorFor`, from
      // `this.options.record` (a WAL write), from anything other than the
      // per-line path `advance` already guards — must not stop every other
      // session's transcript from being tailed for the rest of this tick.
      try {
        const existing =
          this.cursors.get(key) ?? this.adoptLegacy(session, key);
        if (existing?.drained) continue;
        if (session.sealed && existing === undefined) {
          // Sealed with no cursor: a daemon before the tombstone dropped it,
          // or its state file was lost. Either way the chain is closed, and
          // reading from byte 0 would append the transcript after agent_stop.
          this.cursors.set(key, {
            path: session.transcriptPath,
            offset: 0,
            subagents: [],
            drained: true,
          });
          this.dirty = true;
          continue;
        }
        const cursor = this.cursorFor(session, session.transcriptPath);
        const sealer = this.tickSealer(
          session,
          () => this.cursors.get(key) === cursor,
        );
        await this.findSubagents(session, cursor);
        const before = cursor.offset;
        let subagentsGrew = false;
        let deferred = false;
        let ownFailed = false;
        // Every file of the session, its subagents' and its own, is read a
        // full budget or not at all, and none is started once less than a
        // budget of the tick is left. The file this tick could not start goes
        // first in this session on the next tick, so no file waits forever
        // behind the others.
        for (const id of this.filesInTickOrder(key, cursor)) {
          if (left < this.budget) {
            this.fileResumeAt.set(key, id);
            cutAt ??= key;
            deferred = true;
            break;
          }
          if (id === OWN_TRANSCRIPT) {
            // Caught here so a failed read of the session's own transcript
            // costs its subagents no pass when it comes first in the order.
            try {
              const pass = await this.advance(
                session,
                cursor,
                this.budget,
                sealer,
              );
              left -= pass.bytes;
            } catch (error) {
              ownFailed = true;
              this.options.log?.(
                `transcript tail for ${session.harnessSessionId} failed this tick: ${describe(error)}`,
              );
            }
            continue;
          }
          const agent = cursor.agents?.[id];
          if (agent === undefined) continue;
          const at = agent.offset;
          left -= await this.advanceSubagent(
            session,
            id,
            agent,
            this.budget,
            this.tickSealer(
              session,
              () => this.cursors.get(key)?.agents?.[id] === agent,
            ),
          );
          if (agent.offset !== at) subagentsGrew = true;
        }
        if (!deferred) this.fileResumeAt.delete(key);
        if (session.sealed) {
          // A sealed chain still gets read at the normal budget, tick after
          // tick, until its transcript has sat unchanged for `sealedIdleMs`:
          // Claude Code has written a trailing `cost-state` or a final
          // `assistant` record after `agent_stop` before, and one pass right
          // at seal time is not guaranteed to be the last write. See
          // `DEFAULT_SEALED_TAIL_IDLE_MS`. A subagent still writing counts as
          // growth too: a background agent can outlive its parent's last
          // write, and a drained cursor would stop reading it. A tick that
          // left one of the session's files unread, or failed to read its
          // own, cannot say the session was quiet. It neither starts nor ends
          // the quiet time.
          const now = this.options.now?.() ?? Date.now();
          if (cursor.offset > before || subagentsGrew) {
            delete cursor.sealedQuietSinceMs;
            this.dirty = true;
          } else if (deferred || ownFailed) {
            // Nothing to record this tick.
          } else if (cursor.sealedQuietSinceMs === undefined) {
            cursor.sealedQuietSinceMs = now;
            this.dirty = true;
          } else if (
            now - cursor.sealedQuietSinceMs >=
            (this.options.sealedIdleMs ?? DEFAULT_SEALED_TAIL_IDLE_MS)
          ) {
            cursor.drained = true;
            this.dirty = true;
          }
        }
      } catch (error) {
        this.options.log?.(
          `transcript tail for ${session.harnessSessionId} failed this tick: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    this.resumeAt = cutAt;
    // A hook can open a cursor while this tick awaits a read, for a session
    // the registry did not list when the tick began. Only a session the
    // registry does not list now counts as forgotten.
    for (const session of this.options.sessions())
      live.add(this.cursorKey(session));
    for (const key of this.fileResumeAt.keys())
      if (!live.has(key)) this.fileResumeAt.delete(key);
    this.keepForgotten(live);
    this.persist();
  }

  /**
   * Keep the cursor of every session the registry no longer lists, for as
   * long as the registry keeps that session's chain tombstone: at most
   * `TOMBSTONE_RETAIN_MS` after this tick first found it missing, and at
   * most `MAX_TOMBSTONES` of them, oldest dropped first.
   *
   * The registry's tombstone holds the chain's position only, and this
   * cursor is the read position, so it has to live as long. Deleted here, as
   * it was, the resume made a fresh cursor at byte 0 and fed the whole
   * transcript to a recorder whose call ledgers were empty (#4345). A fresh
   * cursor cannot start at the end of the file instead: the lines a resumed
   * session writes before the next tick would be lost.
   *
   * A cursor whose session is listed again loses its stamp and is live.
   */
  private keepForgotten(live: ReadonlySet<string>): void {
    const now = this.options.now?.() ?? Date.now();
    const kept: Array<[string, number]> = [];
    for (const [key, cursor] of this.cursors) {
      if (live.has(key)) {
        if (cursor.forgottenAtMs !== undefined) {
          delete cursor.forgottenAtMs;
          this.dirty = true;
        }
        continue;
      }
      // Stamped on the first tick that finds the session missing. A stamp
      // that is not a number came from a damaged state file, and is replaced
      // so the cursor still expires.
      if (
        typeof cursor.forgottenAtMs !== "number" ||
        !Number.isFinite(cursor.forgottenAtMs)
      ) {
        cursor.forgottenAtMs = now;
        this.dirty = true;
      }
      // The comparison `forgetSealed` makes for the chain tombstone.
      if (cursor.forgottenAtMs < now - TOMBSTONE_RETAIN_MS) {
        this.cursors.delete(key);
        this.dirty = true;
        continue;
      }
      kept.push([key, cursor.forgottenAtMs]);
    }
    if (kept.length <= MAX_TOMBSTONES) return;
    kept.sort(([, a], [, b]) => a - b);
    for (const [key] of kept.slice(0, kept.length - MAX_TOMBSTONES)) {
      this.cursors.delete(key);
      this.dirty = true;
    }
  }

  /**
   * Move a pre-namespaced cursor onto the default agent's key, or undefined
   * when there is none to adopt. Only Claude Code (no harness, no custom
   * agent) takes a legacy raw-id entry, so a custom agent sharing that id
   * never inherits another agent's tombstone.
   */
  private adoptLegacy(session: TailedSession, key: string): Cursor | undefined {
    const legacy = this.cursors.get(session.harnessSessionId);
    if (
      legacy === undefined ||
      key !== sessionMapKey(session.harnessSessionId, {})
    )
      return undefined;
    this.cursors.delete(session.harnessSessionId);
    this.cursors.set(key, legacy);
    this.dirty = true;
    return legacy;
  }

  /**
   * Read everything the session's transcript holds right now, unbounded.
   * Called before a `Stop` or `SessionEnd` hook is sealed so the turn's model
   * calls sit on the chain before the frame that closes the turn.
   *
   * `SessionEnd` also reads every subagent transcript to its end, so a
   * subagent whose `SubagentStop` was lost has its transcript on the child
   * chain before that chain closes. `Stop` ends a turn, not the session, and
   * fires once a turn while the harness waits on it: a subagent still
   * running is read at most one budget there, as on the tick, which finishes
   * the rest.
   *
   * The hook calls this from inside its session's queue, so it seals at once.
   * It holds that session's queue while it reads, and no other.
   */
  async drain(
    harnessSessionId: string,
    hook: "Stop" | "SessionEnd" = "SessionEnd",
  ): Promise<void> {
    const session = this.options.session(harnessSessionId);
    if (session?.transcriptPath === undefined) return;
    if (!hasTranscriptNormalizer(session)) return;
    const cursor = this.cursorFor(session, session.transcriptPath);
    if (cursor.drained) return;
    await this.advance(session, cursor, Number.POSITIVE_INFINITY, IN_QUEUE);
    await this.tailSubagents(
      session,
      cursor,
      hook === "SessionEnd" ? Number.POSITIVE_INFINITY : this.budget,
      IN_QUEUE,
    );
    this.persist();
  }

  /**
   * Feed the rest of a finished subagent's transcript to the child chain,
   * then stop tailing it. Called on `SubagentStop`, before the hook closes
   * the child chain. The tick has usually read most of it already, so this
   * reads only what landed since. Returns the number of lines this call fed,
   * `0` for a subagent already finished, or undefined when the file is not
   * there or the session is not known.
   */
  async ingestSubagentTranscript(
    harnessSessionId: string,
    subagentId: string,
    path: string,
  ): Promise<number | undefined> {
    const session = this.options.session(harnessSessionId);
    if (session === undefined) return undefined;
    if (!hasTranscriptNormalizer(session)) return undefined;
    const cursor = this.cursorFor(
      session,
      session.transcriptPath ??
        this.cursors.get(this.cursorKey(session))?.path ??
        "",
    );
    if (cursor.subagents.includes(subagentId)) return 0;
    // The cursor the tick opened, when it found the file first. It is keyed
    // by the agent id, so the hook's path and the listed path meet on it.
    let sub = cursor.agents?.[subagentId];
    if (sub === undefined) {
      if ((await statIfExists(path)) === undefined) return undefined;
      sub = { path, offset: 0 };
      cursor.agents = { ...cursor.agents, [subagentId]: sub };
      this.dirty = true;
    }
    // Unbounded: the harness waits on this hook, but only for what the tick
    // has not read yet. A gap that cannot be written throws here, before the
    // subagent is retired, so the tick keeps the cursor where it stopped and
    // writes the gap on a later pass.
    const { fed, failed } = await this.advance(
      session,
      sub,
      Number.POSITIVE_INFINITY,
      IN_QUEUE,
      subagentId,
    );
    if (failed) {
      // A read that failed (EMFILE, EIO) left the rest of the file unread.
      // Retired now, the cursor would never read it. Kept, the tick reads it
      // once the file can be read again.
      this.options.log?.(
        `subagent transcript ${sub.path} stays open after its SubagentStop: the read failed at ${sub.offset}`,
      );
      this.persist();
      return fed;
    }
    const agents = { ...cursor.agents };
    delete agents[subagentId];
    if (Object.keys(agents).length > 0) cursor.agents = agents;
    else delete cursor.agents;
    cursor.subagents.push(subagentId);
    this.dirty = true;
    this.persist();
    return fed;
  }

  /**
   * Start tailing a Codex subagent's rollout on a cursor of its own, fed
   * with the subagent id so the child chain receives it. Codex sends the
   * subagent's rollout as `transcript_path` on every hook a spawned subagent
   * fires except `SubagentStop`, under the root session's id, and writes the
   * file beside the parent's rollout, where `findSubagents` does not look.
   * A hook calls this from inside its session's queue, so it opens the
   * cursor and reads nothing: the tick reads the file, and `SubagentStop`
   * drains it (`ingestSubagentTranscript`).
   */
  noteSubagentTranscript(
    harnessSessionId: string,
    subagentId: string,
    path: string,
  ): void {
    const session = this.options.session(harnessSessionId);
    if (session?.harness !== "codex") return;
    const own = session.transcriptPath;
    if (own === undefined || path === own) return;
    const cursor = this.cursorFor(session, own);
    if (cursor.drained) return;
    if (cursor.subagents.includes(subagentId)) return;
    if (cursor.agents?.[subagentId] !== undefined) return;
    cursor.agents = { ...cursor.agents, [subagentId]: { path, offset: 0 } };
    this.dirty = true;
  }

  /**
   * Open a cursor for every subagent transcript under the session's
   * `subagents/` directory that has none and is not finished.
   */
  private async findSubagents(
    session: TailedSession,
    cursor: Cursor,
  ): Promise<void> {
    // Codex writes a subagent's rollout beside its parent's, not under a
    // `subagents/` directory. Its hooks name it (`noteSubagentTranscript`).
    if (session.harness === "codex") return;
    const dir =
      session.transcriptPath === undefined
        ? undefined
        : subagentDirOf(session.transcriptPath);
    if (dir === undefined) return;
    for (const path of await this.subagentTranscripts(dir)) {
      const id = subagentIdOf(path);
      if (id === undefined) continue;
      if (cursor.subagents.includes(id)) continue;
      if (cursor.agents?.[id] !== undefined) continue;
      cursor.agents = { ...cursor.agents, [id]: { path, offset: 0 } };
      this.dirty = true;
    }
  }

  /**
   * Advance one subagent transcript by at most `budget` and answer how many
   * bytes the read moved past. A failure is logged and costs no other
   * transcript its pass, the parent's included.
   */
  private async advanceSubagent(
    session: TailedSession,
    id: string,
    agent: FileCursor,
    budget: number,
    sealer: Sealer,
  ): Promise<number> {
    try {
      const pass = await this.advance(session, agent, budget, sealer, id);
      return pass.bytes;
    } catch (error) {
      this.options.log?.(
        `subagent transcript ${agent.path} failed this pass: ${describe(error)}`,
      );
      return 0;
    }
  }

  /**
   * Find the session's subagent transcripts and advance each open one by at
   * most `budget`, for a hook that drains them in its session's queue. The
   * tick reads subagents file by file against its own allowance instead.
   */
  private async tailSubagents(
    session: TailedSession,
    cursor: Cursor,
    budget: number,
    sealer: Sealer,
  ): Promise<void> {
    await this.findSubagents(session, cursor);
    for (const [id, agent] of Object.entries(cursor.agents ?? {}))
      await this.advanceSubagent(session, id, agent, budget, sealer);
  }

  /**
   * Every subagent transcript under a session's `subagents/` directory,
   * sorted: `agent-<id>.jsonl` in the directory itself, and in each
   * `workflows/<workflow id>/` one level down, where Claude Code writes the
   * agents a workflow runs beside the workflow's `journal.jsonl`. On one host
   * those were 3,634 of 5,059 subagent transcripts.
   */
  private async subagentTranscripts(dir: string): Promise<string[]> {
    const paths = (await this.listDir(dir)).map((name) => join(dir, name));
    const workflows = join(dir, "workflows");
    for (const workflow of await this.listDir(workflows)) {
      const at = join(workflows, workflow);
      for (const name of await this.listDir(at)) paths.push(join(at, name));
    }
    return paths.filter((path) => subagentIdOf(path) !== undefined).sort();
  }

  /**
   * The names in a directory, or none when it is not there. No subagent has
   * written yet in most sessions, and a workflow entry can be a file.
   */
  private async listDir(dir: string): Promise<string[]> {
    try {
      return await fs.readdir(dir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR")
        this.options.log?.(
          `subagent transcripts in ${dir} unreadable: ${describe(error)}`,
        );
      return [];
    }
  }

  /**
   * One line to the recorder, and its events and bodies to the WAL in one
   * call, so a body is never written for an event that is still in memory.
   * Answers the error when the line was refused, and nothing when it landed.
   *
   * Marked and rolled back per line, not per tick: one line the envelope
   * refuses (a shape `normalizeTranscriptLine` did not anticipate, or a
   * field an earlier clamp missed) used to throw out of the whole read loop,
   * before the cursor advanced past the lines already fed and before any
   * line after it was ever tried. One bad line stopped shipping for the
   * whole host and, because the offset had not moved, replayed itself and
   * everything before it on every following tick. Now the chain rolls back
   * to where it stood before the line, and the caller moves the cursor past
   * it and counts it into the one gap frame its pass seals.
   */
  private feedLine(
    session: TailedSession,
    line: string,
    cursor: FileCursor,
    subagentId?: string,
  ): unknown {
    const recorder = session.recorder;
    const mark = recorder.markChain();
    try {
      // The cursor carries the reader's state, which moves past the line
      // whether or not the line seals, as the offset does.
      const events = recorder.ingestTranscriptLine(line, subagentId, cursor);
      this.options.record(events, recorder.takeBodies());
      return undefined;
    } catch (error) {
      recorder.rollbackChain(mark);
      return error;
    }
  }

  /**
   * A `telemetry_gap` frame for transcript this tailer could not carry
   * forward: lines the envelope refused, or a line longer than the tick's
   * read budget. Bodies are taken in the same call as `feedLine` does, so a
   * gap frame's own attrs never wait behind an event still in memory.
   *
   * A gap that cannot be written is rolled back before the error goes on.
   * Left sealed, it moved the chain past a frame nothing held, and the next
   * attempt sealed one position further on: a refused chain walked its
   * cursor forward once a tick for as long as the refusals lasted.
   */
  private sealGap(
    session: TailedSession,
    reason: string,
    detail: string,
    subagentId?: string,
    dropped = 1,
  ): void {
    const mark = session.recorder.markChain();
    try {
      const gap = session.recorder.sealCollectorEvent(
        "telemetry_gap",
        { gap_dropped_count: dropped },
        {
          attrs: {
            "gap.reason": reason,
            "gap.detail": detail.slice(0, 512),
            ...(subagentId !== undefined
              ? { "gap.subagent_id": subagentId }
              : {}),
          },
        },
      );
      this.options.record([gap], session.recorder.takeBodies());
    } catch (error) {
      session.recorder.rollbackChain(mark);
      throw error;
    }
    this.options.log?.(
      `transcript gap (${reason}, ${dropped} line${dropped === 1 ? "" : "s"}) for ${session.harnessSessionId}: ${detail}`,
    );
  }

  /**
   * Read the transcript on from the cursor, then seal one gap for every line
   * the pass refused, however many there were. A subagent's transcript is fed
   * with its id, and its gap names it.
   */
  private async advance(
    session: TailedSession,
    cursor: FileCursor,
    budget: number,
    sealer: Sealer,
    subagentId?: string,
  ): Promise<Pass> {
    const pass = await this.feed(session, cursor, budget, sealer, subagentId);
    if (cursor.refused === undefined) return pass;
    await sealer.run(() => {
      const refused = cursor.refused;
      if (refused === undefined || !sealer.current()) return;
      // One gap for the pass. A subagent whose chain refused every line
      // sealed one gap per line, 608 of them in one second on one host
      // (#4094).
      this.sealGap(
        session,
        "transcript_line_refused",
        refused.detail,
        subagentId,
        refused.count,
      );
      delete cursor.refused;
      this.dirty = true;
    });
    return pass;
  }

  /**
   * Read the file on from the cursor and seal each complete line. Every read
   * happens here, outside the session's queue for a tick. Every change to the
   * cursor and every seal happens inside `sealer.run`, and only while the
   * cursor still stands where the read began. A pass that finds it moved
   * stops, and the next one reads from where the cursor is now.
   *
   * What the stat found (a replaced file, a new inode) is applied inside the
   * first `sealer.run` of the pass, with the first lines it seals, so a pass
   * with lines to seal takes the session's queue once per slice and no more.
   */
  private async feed(
    session: TailedSession,
    cursor: FileCursor,
    budget: number,
    sealer: Sealer,
    subagentId?: string,
  ): Promise<Pass> {
    let fed = 0;
    let bytes = 0;
    let st: FileStat | undefined;
    try {
      st = await statIfExists(cursor.path);
    } catch (error) {
      this.options.log?.(
        `transcript ${cursor.path} unreadable: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { fed, failed: true, bytes };
    }
    // Claude Code creates the file on the first message, after SessionStart
    // has already reported its path; until then there is nothing to read.
    if (st === undefined) return { fed, failed: false, bytes };
    const size = st.size;
    const ino = st.ino;
    const at = cursor.offset;
    const knownIno = cursor.ino;
    let replaced = size < at || (knownIno !== undefined && knownIno !== ino);
    // A file the cursor has read to its end, on the inode it last saw, has
    // nothing to read, so its head is compared only once it grows. An idle
    // cursor then costs one stat a tick. A subagent whose SubagentStop was
    // lost keeps one for the rest of its session. A file rewritten in place
    // at exactly the cursor's offset is caught by the head compare on the
    // tick it grows.
    const idle = size === at && knownIno === ino;
    if (!replaced && !idle && at > 0 && cursor.head !== undefined) {
      const expected = Buffer.from(cursor.head, "base64");
      try {
        const actual = await readAt(cursor.path, 0, expected.length);
        replaced = !actual.equals(expected);
      } catch {
        // Unreadable now; the read below reports it.
      }
    }
    let statApplied = !replaced && knownIno === ino;
    // Inside `sealer.run`: apply what the stat found, once, while the cursor
    // still stands where the stat saw it.
    const applyStat = (): boolean => {
      if (statApplied) return true;
      if (!sealer.current() || cursor.offset !== at || cursor.ino !== knownIno)
        return false;
      if (replaced) {
        // Truncated or replaced: what the cursor pointed into is gone, and
        // so is what the reader kept from it.
        cursor.offset = 0;
        delete cursor.head;
        delete cursor.codex;
        this.dirty = true;
      }
      cursor.ino = ino;
      statApplied = true;
      return true;
    };
    // Inside `sealer.run`: whether this pass may move the cursor on from
    // `from`, the offset its read began at.
    const standsAt = (from: number): boolean =>
      applyStat() && sealer.current() && cursor.offset === from;
    // Every return after the stat goes through here, so a pass that seals
    // nothing still records a replaced file or a new inode.
    const done = async (failed: boolean): Promise<Pass> => {
      if (!statApplied) await sealer.run(applyStat);
      return { fed, failed, bytes };
    };
    let remaining = budget;
    let offset = replaced ? 0 : at;
    while (offset < size && remaining > 0) {
      const from = offset;
      const want = Math.min(remaining, size - from, this.budget);
      let chunk: Buffer;
      try {
        chunk = await readAt(cursor.path, from, want);
      } catch (error) {
        this.options.log?.(
          `transcript ${cursor.path} read failed at ${from}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return done(true);
      }
      // The file shrank between the stat and the read. The next pass sees
      // it as replaced.
      if (chunk.length === 0) return done(true);
      const { lines, consumed } = completeLines(chunk);
      if (consumed === 0) {
        // No newline in what was read. A chunk shorter than the full budget
        // was cut by this tick's remaining budget or by the end of the file:
        // either way the line's end is not known yet, and the next tick
        // starts on it fresh. A chunk the full budget long with no newline
        // in it is a line the budget cannot hold.
        if (chunk.length < this.budget) return done(false);
        // Find the end of the line so the cursor can move past it.
        const skipTo = await this.findLineEnd(cursor.path, from, size);
        if (skipTo === undefined) return done(false);
        const skipped = await sealer.run(() => {
          if (!standsAt(from)) return false;
          // A line past the budget was silent before: only a log line
          // marked it, and nothing on the chain showed the session had a
          // gap.
          this.sealGap(
            session,
            "transcript_line_too_long",
            `${skipTo - from} bytes at offset ${from}`,
            subagentId,
          );
          cursor.offset = skipTo;
          this.dirty = true;
          return true;
        });
        if (!skipped) return done(false);
        bytes += skipTo - from;
        offset = skipTo;
        continue;
      }
      // Fed and advanced one line at a time: a line the recorder refuses
      // rolls back in `feedLine` without disturbing the lines before or
      // after it, and is counted toward the pass's one gap. The cursor moves
      // past exactly the bytes that line and its newline held, not the whole
      // chunk, so a later line's failure can never re-open one already
      // recorded. The lines go in slices of at most `SEAL_SLICE_BYTES`, with
      // a turn of the event loop between two slices.
      let next = 0;
      while (next < lines.length) {
        if (next > 0) await yieldTurn();
        const slice: Array<{ line: string; bytes: number }> = [];
        let sliceBytes = 0;
        while (next < lines.length) {
          const line = lines[next] as string;
          const lineBytes = Buffer.byteLength(line, "utf8") + 1;
          if (slice.length > 0 && sliceBytes + lineBytes > SEAL_SLICE_BYTES)
            break;
          slice.push({ line, bytes: lineBytes });
          sliceBytes += lineBytes;
          next += 1;
        }
        const sliceFrom = offset;
        const sealed = await sealer.run(() => {
          if (!standsAt(sliceFrom)) return false;
          for (const { line, bytes: lineBytes } of slice) {
            if (line.length > 0) {
              const refusal = this.feedLine(
                session,
                line,
                cursor,
                subagentId,
              );
              fed += 1;
              if (refusal !== undefined)
                cursor.refused = {
                  count: (cursor.refused?.count ?? 0) + 1,
                  detail:
                    cursor.refused?.detail ?? describe(refusal).slice(0, 512),
                };
            }
            cursor.offset += lineBytes;
            this.dirty = true;
          }
          return true;
        });
        if (!sealed) return done(false);
        offset = sliceFrom + sliceBytes;
        remaining -= sliceBytes;
        bytes += sliceBytes;
      }
    }
    // Fingerprint the head once enough of it has been consumed, so the next
    // tick can tell a replaced file from the one this cursor read.
    const headLength = Math.min(HEAD_BYTES, offset);
    const known =
      cursor.head === undefined ? 0 : Buffer.from(cursor.head, "base64").length;
    if (statApplied && headLength > known) {
      try {
        const head = await readAt(cursor.path, 0, headLength);
        await sealer.run(() => {
          if (!sealer.current() || cursor.offset < headLength) return;
          cursor.head = head.toString("base64");
          this.dirty = true;
        });
      } catch {
        // Unreadable now; the next tick fingerprints it.
      }
    }
    return done(false);
  }

  /**
   * The offset just past the next newline at or after `from`, scanning in
   * budget-sized pieces, or undefined when the file ends first (the line is
   * still being written). The scan is not bounded by the tick budget: a line
   * this long is rare, and a cursor that cannot get past it would otherwise
   * stall for the rest of the session.
   */
  private async findLineEnd(
    path: string,
    from: number,
    size: number,
  ): Promise<number | undefined> {
    let at = from;
    while (at < size) {
      const chunk = await readAt(path, at, Math.min(this.budget, size - at));
      if (chunk.length === 0) return undefined;
      const nl = chunk.indexOf(0x0a);
      if (nl >= 0) return at + nl + 1;
      at += chunk.length;
    }
    return undefined;
  }
}
