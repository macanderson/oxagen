/**
 * Tails Claude Code session transcripts into their recorders.
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
 * the daemon's tick. Every read is bounded so a session that writes faster
 * than the tick can drain never holds the serial queue; the rest is picked up
 * next tick. A subagent transcript (`agent_transcript_path` on SubagentStop)
 * is complete when the hook fires, so it is read once, whole, and fed with
 * the subagent id so the child chain receives it.
 *
 * Cursors are persisted next to the daemon state. Without that a restart
 * would re-read every open transcript from byte 0 and seal every message a
 * second time onto a chain that already holds it.
 *
 * Every file call goes through `fs.promises`. The daemon's tick runs on the
 * same thread that answers hooks and `GET /health`, and a synchronous read
 * of 4 MiB holds both; the detector's synchronous scan already showed what
 * that costs (see detector.ts).
 */
import { promises as fs } from "node:fs";
import type { SessionRecorder } from "../claude-code/recorder";
import type { TachoEvent } from "../envelope";
import type { FrameBody } from "../evidence/frame-body";
import { readJsonFileIfExists, writeSensitiveFileAtomic } from "../host/fs";
import type { TachoHarness } from "../wire";
import { sessionMapKey } from "./registry";

/** The most bytes one tick reads from one transcript. */
export const DEFAULT_TAIL_BUDGET_BYTES = 4 * 1024 * 1024;

/**
 * Harnesses whose transcript `transcript.ts` can normalize. Only Claude
 * Code's JSONL shape has a normalizer; a session whose harness is
 * `undefined` speaks Claude Code's own hook shape too (customAgent sessions
 * and legacy records both default this way) and is tailed the same. Codex
 * and Cursor sessions can carry a `transcript_path` (Codex's hook payload
 * has the field; Cursor's does not, but a session can inherit one from an
 * earlier Claude Code identity), and tailing one fed every line through a
 * normalizer that does not understand it: nothing sealed, and — once a
 * refused line seals a `telemetry_gap` instead of silently failing (see
 * `advance`) — a gap frame every pass, forever, for a transcript this reader
 * was never going to make sense of. Skipping it here is a smaller change
 * than adding the normalizer neither harness has yet; that stays a
 * follow-up.
 */
const TRANSCRIPT_NORMALIZED_HARNESSES: ReadonlySet<TachoHarness> = new Set([
  "claude-code",
]);

/** Whether `transcript.ts` has a normalizer for this session's harness. */
function hasTranscriptNormalizer(
  session: Pick<TailedSession, "harness">,
): boolean {
  return (
    session.harness === undefined ||
    TRANSCRIPT_NORMALIZED_HARNESSES.has(session.harness)
  );
}

/**
 * The most of a finished subagent transcript read in one go. It is read whole
 * on SubagentStop, inside a hook the harness is waiting on, so the read has a
 * ceiling; a subagent that wrote more than this loses its tail.
 */
export const MAX_SUBAGENT_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

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

interface Cursor {
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
  /** Subagent transcripts already fed, so a replayed SubagentStop feeds none twice. */
  subagents: string[];
  /**
   * Set once a sealed session's transcript has gone `sealedIdleMs` without
   * growing, so the cursor stops reading it. The cursor then stays as a
   * tombstone for as long as the registry lists the sealed session (seven
   * days), and nothing reads the transcript again. Dropping it sooner lets
   * the next tick make a fresh cursor at byte 0 and append the whole
   * transcript after `agent_stop`.
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
   * Lines this cursor moved past that the recorder refused, and that no gap
   * frame on the chain accounts for yet. Held here, and persisted with the
   * offset, until the gap is written, so a gap that cannot be written this
   * pass is carried to the next one rather than lost.
   */
  refused?: { count: number; detail: string };
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
  private dirty = false;

  constructor(options: TranscriptTailerOptions) {
    this.options = options;
    this.budget = options.budgetBytes ?? DEFAULT_TAIL_BUDGET_BYTES;
    if (options.statePath !== undefined) {
      const persisted = readJsonFileIfExists(options.statePath);
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
    };
    this.cursors.set(key, cursor);
    this.dirty = true;
    return cursor;
  }

  /**
   * Advance every live cursor by at most the budget, and drop the cursors of
   * sessions that left the registry. A drained cursor is kept until then.
   */
  async tick(): Promise<void> {
    const live = new Set<string>();
    for (const session of this.options.sessions()) {
      const key = this.cursorKey(session);
      live.add(key);
      if (session.transcriptPath === undefined) continue;
      if (!hasTranscriptNormalizer(session)) continue;
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
        if (session.sealed) {
          // A sealed chain still gets read at the normal budget, tick after
          // tick, until its transcript has sat unchanged for `sealedIdleMs`:
          // Claude Code has written a trailing `cost-state` or a final
          // `assistant` record after `agent_stop` before, and one pass right
          // at seal time is not guaranteed to be the last write. See
          // `DEFAULT_SEALED_TAIL_IDLE_MS`.
          const before = cursor.offset;
          await this.advance(session, cursor, this.budget);
          const now = this.options.now?.() ?? Date.now();
          if (cursor.offset > before) {
            delete cursor.sealedQuietSinceMs;
            this.dirty = true;
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
          continue;
        }
        await this.advance(session, cursor, this.budget);
      } catch (error) {
        this.options.log?.(
          `transcript tail for ${session.harnessSessionId} failed this tick: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    for (const id of [...this.cursors.keys()]) {
      if (!live.has(id)) {
        this.cursors.delete(id);
        this.dirty = true;
      }
    }
    this.persist();
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
   * Read everything the transcript holds right now, unbounded. Called before
   * a `Stop` or `SessionEnd` hook is sealed so the turn's model calls sit on
   * the chain before the frame that closes the turn.
   */
  async drain(harnessSessionId: string): Promise<void> {
    const session = this.options.session(harnessSessionId);
    if (session?.transcriptPath === undefined) return;
    if (!hasTranscriptNormalizer(session)) return;
    const cursor = this.cursorFor(session, session.transcriptPath);
    if (cursor.drained) return;
    await this.advance(session, cursor, Number.POSITIVE_INFINITY);
    this.persist();
  }

  /**
   * Feed a finished subagent transcript to the child chain, once. Returns
   * the number of lines fed, or undefined when the file is not there.
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
    const st = await statIfExists(path);
    if (st === undefined) return undefined;
    if (st.size > MAX_SUBAGENT_TRANSCRIPT_BYTES) {
      this.options.log?.(
        `subagent transcript ${path} is ${st.size} bytes; reading the first ${MAX_SUBAGENT_TRANSCRIPT_BYTES}`,
      );
    }
    const chunk = await readAt(
      path,
      0,
      Math.min(st.size, MAX_SUBAGENT_TRANSCRIPT_BYTES),
    );
    // The last line of a finished transcript has its newline; when it does
    // not, the writer was cut off and the fragment is not a record.
    const { lines } = completeLines(chunk);
    let fed = 0;
    let refused = 0;
    let firstRefusal: unknown;
    for (const line of lines) {
      if (line.length === 0) continue;
      const refusal = this.feedLine(session, line, subagentId);
      if (refusal !== undefined) {
        if (refused === 0) firstRefusal = refusal;
        refused += 1;
      }
      fed += 1;
    }
    // One gap for the whole transcript. A subagent whose chain refused every
    // line sealed one gap per line, 608 of them in one second on one host
    // (#4094).
    // A gap that cannot be written throws here, before the subagent is
    // marked fed, so its transcript is read again later.
    if (refused > 0)
      this.sealGap(
        session,
        "transcript_line_refused",
        describe(firstRefusal),
        subagentId,
        refused,
      );
    cursor.subagents.push(subagentId);
    this.dirty = true;
    this.persist();
    return fed;
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
    subagentId?: string,
  ): unknown {
    const recorder = session.recorder;
    const mark = recorder.markChain();
    try {
      const events = recorder.ingestTranscriptLine(line, subagentId);
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
   * the pass refused, however many there were.
   */
  private async advance(
    session: TailedSession,
    cursor: Cursor,
    budget: number,
  ): Promise<void> {
    await this.feed(session, cursor, budget);
    const refused = cursor.refused;
    if (refused === undefined) return;
    this.sealGap(
      session,
      "transcript_line_refused",
      refused.detail,
      undefined,
      refused.count,
    );
    delete cursor.refused;
    this.dirty = true;
  }

  private async feed(
    session: TailedSession,
    cursor: Cursor,
    budget: number,
  ): Promise<void> {
    let st: FileStat | undefined;
    try {
      st = await statIfExists(cursor.path);
    } catch (error) {
      this.options.log?.(
        `transcript ${cursor.path} unreadable: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    // Claude Code creates the file on the first message, after SessionStart
    // has already reported its path; until then there is nothing to read.
    if (st === undefined) return;
    let replaced =
      st.size < cursor.offset ||
      (cursor.ino !== undefined && cursor.ino !== st.ino);
    if (!replaced && cursor.offset > 0 && cursor.head !== undefined) {
      const expected = Buffer.from(cursor.head, "base64");
      try {
        const actual = await readAt(cursor.path, 0, expected.length);
        replaced = !actual.equals(expected);
      } catch {
        // Unreadable now; the read below reports it.
      }
    }
    if (replaced) {
      // Truncated or replaced: what the cursor pointed into is gone.
      cursor.offset = 0;
      delete cursor.head;
      this.dirty = true;
    }
    cursor.ino = st.ino;
    let remaining = budget;
    while (cursor.offset < st.size && remaining > 0) {
      const want = Math.min(remaining, st.size - cursor.offset, this.budget);
      let chunk: Buffer;
      try {
        chunk = await readAt(cursor.path, cursor.offset, want);
      } catch (error) {
        this.options.log?.(
          `transcript ${cursor.path} read failed at ${cursor.offset}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      if (chunk.length === 0) return;
      const { lines, consumed } = completeLines(chunk);
      if (consumed === 0) {
        // No newline in what was read. A chunk shorter than the full budget
        // was cut by this tick's remaining budget or by the end of the file:
        // either way the line's end is not known yet, and the next tick
        // starts on it fresh. A chunk the full budget long with no newline
        // in it is a line the budget cannot hold.
        if (chunk.length < this.budget) return;
        // Find the end of the line so the cursor can move past it.
        const skipTo = await this.findLineEnd(
          cursor.path,
          cursor.offset,
          st.size,
        );
        if (skipTo === undefined) return;
        // A line past the budget was silent before: only a log line marked
        // it, and nothing on the chain showed the session had a gap.
        this.sealGap(
          session,
          "transcript_line_too_long",
          `${skipTo - cursor.offset} bytes at offset ${cursor.offset}`,
        );
        cursor.offset = skipTo;
        this.dirty = true;
        continue;
      }
      // Fed and advanced one line at a time: a line the recorder refuses
      // rolls back in `feedLine` without disturbing the lines before or
      // after it, and is counted toward the pass's one gap. The cursor moves
      // past exactly the bytes that line and its newline held, not the whole
      // chunk, so a later line's failure can never re-open one already
      // recorded.
      for (const line of lines) {
        const lineBytes = Buffer.byteLength(line, "utf8") + 1;
        if (line.length > 0) {
          const refusal = this.feedLine(session, line);
          if (refusal !== undefined)
            cursor.refused = {
              count: (cursor.refused?.count ?? 0) + 1,
              detail: cursor.refused?.detail ?? describe(refusal).slice(0, 512),
            };
        }
        cursor.offset += lineBytes;
        remaining -= lineBytes;
        this.dirty = true;
      }
    }
    // Fingerprint the head once enough of it has been consumed, so the next
    // tick can tell a replaced file from the one this cursor read.
    const headLength = Math.min(HEAD_BYTES, cursor.offset);
    const known =
      cursor.head === undefined ? 0 : Buffer.from(cursor.head, "base64").length;
    if (headLength > known) {
      try {
        const head = await readAt(cursor.path, 0, headLength);
        cursor.head = head.toString("base64");
        this.dirty = true;
      } catch {
        // Unreadable now; the next tick fingerprints it.
      }
    }
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
