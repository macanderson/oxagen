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
  recorder: Pick<SessionRecorder, "ingestTranscriptLine" | "takeBodies">;
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
}

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
   * Set once the session sealed and the tailer drained what was left, which
   * is one unbounded pass after the seal so a final `cost-state` line the
   * harness flushes after SessionEnd still lands. The cursor then stays as a
   * tombstone for as long as the registry lists the sealed session (seven
   * days), and nothing reads the transcript again. Dropping it sooner lets
   * the next tick make a fresh cursor at byte 0 and append the whole
   * transcript after `agent_stop`.
   */
  drained?: boolean;
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
    };
    this.cursors.set(key, cursor);
    this.dirty = true;
    return cursor;
  }

  /**
   * A resume reopens a sealed session, and its drained cursor with it: the
   * transcript is read again from where the cursor stopped. Left drained,
   * every model call the resumed session made was lost. Only the read
   * position carries over, nothing the sealed session left on the cursor.
   * A cursor that never read its file (the one `tick` makes for a sealed
   * session it holds none for) does not know where the recorded part ends,
   * so it stays final rather than feed the whole transcript a second time.
   */
  private reopenIfResumed(session: TailedSession): void {
    if (session.sealed) return;
    const key = this.cursorKey(session);
    const cursor = this.cursors.get(key) ?? this.adoptLegacy(session, key);
    if (cursor?.drained !== true || cursor.ino === undefined) return;
    this.cursors.set(key, {
      path: cursor.path,
      offset: cursor.offset,
      ino: cursor.ino,
      ...(cursor.head !== undefined ? { head: cursor.head } : {}),
      subagents: cursor.subagents,
    });
    this.dirty = true;
  }

  /**
   * Advance every live cursor by at most the budget, and drop the cursors of
   * sessions that left the registry. A drained cursor is kept until then,
   * and reopened when its session is.
   */
  async tick(): Promise<void> {
    for (const session of this.options.sessions())
      this.reopenIfResumed(session);
    const live = new Set<string>();
    for (const session of this.options.sessions()) {
      const key = this.cursorKey(session);
      live.add(key);
      if (session.transcriptPath === undefined) continue;
      const existing = this.cursors.get(key) ?? this.adoptLegacy(session, key);
      if (existing?.drained) continue;
      if (session.sealed && existing === undefined) {
        // Sealed with no cursor: a daemon before the tombstone dropped it, or
        // its state file was lost. Either way the chain is closed, and
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
        // One unbounded pass after the chain closed; nothing reads it after.
        await this.advance(session, cursor, Number.POSITIVE_INFINITY);
        cursor.drained = true;
        this.dirty = true;
        continue;
      }
      await this.advance(session, cursor, this.budget);
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
    for (const line of lines) {
      if (line.length === 0) continue;
      this.feed(session, line, subagentId);
      fed += 1;
    }
    cursor.subagents.push(subagentId);
    this.dirty = true;
    this.persist();
    return fed;
  }

  /**
   * One line to the recorder, and its events and bodies to the WAL in one
   * call, so a body is never written for an event that is still in memory.
   */
  private feed(
    session: TailedSession,
    line: string,
    subagentId?: string,
  ): void {
    const events = session.recorder.ingestTranscriptLine(line, subagentId);
    this.options.record(events, session.recorder.takeBodies());
  }

  private async advance(
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
        this.options.log?.(
          `transcript ${cursor.path}: skipped a ${skipTo - cursor.offset} byte line at ${cursor.offset}`,
        );
        cursor.offset = skipTo;
        this.dirty = true;
        continue;
      }
      for (const line of lines) {
        if (line.length === 0) continue;
        this.feed(session, line);
      }
      cursor.offset += consumed;
      remaining -= consumed;
      this.dirty = true;
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
