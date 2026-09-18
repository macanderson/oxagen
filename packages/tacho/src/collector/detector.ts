/**
 * The unobserved-session and hooks-removed detector (spec section 11).
 * Watches transcript files under Claude Code's project root and the list
 * of `claude` processes; a transcript that advances with no hook stream is
 * chained as `oxagen:unobserved_session` on the daemon's own chain. Re-reads
 * the settings file on every tick and chains `oxagen:hooks_removed` when
 * Tacho's entries disappear, `oxagen:hook_health` when they come back.
 *
 * The transcript scan is asynchronous and bounded. It used to `readdirSync`
 * every project directory and `statSync` every transcript on every tick, on
 * the main thread: on a laptop with 252 projects and 5,618 transcripts a
 * 3 s sample of the running daemon put 2360 of 2609 samples inside
 * `node::fs::ReadDir`, `GET /health` never answered, and hooks blew their
 * 50 ms connect budget and fell back to spool files. Now each tick reads the
 * root, stats the project directories, and scans the files of at most
 * `MAX_DIRS_PER_TICK` of them: the ones whose directory mtime moved (a
 * transcript was created or removed), then a rotating share of the rest so
 * a transcript appended in place is still noticed within a few minutes, and
 * always the files already under watch. Everything goes through
 * `fs.promises`, so the event loop keeps answering between the calls.
 */
import { promises as fs } from "node:fs";
import { basename, join } from "node:path";
import type { SessionRecorder } from "../claude-code/recorder";
import type { TachoEvent } from "../envelope";
import type { ClaudeProcess } from "../host/process-scan";
import { type HookPresence, tachoHookPresence } from "../host/settings-writer";
import type { SessionRegistry } from "./registry";

export interface DetectorDeps {
  registry: SessionRegistry;
  hostRecorder: () => SessionRecorder;
  listProcesses: () => ClaudeProcess[];
  /** Directories holding `<project>/<session uuid>.jsonl` transcripts. */
  transcriptRoots: string[];
  readSettings: () => unknown;
  enrollmentId: string;
  /**
   * Whether this host hooks Claude Code at all, read each tick. Absent means
   * yes. A Codex-only, Stella-only or Claude Desktop-only host has no Claude
   * Code hooks to lose, and without this the detector chained a severity-3
   * `oxagen:hooks_removed` incident fifteen seconds after every start. It is
   * a function so a `reassign` that drops the harness is seen without a
   * restart.
   */
  claudeCodeEnrolled?: () => boolean;
  now: () => number;
  /** How long a transcript may advance unhooked before it is an incident. */
  graceMs?: number;
  /** Project directories whose files one tick may scan; see `MAX_DIRS_PER_TICK`. */
  maxDirsPerTick?: number;
}

/** Writes sealed frames to the WAL; see `Detector.tick`. */
export type RecordSink = (events: readonly TachoEvent[]) => void;

interface TranscriptSighting {
  path: string;
  firstSeenAt: number;
  lastMtimeMs: number;
  reported: boolean;
}

export interface TranscriptEntry {
  sessionId: string;
  path: string;
  mtimeMs: number;
}

/** What the scanner remembers of one project directory between ticks. */
interface ProjectState {
  /** The directory's mtime at the last file scan. */
  scannedMtimeMs: number;
  files: TranscriptEntry[];
}

const SESSION_FILE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

/**
 * Project directories one tick may scan. The rotating share is a quarter of
 * this, so a directory whose transcript only grows in place is rescanned
 * within `projects / (MAX / 4)` ticks: about eight minutes for 252 projects
 * at the fifteen-second detector interval.
 */
export const MAX_DIRS_PER_TICK = 32;

/** `fs.promises` calls in flight at once during a scan. */
const SCAN_CONCURRENCY = 8;

/** Run `task` over `items` with at most `limit` in flight. */
async function eachLimited<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const item = items[next] as T;
        next += 1;
        await task(item);
      }
    },
  );
  await Promise.all(workers);
}

/** The transcripts of one project directory, with their mtimes. */
async function scanProject(dir: string): Promise<TranscriptEntry[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: TranscriptEntry[] = [];
  await eachLimited(names, SCAN_CONCURRENCY, async (name) => {
    const match = SESSION_FILE.exec(name);
    if (match === null) return;
    const path = join(dir, name);
    try {
      const st = await fs.stat(path);
      out.push({ sessionId: match[1] as string, path, mtimeMs: st.mtimeMs });
    } catch {
      // Deleted between readdir and stat.
    }
  });
  return out;
}

/**
 * Every transcript under the roots, scanned whole. The detector does not
 * call this on its tick; it is the one-shot form for tools and tests.
 */
export async function listTranscripts(
  roots: readonly string[],
): Promise<TranscriptEntry[]> {
  const out: TranscriptEntry[] = [];
  for (const root of roots) {
    let projects: string[];
    try {
      projects = await fs.readdir(root);
    } catch {
      continue;
    }
    await eachLimited(projects, SCAN_CONCURRENCY, async (project) => {
      out.push(...(await scanProject(join(root, project))));
    });
  }
  return out;
}

/**
 * The incremental scanner: keeps the last scan of every project directory
 * and, each tick, rescans the ones that changed, a rotating share of the
 * rest, and the files already under watch.
 */
export class TranscriptScanner {
  private readonly projects = new Map<string, ProjectState>();
  private readonly roots: readonly string[];
  private readonly maxDirsPerTick: number;
  /** Where the rotating share picks up next tick. */
  private rotation = 0;

  constructor(roots: readonly string[], maxDirsPerTick = MAX_DIRS_PER_TICK) {
    this.roots = roots;
    this.maxDirsPerTick = Math.max(1, maxDirsPerTick);
  }

  /**
   * One bounded pass. `watched` are transcript paths whose mtime the caller
   * needs fresh every tick whatever directory they are in.
   */
  async tick(
    watched: ReadonlySet<string> = new Set(),
  ): Promise<TranscriptEntry[]> {
    const dirs: Array<{ dir: string; mtimeMs: number }> = [];
    for (const root of this.roots) {
      let names: string[];
      try {
        names = await fs.readdir(root);
      } catch {
        continue;
      }
      await eachLimited(names, SCAN_CONCURRENCY, async (name) => {
        const dir = join(root, name);
        try {
          const st = await fs.stat(dir);
          if (st.isDirectory()) dirs.push({ dir, mtimeMs: st.mtimeMs });
        } catch {
          // Removed between readdir and stat.
        }
      });
    }
    dirs.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
    const present = new Set(dirs.map((d) => d.dir));
    for (const known of [...this.projects.keys()]) {
      if (!present.has(known)) this.projects.delete(known);
    }

    // Changed or never-scanned directories first, then the rotating share.
    const changed = dirs.filter((d) => {
      const state = this.projects.get(d.dir);
      return state === undefined || state.scannedMtimeMs !== d.mtimeMs;
    });
    const toScan = new Map<string, number>();
    for (const d of changed.slice(0, this.maxDirsPerTick))
      toScan.set(d.dir, d.mtimeMs);
    const rotating = Math.max(1, Math.floor(this.maxDirsPerTick / 4));
    if (dirs.length > 0) {
      for (
        let i = 0;
        i < rotating && toScan.size < this.maxDirsPerTick;
        i += 1
      ) {
        const d = dirs[this.rotation % dirs.length] as {
          dir: string;
          mtimeMs: number;
        };
        this.rotation = (this.rotation + 1) % dirs.length;
        toScan.set(d.dir, d.mtimeMs);
      }
    }
    await eachLimited(
      [...toScan.entries()],
      SCAN_CONCURRENCY,
      async ([dir, mtimeMs]) => {
        this.projects.set(dir, {
          scannedMtimeMs: mtimeMs,
          files: await scanProject(dir),
        });
      },
    );

    // Files under watch are re-statted every tick, in whatever directory.
    const out: TranscriptEntry[] = [];
    const seen = new Set<string>();
    for (const state of this.projects.values()) {
      for (const entry of state.files) {
        if (seen.has(entry.path)) continue;
        seen.add(entry.path);
        out.push(entry);
      }
    }
    await eachLimited([...out], SCAN_CONCURRENCY, async (entry) => {
      if (!watched.has(entry.path)) return;
      try {
        entry.mtimeMs = (await fs.stat(entry.path)).mtimeMs;
      } catch {
        // Gone; the stale entry is dropped at the next scan of its directory.
      }
    });
    return out;
  }
}

export class Detector {
  private readonly deps: DetectorDeps;
  private readonly sightings = new Map<string, TranscriptSighting>();
  private readonly scanner: TranscriptScanner;
  private lastPresence: HookPresence | undefined;
  private hooksOk: boolean | undefined;

  constructor(deps: DetectorDeps) {
    this.deps = deps;
    this.scanner = new TranscriptScanner(
      deps.transcriptRoots,
      deps.maxDirsPerTick,
    );
  }

  get hooksHealthy(): boolean | undefined {
    return this.hooksOk;
  }

  get presence(): HookPresence | undefined {
    return this.lastPresence;
  }

  /** Transcript ids the detector has flagged as unobserved so far. */
  get unobserved(): string[] {
    return [...this.sightings.entries()]
      .filter(([, sighting]) => sighting.reported)
      .map(([id]) => id);
  }

  private checkHooks(): TachoEvent[] {
    if (this.deps.claudeCodeEnrolled?.() === false) {
      this.hooksOk = undefined;
      this.lastPresence = undefined;
      return [];
    }
    let presence: HookPresence;
    try {
      presence = tachoHookPresence(
        this.deps.readSettings(),
        this.deps.enrollmentId,
      );
    } catch (error) {
      presence = {
        complete: false,
        present: [],
        missing: [],
        envOk: false,
        disabledByFlag: false,
      };
      this.lastPresence = presence;
      if (this.hooksOk !== false) {
        this.hooksOk = false;
        return [
          this.deps.hostRecorder().sealCollectorEvent("oxagen:hooks_removed", {
            incident_kind: "hooks_removed",
            incident_severity: 3,
            incident_evidence: {
              error: error instanceof Error ? error.message : String(error),
            },
          }),
        ];
      }
      return [];
    }
    this.lastPresence = presence;
    const events: TachoEvent[] = [];
    if (this.hooksOk !== false && !presence.complete) {
      events.push(
        this.deps.hostRecorder().sealCollectorEvent("oxagen:hooks_removed", {
          incident_kind: "hooks_removed",
          incident_severity:
            presence.disabledByFlag || presence.missing.length > 5 ? 3 : 2,
          incident_evidence: {
            missing: presence.missing,
            env_ok: presence.envOk,
            disabled_by_flag: presence.disabledByFlag,
          },
          hook_count: presence.present.length,
        }),
      );
    } else if (this.hooksOk === false && presence.complete) {
      events.push(
        this.deps.hostRecorder().sealCollectorEvent("oxagen:hook_health", {
          hook_count: presence.present.length,
          hook_success: presence.present.length,
        }),
      );
    }
    this.hooksOk = presence.complete;
    return events;
  }

  private async checkTranscripts(record: RecordSink): Promise<TachoEvent[]> {
    const watched = new Set(
      [...this.sightings.values()].map((sighting) => sighting.path),
    );
    const transcripts = await this.scanner.tick(watched);
    // Everything from here is synchronous: the seals below must not
    // interleave with a hook sealing on another chain mid-decision.
    const now = this.deps.now();
    const grace = this.deps.graceMs ?? 30_000;
    const processes = this.deps.listProcesses();
    const events: TachoEvent[] = [];
    for (const transcript of transcripts) {
      if (this.deps.registry.get(transcript.sessionId) !== undefined) {
        this.sightings.delete(transcript.sessionId);
        continue;
      }
      const seen = this.sightings.get(transcript.sessionId);
      if (seen === undefined) {
        // Only transcripts that move after the daemon started matter; a
        // pre-existing idle file is history, not an unobserved session.
        if (now - transcript.mtimeMs > grace) continue;
        this.sightings.set(transcript.sessionId, {
          path: transcript.path,
          firstSeenAt: now,
          lastMtimeMs: transcript.mtimeMs,
          reported: false,
        });
        continue;
      }
      const advanced = transcript.mtimeMs > seen.lastMtimeMs;
      seen.lastMtimeMs = transcript.mtimeMs;
      if (seen.reported || !advanced || now - seen.firstSeenAt < grace)
        continue;
      seen.reported = true;
      events.push(
        this.deps
          .hostRecorder()
          .sealCollectorEvent("oxagen:unobserved_session", {
            incident_kind: "unobserved_session",
            incident_severity: 3,
            incident_evidence: {
              session_id: transcript.sessionId,
              transcript_path: transcript.path,
              transcript_mtime: new Date(transcript.mtimeMs).toISOString(),
              claude_pids: processes.map((p) => p.pid),
              project: basename(join(transcript.path, "..")),
            },
          }),
      );
    }
    record(events);
    return events;
  }

  /**
   * One detector pass; returns the incidents it chained.
   *
   * `record` must write the frames to the WAL, and it is called in the same
   * synchronous stretch as each seal. The WAL is appended in call order and
   * read back in that order, so a frame sealed here but appended after the
   * caller's `await` resolved would land behind any model or gateway call
   * sealed on the host chain in between: the chain reads out of order, and a
   * busy scan could ship past the held frame and mark it skipped. The hook
   * check seals before the scan yields, so its frames are recorded before
   * it; the transcript seals come after the scan and are recorded before the
   * pass returns, not after the promise settles.
   */
  async tick(record: RecordSink = () => {}): Promise<TachoEvent[]> {
    const hooks = this.checkHooks();
    record(hooks);
    return [...hooks, ...(await this.checkTranscripts(record))];
  }
}
