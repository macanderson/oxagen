/**
 * The unobserved-session and hooks-removed detector (spec section 11).
 * Watches transcript files under Claude Code's project root and the list
 * of `claude` processes; a transcript that advances with no hook stream is
 * chained as `oxagen:unobserved_session` on the daemon's own chain. Re-reads
 * the settings file on every tick and chains `oxagen:hooks_removed` when
 * Tacho's entries disappear, `oxagen:hook_health` when they come back.
 */
import { readdirSync, statSync } from "node:fs";
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
  now: () => number;
  /** How long a transcript may advance unhooked before it is an incident. */
  graceMs?: number;
}

interface TranscriptSighting {
  path: string;
  firstSeenAt: number;
  lastMtimeMs: number;
  reported: boolean;
}

const SESSION_FILE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

export function listTranscripts(
  roots: readonly string[],
): Array<{ sessionId: string; path: string; mtimeMs: number }> {
  const out: Array<{ sessionId: string; path: string; mtimeMs: number }> = [];
  for (const root of roots) {
    let projects: string[];
    try {
      projects = readdirSync(root);
    } catch {
      continue;
    }
    for (const project of projects) {
      const dir = join(root, project);
      let files: string[];
      try {
        files = readdirSync(dir);
      } catch {
        continue;
      }
      for (const file of files) {
        const match = SESSION_FILE.exec(file);
        if (match === null) continue;
        const path = join(dir, file);
        try {
          out.push({
            sessionId: match[1] as string,
            path,
            mtimeMs: statSync(path).mtimeMs,
          });
        } catch {
          // Deleted between readdir and stat.
        }
      }
    }
  }
  return out;
}

export class Detector {
  private readonly deps: DetectorDeps;
  private readonly sightings = new Map<string, TranscriptSighting>();
  private lastPresence: HookPresence | undefined;
  private hooksOk: boolean | undefined;

  constructor(deps: DetectorDeps) {
    this.deps = deps;
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

  private checkTranscripts(): TachoEvent[] {
    const now = this.deps.now();
    const grace = this.deps.graceMs ?? 30_000;
    const processes = this.deps.listProcesses();
    const events: TachoEvent[] = [];
    for (const transcript of listTranscripts(this.deps.transcriptRoots)) {
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
    return events;
  }

  /** One detector pass; returns the incidents it chained. */
  tick(): TachoEvent[] {
    return [...this.checkHooks(), ...this.checkTranscripts()];
  }
}
