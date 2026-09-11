/**
 * The session registry (spec plan PR 3): one recorder per live Claude Code
 * session, keyed by the harness session id, with the operator control state
 * a command can set (pause, cancel, message) and the process facts the
 * detector and the kill path need. Persists to `daemon.json` so a daemon
 * restart continues every chain instead of forking it.
 */
import type { ClaudeCodeContext } from "../claude-code/context";
import { type RecorderState, SessionRecorder } from "../claude-code/recorder";
import type { TachoEvent } from "../envelope";
import { toProtocolTimestamp } from "../timestamp";

export interface SessionControl {
  paused: string | null;
  cancelled: string | null;
  /** Operator messages to inject at the next boundary. */
  messages: Array<{ id: string; text: string }>;
}

export interface SessionFacts {
  transcriptPath?: string;
  cwd?: string;
  pid?: number;
}

export interface SessionRecord extends SessionFacts {
  harnessSessionId: string;
  recorder: SessionRecorder;
  control: SessionControl;
  startedAt: string;
  lastSeenAt: string;
  /** True once `agent_stop` sealed the chain. */
  sealed: boolean;
  /** The chain seq the last checkpoint covered. */
  lastCheckpointSeq: number;
  /** The session never sent a hook; only OTel or a transcript showed it. */
  ambient: boolean;
}

export interface PersistedSession extends SessionFacts {
  harnessSessionId: string;
  recorder: RecorderState;
  control: SessionControl;
  startedAt: string;
  lastSeenAt: string;
  sealed: boolean;
  lastCheckpointSeq: number;
  ambient: boolean;
}

export interface RegistryState {
  schema: "tacho.daemon-state.v1";
  sessions: PersistedSession[];
}

export interface RegistryOptions {
  context: ClaudeCodeContext;
  scope: string;
  now: () => number;
}

export class SessionRegistry {
  private readonly options: RegistryOptions;
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(options: RegistryOptions) {
    this.options = options;
  }

  private ts(): string {
    return toProtocolTimestamp(this.options.now());
  }

  get(harnessSessionId: string): SessionRecord | undefined {
    return this.sessions.get(harnessSessionId);
  }

  byUuid(sessionUuid: string): SessionRecord | undefined {
    for (const record of this.sessions.values()) {
      if (record.recorder.sessionUuid === sessionUuid) return record;
      if (record.recorder.rootSessionUuid === sessionUuid) return record;
      for (const child of record.recorder.openChildren.values()) {
        if (child.sessionUuid === sessionUuid) return record;
      }
    }
    return undefined;
  }

  list(): SessionRecord[] {
    return [...this.sessions.values()];
  }

  live(): SessionRecord[] {
    return this.list().filter((record) => !record.sealed);
  }

  /** Find or open the record for a harness session, absorbing new facts. */
  ensure(
    harnessSessionId: string,
    facts: SessionFacts & { ambient?: boolean } = {},
  ): { record: SessionRecord; created: boolean } {
    const now = this.ts();
    const existing = this.sessions.get(harnessSessionId);
    if (existing) {
      if (facts.transcriptPath !== undefined)
        existing.transcriptPath = facts.transcriptPath;
      if (facts.cwd !== undefined) existing.cwd = facts.cwd;
      if (facts.pid !== undefined) existing.pid = facts.pid;
      if (facts.ambient === false) existing.ambient = false;
      existing.lastSeenAt = now;
      return { record: existing, created: false };
    }
    const record: SessionRecord = {
      harnessSessionId,
      recorder: new SessionRecorder({
        context: this.options.context,
        harnessSessionId,
        scope: this.options.scope,
      }),
      control: { paused: null, cancelled: null, messages: [] },
      startedAt: now,
      lastSeenAt: now,
      sealed: false,
      lastCheckpointSeq: -1,
      ambient: facts.ambient ?? false,
      ...(facts.transcriptPath !== undefined
        ? { transcriptPath: facts.transcriptPath }
        : {}),
      ...(facts.cwd !== undefined ? { cwd: facts.cwd } : {}),
      ...(facts.pid !== undefined ? { pid: facts.pid } : {}),
    };
    this.sessions.set(harnessSessionId, record);
    return { record, created: true };
  }

  touch(harnessSessionId: string): void {
    const record = this.sessions.get(harnessSessionId);
    if (record) record.lastSeenAt = this.ts();
  }

  /** Mark a chain sealed after `agent_stop` landed on it. */
  seal(harnessSessionId: string): void {
    const record = this.sessions.get(harnessSessionId);
    if (record) record.sealed = true;
  }

  /** Forget sealed sessions older than `retainMs`. */
  forgetSealed(retainMs: number): string[] {
    const cutoff = this.options.now() - retainMs;
    const removed: string[] = [];
    for (const [id, record] of this.sessions) {
      if (record.sealed && Date.parse(record.lastSeenAt) < cutoff) {
        this.sessions.delete(id);
        removed.push(id);
      }
    }
    return removed;
  }

  /**
   * Close chains whose process is gone (or, with no pid known, idle past
   * `idleMs`). Returns the sealing events. A session that only ever showed
   * up through OTel or a transcript is closed as `crashed` too: the harness
   * never told us it ended.
   */
  sweep(isAlive: (pid: number) => boolean, idleMs: number): TachoEvent[] {
    const out: TachoEvent[] = [];
    const now = this.options.now();
    for (const record of this.sessions.values()) {
      if (record.sealed) continue;
      const gone = record.pid !== undefined ? !isAlive(record.pid) : false;
      const idle = now - Date.parse(record.lastSeenAt) > idleMs;
      if (!gone && !(record.pid === undefined && idle)) continue;
      if (!record.recorder.hasStarted) {
        record.sealed = true;
        continue;
      }
      out.push(...record.recorder.finalize("crashed", this.ts()));
      record.sealed = true;
    }
    return out;
  }

  state(): RegistryState {
    return {
      schema: "tacho.daemon-state.v1",
      sessions: this.list().map((record) => ({
        harnessSessionId: record.harnessSessionId,
        recorder: record.recorder.state(),
        control: {
          paused: record.control.paused,
          cancelled: record.control.cancelled,
          messages: [...record.control.messages],
        },
        startedAt: record.startedAt,
        lastSeenAt: record.lastSeenAt,
        sealed: record.sealed,
        lastCheckpointSeq: record.lastCheckpointSeq,
        ambient: record.ambient,
        ...(record.transcriptPath !== undefined
          ? { transcriptPath: record.transcriptPath }
          : {}),
        ...(record.cwd !== undefined ? { cwd: record.cwd } : {}),
        ...(record.pid !== undefined ? { pid: record.pid } : {}),
      })),
    };
  }

  restore(state: RegistryState): void {
    for (const persisted of state.sessions) {
      this.sessions.set(persisted.harnessSessionId, {
        harnessSessionId: persisted.harnessSessionId,
        recorder: new SessionRecorder({
          context: this.options.context,
          harnessSessionId: persisted.harnessSessionId,
          scope: this.options.scope,
          restore: persisted.recorder,
        }),
        control: persisted.control,
        startedAt: persisted.startedAt,
        lastSeenAt: persisted.lastSeenAt,
        sealed: persisted.sealed,
        lastCheckpointSeq: persisted.lastCheckpointSeq,
        ambient: persisted.ambient,
        ...(persisted.transcriptPath !== undefined
          ? { transcriptPath: persisted.transcriptPath }
          : {}),
        ...(persisted.cwd !== undefined ? { cwd: persisted.cwd } : {}),
        ...(persisted.pid !== undefined ? { pid: persisted.pid } : {}),
      });
    }
  }
}
