/**
 * The WAL ceiling (ADR-261): the most disk the WAL may hold for sessions the
 * control plane has stopped accepting.
 *
 * `Wal.compact` frees a session only once it is sealed, fully shipped, and a
 * week old. A session whose batches keep failing never ships, so its events
 * and bodies used to stay for as long as the failure lasted. One heavy
 * twelve-hour day wrote 8.5 GB to the WAL, 8.4 GB of it bodies (#3694). A long
 * outage of the control plane could fill the disk and stop the person's own
 * work along with the recording (#3722).
 *
 * The rule:
 *
 * 1. A session is stalled when it has events past its shipped cursor and the
 *    cursor has not moved for `stallGraceMs`. A session that is shipping moves
 *    its cursor every few seconds, so it never counts. Time the daemon was not
 *    running does not count either: a gap between two checks longer than
 *    `sleepGapMs` (a laptop asleep) counts as one `checkEveryMs`, because the
 *    shipper did not run in it and had no chance to move the cursor.
 * 2. The ceiling is the smaller of `ceilingBytes` and half the space the disk
 *    would have free without the stalled sessions.
 * 3. When the stalled sessions' files hold more than the ceiling, the session
 *    stalled longest loses its stored bodies first, one whole body file at a
 *    time, until the total is back under.
 * 4. Events are never dropped. They are about one percent of the bytes, and
 *    they are the chain, so every event still ships and the chain verifies.
 *
 * Content under the ceiling is kept however old it is, because it can still
 * ship once the control plane accepts it again.
 *
 * The daemon seals a frame on its own chain for each drop, and this module
 * keeps the recent drops in `ceiling.json` beside the WAL, which
 * `oxagen agent status` reads. The same file keeps each stall clock, so a
 * restarted daemon resumes it rather than starting it again.
 */
import { statfsSync } from "node:fs";
import { join } from "node:path";
import { readJsonFileIfExists, writeSensitiveFileAtomic } from "./fs";
import type { Wal } from "./wal";

export interface WalCeilingPolicy {
  /** The most bytes stalled sessions may hold, before the disk's own limit. */
  ceilingBytes: number;
  /** How long a session's shipped cursor may stand still before it is stalled. */
  stallGraceMs: number;
  /** How often the daemon checks. */
  checkEveryMs: number;
  /**
   * A gap between two checks longer than this is time the daemon did not
   * run, such as a laptop asleep. It counts toward a stall as one
   * `checkEveryMs`. Left out, every gap counts in full.
   */
  sleepGapMs?: number;
  /** Bytes free on the disk that holds `dir`, or undefined when unreadable. */
  freeBytes: (dir: string) => number | undefined;
}

/**
 * The figures ADR-261 chose, with its reasoning in short:
 *
 * - 8 GiB is about one heavy working day: the day measured on #3694 wrote
 *   8.5 GB. An outage shorter than a working day loses nothing, and the first
 *   start that imported old transcripts on 2026-10-02 (1.0 GB) fits eight
 *   times over.
 * - One hour without a moved cursor is far past a healthy drain, which ships
 *   a live session within seconds.
 * - A minute between checks costs a `stat` of each waiting session's files.
 * - Five minutes without a check, added after ADR-261 (#5390), is five
 *   checks missed, which is what a daemon that is not running, as on a
 *   laptop asleep, looks like. A gap counted short only puts a drop off.
 */
export const DEFAULT_WAL_CEILING: WalCeilingPolicy = {
  ceilingBytes: 8 * 1024 ** 3,
  stallGraceMs: 60 * 60_000,
  checkEveryMs: 60_000,
  sleepGapMs: 5 * 60_000,
  freeBytes: freeBytesOn,
};

function freeBytesOn(dir: string): number | undefined {
  try {
    const stats = statfsSync(dir);
    return stats.bavail * stats.bsize;
  } catch {
    return undefined;
  }
}

/** The file beside the WAL that says what the ceiling last saw and did. */
const STATE_FILE = "ceiling.json";
const STATE_SCHEMA = "tacho.wal-ceiling.v1";

/** How many drops `ceiling.json` keeps. */
const DROPS_KEPT = 20;

/** One session whose stored bodies went because the WAL was over its ceiling. */
export interface WalCeilingDrop {
  session_uuid: string;
  /** Bytes of the body file removed. */
  bytes: number;
  /** The control plane holds the events up to here, and their bodies. */
  shipped_through: number;
  /** The last event on disk. Events after `shipped_through` ship without bodies. */
  last_seq: number;
  /**
   * When the session's shipped cursor last moved, or when it was first seen
   * waiting, moved later by any time the daemon did not run since.
   */
  stalled_since: string;
  dropped_at: string;
  /** What every stalled session held just before this drop. */
  stalled_bytes: number;
  /** The ceiling in force at the drop. */
  ceiling_bytes: number;
}

/**
 * One session's stall clock: where its shipped cursor stands, and when a
 * check first saw it there, moved later by any time the daemon did not run.
 */
export interface WalStallClock {
  shipped_through: number;
  since: string;
}

/** What `ceiling.json` holds. */
export interface WalCeilingState {
  schema: typeof STATE_SCHEMA;
  checked_at: string;
  ceiling_bytes: number;
  stall_grace_ms: number;
  /** What the stalled sessions hold after this check's drops. */
  stalled_bytes: number;
  stalled_sessions: number;
  /** The most recent drops, oldest first. */
  drops: WalCeilingDrop[];
  /**
   * The clock of each session whose cursor stood still between two checks,
   * by session. A restarted daemon reads these and resumes each clock.
   */
  stall_clocks: Record<string, WalStallClock>;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isClock(value: unknown): value is WalStallClock {
  if (typeof value !== "object" || value === null) return false;
  const clock = value as Record<string, unknown>;
  const since = clock["since"];
  return (
    Number.isSafeInteger(clock["shipped_through"]) &&
    typeof since === "string" &&
    Number.isFinite(Date.parse(since))
  );
}

/**
 * The clocks in a `stall_clocks` value. A value that is not an object reads
 * as no clocks, and an entry that does not read as a clock is skipped, so a
 * bad clock never hides the drops `oxagen agent status` shows.
 */
function clocksFrom(value: unknown): Record<string, WalStallClock> {
  const clocks: Record<string, WalStallClock> = {};
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return clocks;
  for (const [session, clock] of Object.entries(value))
    if (isClock(clock))
      clocks[session] = {
        shipped_through: clock.shipped_through,
        since: clock.since,
      };
  return clocks;
}

/** Whether two sets of clocks say the same thing. */
function sameClocks(
  a: Readonly<Record<string, WalStallClock>>,
  b: Readonly<Record<string, WalStallClock>>,
): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((session) => {
    const other = b[session];
    const clock = a[session];
    return (
      other !== undefined &&
      clock !== undefined &&
      other.shipped_through === clock.shipped_through &&
      other.since === clock.since
    );
  });
}

function isDrop(value: unknown): value is WalCeilingDrop {
  if (typeof value !== "object" || value === null) return false;
  const drop = value as Record<string, unknown>;
  return (
    typeof drop["session_uuid"] === "string" &&
    isCount(drop["bytes"]) &&
    typeof drop["shipped_through"] === "number" &&
    typeof drop["last_seq"] === "number" &&
    typeof drop["stalled_since"] === "string" &&
    typeof drop["dropped_at"] === "string" &&
    isCount(drop["stalled_bytes"]) &&
    isCount(drop["ceiling_bytes"])
  );
}

/**
 * What the daemon last wrote to `ceiling.json` in this WAL directory, or
 * undefined when there is no file or it does not read as one. A reader never
 * moves or rewrites the file, because the daemon may be writing it.
 */
export function readWalCeilingState(
  walDir: string,
): WalCeilingState | undefined {
  let raw: unknown;
  try {
    raw = readJsonFileIfExists(join(walDir, STATE_FILE));
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const state = raw as Record<string, unknown>;
  const checkedAt = state["checked_at"];
  const ceilingBytes = state["ceiling_bytes"];
  const stallGraceMs = state["stall_grace_ms"];
  const stalledBytes = state["stalled_bytes"];
  const stalledSessions = state["stalled_sessions"];
  const drops: unknown = state["drops"];
  if (
    state["schema"] !== STATE_SCHEMA ||
    typeof checkedAt !== "string" ||
    !isCount(ceilingBytes) ||
    !isCount(stallGraceMs) ||
    !isCount(stalledBytes) ||
    !isCount(stalledSessions) ||
    !Array.isArray(drops)
  )
    return undefined;
  return {
    schema: STATE_SCHEMA,
    checked_at: checkedAt,
    ceiling_bytes: ceilingBytes,
    stall_grace_ms: stallGraceMs,
    stalled_bytes: stalledBytes,
    stalled_sessions: stalledSessions,
    drops: (drops as unknown[]).filter(isDrop),
    stall_clocks: clocksFrom(state["stall_clocks"]),
  };
}

/**
 * The ceiling in force: the fixed figure, or half the space the disk would
 * have free without the stalled sessions when that is smaller. A fixed figure
 * alone cannot protect a disk with less free space than the figure.
 *
 * Removing a body file adds its bytes to the free space and takes them off
 * the stalled total, so the sum, and this answer, hold for a whole check.
 */
function ceilingFor(
  fixed: number,
  free: number | undefined,
  stalled: number,
): number {
  if (free === undefined || !Number.isFinite(free)) return fixed;
  return Math.min(fixed, Math.floor((free + stalled) / 2));
}

/**
 * Keeps the WAL under its ceiling. The daemon owns one, and calls `check`
 * from its tick when `due` says so. Every call is synchronous. It reads no
 * body, and no event past the last line `Wal` already keeps for each session,
 * so it never holds the daemon's thread on a large file (ADR-231).
 */
export class WalCeiling {
  /**
   * Each waiting session's shipped cursor as the last check saw it, and when
   * it was first seen there.
   *
   * A clock whose cursor stood still between two checks is also written to
   * `ceiling.json`, and the constructor reads it back, so a restarted daemon
   * resumes the clock. A daemon that restarted more often than `stallGraceMs`
   * used to start every clock again each time, and never dropped anything.
   * A clock first seen by the last check before a restart is not written yet,
   * so a restart costs it at most one `checkEveryMs`.
   */
  private readonly progress = new Map<
    string,
    { through: number; since: number }
  >();
  private state: WalCeilingState | undefined;
  /** Set when the last write of `ceiling.json` failed, so the next check writes. */
  private unsaved = false;
  private lastCheckAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly wal: Wal,
    private readonly walDir: string,
    private readonly policy: WalCeilingPolicy,
    /** How long a drop stays in `ceiling.json`: the WAL's own retention. */
    private readonly keepDropsMs: number,
    private readonly log: (line: string) => void,
  ) {
    this.state = readWalCeilingState(walDir);
    for (const [session, clock] of Object.entries(
      this.state?.stall_clocks ?? {},
    ))
      this.progress.set(session, {
        through: clock.shipped_through,
        since: Date.parse(clock.since),
      });
  }

  /** Whether a check is due at `now`. */
  due(now: number): boolean {
    return now - this.lastCheckAt >= this.policy.checkEveryMs;
  }

  /**
   * One check, and the drops it made.
   *
   * `onDrop` runs right after each body file goes, in the same synchronous
   * stretch, so the daemon seals the frame that records the drop before
   * anything else runs. A frame that fails does not bring the bodies back:
   * the drop stands, and the daemon logs the failure.
   */
  check(
    now: number,
    onDrop: (drop: WalCeilingDrop) => void,
  ): WalCeilingDrop[] {
    this.pauseClocksOverGap(now);
    this.lastCheckAt = now;
    const holdings = this.wal.holdings();
    const waiting = new Set<string>();
    // The clocks whose cursor stood still since the last check, or since
    // before a restart. Only these go to `ceiling.json`: a session that is
    // shipping moves its cursor between checks, so it costs no write.
    const clocks: Record<string, WalStallClock> = {};
    for (const holding of holdings) {
      waiting.add(holding.sessionUuid);
      const known = this.progress.get(holding.sessionUuid);
      if (known === undefined || known.through !== holding.shippedThrough) {
        this.progress.set(holding.sessionUuid, {
          through: holding.shippedThrough,
          since: now,
        });
        continue;
      }
      clocks[holding.sessionUuid] = {
        shipped_through: known.through,
        since: new Date(known.since).toISOString(),
      };
    }
    // A session that shipped everything, or that `compact` removed, is no
    // longer waiting. Its clock starts again if it waits again.
    for (const session of [...this.progress.keys()])
      if (!waiting.has(session)) this.progress.delete(session);

    const stalled = holdings
      .map((holding) => ({
        holding,
        since: this.progress.get(holding.sessionUuid)?.since ?? now,
      }))
      .filter((entry) => now - entry.since >= this.policy.stallGraceMs);
    let held = 0;
    for (const { holding } of stalled)
      held += holding.eventBytes + holding.bodyBytes;
    const ceiling = ceilingFor(
      this.policy.ceilingBytes,
      this.policy.freeBytes(this.walDir),
      held,
    );

    const drops: WalCeilingDrop[] = [];
    if (held > ceiling) {
      // Stalled longest first, since those are the furthest from shipping.
      // The shipper sends the latest session first, so among sessions
      // stalled equally long the one whose last event is oldest goes first.
      stalled.sort(
        (a, b) =>
          a.since - b.since ||
          a.holding.lastActivityAt - b.holding.lastActivityAt ||
          (a.holding.sessionUuid < b.holding.sessionUuid ? -1 : 1),
      );
      for (const { holding, since } of stalled) {
        if (held <= ceiling) break;
        if (holding.bodyBytes === 0) continue;
        const bytes = this.wal.dropSessionBodies(holding.sessionUuid);
        if (bytes === 0) continue;
        const drop: WalCeilingDrop = {
          session_uuid: holding.sessionUuid,
          bytes,
          shipped_through: holding.shippedThrough,
          last_seq: holding.lastSeq,
          stalled_since: new Date(since).toISOString(),
          dropped_at: new Date(now).toISOString(),
          stalled_bytes: held,
          ceiling_bytes: ceiling,
        };
        held -= bytes;
        drops.push(drop);
        try {
          onDrop(drop);
        } catch {
          // The daemon's callback logs its own failure. The drop stands.
        }
      }
    }
    this.remember(now, ceiling, held, stalled.length, drops, clocks);
    return drops;
  }

  /**
   * Move every clock later by the time since the last check that the daemon
   * did not run. A laptop that slept for two hours used to wake with every
   * waiting session past its grace, and the first check dropped bodies the
   * shipper would have sent once the network came back. A gap of
   * `sleepGapMs` or less counts in full, and a longer one counts as one
   * `checkEveryMs`. The first check after a restart has no last check, so a
   * resumed clock keeps its time.
   */
  private pauseClocksOverGap(now: number): void {
    const { sleepGapMs, checkEveryMs } = this.policy;
    const gap = now - this.lastCheckAt;
    if (sleepGapMs === undefined || !Number.isFinite(gap) || gap <= sleepGapMs)
      return;
    const unwatched = Math.max(0, gap - checkEveryMs);
    for (const clock of this.progress.values()) clock.since += unwatched;
  }

  /**
   * Write what this check saw to `ceiling.json`, when it says something the
   * file does not. A host where no cursor stood still between two checks,
   * and nothing was dropped, writes no file at all.
   */
  private remember(
    now: number,
    ceiling: number,
    held: number,
    stalledSessions: number,
    drops: readonly WalCeilingDrop[],
    clocks: Record<string, WalStallClock>,
  ): void {
    const prior = this.state;
    const kept = [...(prior?.drops ?? []), ...drops]
      .filter((drop) => now - Date.parse(drop.dropped_at) < this.keepDropsMs)
      .slice(-DROPS_KEPT);
    if (
      prior === undefined &&
      stalledSessions === 0 &&
      kept.length === 0 &&
      Object.keys(clocks).length === 0
    )
      return;
    const next: WalCeilingState = {
      schema: STATE_SCHEMA,
      checked_at: new Date(now).toISOString(),
      ceiling_bytes: ceiling,
      stall_grace_ms: this.policy.stallGraceMs,
      stalled_bytes: held,
      stalled_sessions: stalledSessions,
      drops: kept,
      stall_clocks: clocks,
    };
    const changed =
      this.unsaved ||
      prior === undefined ||
      prior.stalled_sessions !== next.stalled_sessions ||
      prior.drops.length !== next.drops.length ||
      prior.drops.at(-1)?.dropped_at !== next.drops.at(-1)?.dropped_at ||
      !sameClocks(prior.stall_clocks, next.stall_clocks) ||
      (next.stalled_sessions > 0 &&
        (prior.stalled_bytes !== next.stalled_bytes ||
          prior.ceiling_bytes !== next.ceiling_bytes));
    this.state = next;
    if (!changed) return;
    try {
      writeSensitiveFileAtomic(
        join(this.walDir, STATE_FILE),
        JSON.stringify(next),
      );
      this.unsaved = false;
    } catch (error) {
      // The drops already happened and their frames are on the chain. Only
      // the summary `oxagen agent status` reads is behind, and the next
      // check writes it again.
      this.unsaved = true;
      this.log(
        `WAL ceiling: could not write ${STATE_FILE}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
