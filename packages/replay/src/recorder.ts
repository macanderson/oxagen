/**
 * The session recorder (ADR-028) — the write side of time-travel replay.
 *
 * Wired into the fleet session runner, it records what the bounded ADR-023
 * envelope cannot: full tool I/O (via a ToolSet wrapper), the full per-turn
 * model history, and filesystem layers (git baseline + per-turn changed-file
 * snapshots).
 *
 * Failure stance: the recorder must NEVER fail or slow the session it
 * observes. Any write/capture error disables the recorder for the rest of the
 * session and reports once through `onError`; the run itself proceeds.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ToolSet } from "ai";
import { safeStableStringify } from "./hash.js";
import {
  MAX_HISTORY_BLOB_BYTES,
  MAX_LAYER_FILE_BYTES,
  MAX_TOOL_BLOB_BYTES,
  type LayerFile,
  type RecordUsage,
} from "./records.js";
import { RecordStore, type RecordWriter } from "./store.js";

/** Minimal exec port so tests inject a fake git. */
export type ExecPort = (
  cmd: string,
  args: string[],
  opts: { cwd: string },
) => Promise<{ stdout: string; code: number }>;

const defaultExec: ExecPort = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd: opts.cwd, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        const code = err
          ? (((err as { code?: unknown }).code as number | undefined) ?? 1)
          : 0;
        resolve({
          stdout: stdout ?? "",
          code: typeof code === "number" ? code : 1,
        });
      },
    );
  });

export interface SessionRecorderOptions {
  /** The session's `record/` directory (see {@link openRecordStore}). */
  store: RecordStore;
  sid: string;
  cwd: string;
  now?: () => number;
  exec?: ExecPort;
  /** Reported ONCE, on the first error that disables the recorder. */
  onError?: (message: string) => void;
}

export interface RecorderStartArgs {
  prompt: string;
  model?: string;
  agent?: string;
  cliVersion?: string;
}

export interface RecorderTurnEndArgs {
  turn: number;
  /** Full ModelMessage[] history after this turn (from `runTurn`'s result). */
  messages: unknown;
  changedFiles: string[];
  steps: number;
  stopReason?: string;
  usage: RecordUsage;
}

/**
 * Records one session's deterministic sidecar. Construct with
 * {@link createSessionRecorder}; call `start` once before the first turn.
 */
export class SessionRecorder {
  private readonly store: RecordStore;
  private readonly sid: string;
  private readonly cwd: string;
  private readonly exec: ExecPort;
  private readonly onError?: (message: string) => void;
  /** Injected clock handed to the writer (tests pin it for stable `ts`). */
  private readonly writerNow?: () => number;
  private writer: RecordWriter | null = null;
  private isDisabled = false;
  private toolIdx = 0;
  private currentTurn = 1;
  /**
   * In-flight `tool.io` captures. Their blob writes are deliberately off the
   * tool's critical path, so `flush` has to await them explicitly — otherwise
   * the last turn's tool calls are lost when the session finalizes.
   */
  private readonly pendingCaptures = new Set<Promise<void>>();

  constructor(opts: SessionRecorderOptions) {
    this.store = opts.store;
    this.sid = opts.sid;
    this.cwd = opts.cwd;
    this.exec = opts.exec ?? defaultExec;
    this.onError = opts.onError;
    this.writerNow = opts.now;
  }

  /** True when recording is still live (no error has disabled it). */
  get isRecording(): boolean {
    return this.writer !== null && !this.isDisabled;
  }

  /**
   * Initialize the store, capture the git baseline (HEAD sha + pre-run content
   * of every dirty file, as layer 0), and write `run.meta`. Never throws.
   */
  async start(args: RecorderStartArgs): Promise<void> {
    try {
      await this.store.init();
      this.writer = this.store.openWriter({
        sid: this.sid,
        now: this.writerNow,
      });
      const gitHead = await this.gitHead();
      this.writer.append({
        t: "run.meta",
        cwd: this.cwd,
        prompt: args.prompt,
        ...(args.model !== undefined ? { model: args.model } : {}),
        ...(args.agent !== undefined ? { agent: args.agent } : {}),
        ...(args.cliVersion !== undefined
          ? { cliVersion: args.cliVersion }
          : {}),
        ...(gitHead !== null ? { gitHead } : {}),
      });
      const dirty = await this.gitDirtyFiles();
      const files = await this.snapshotFiles(dirty);
      this.writer.append({ t: "fs.layer", turn: 0, files });
    } catch (err) {
      this.disable(err);
    }
  }

  /**
   * Wrap every tool's `execute` to record its FULL input and output (success
   * or error — errors record `ok: false` and rethrow untouched). Composes
   * outside the runner's own gate/backstop wrapper so what is recorded is
   * what actually executed.
   */
  wrapTools(tools: ToolSet): ToolSet {
    const out: ToolSet = {};
    for (const [name, toolDef] of Object.entries(tools)) {
      const exec = toolDef.execute;
      if (!exec) {
        out[name] = toolDef;
        continue;
      }
      out[name] = {
        ...toolDef,
        execute: async (input: unknown, options: unknown) => {
          const startedAt = Date.now();
          const callId = (options as { toolCallId?: string } | undefined)
            ?.toolCallId;
          try {
            const output = await Promise.resolve(
              (exec as (i: unknown, o: unknown) => unknown)(input, options),
            );
            this.recordToolIo(
              name,
              callId,
              input,
              output,
              true,
              Date.now() - startedAt,
            );
            return output;
          } catch (err) {
            this.recordToolIo(
              name,
              callId,
              input,
              { error: err instanceof Error ? err.message : String(err) },
              false,
              Date.now() - startedAt,
            );
            throw err;
          }
        },
      };
    }
    return out;
  }

  /** Mark the start of turn `turn` (records the prompt the turn ran with). */
  turnStart(turn: number, prompt: string): void {
    this.currentTurn = turn;
    this.append({ t: "turn.start", turn, prompt });
  }

  /**
   * Record a settled turn: full history blob, then the filesystem layer for
   * the files this turn changed. Awaitable but never throws.
   */
  async turnEnd(args: RecorderTurnEndArgs): Promise<void> {
    if (!this.isRecording) return;
    try {
      const history = await this.store.putBlob(
        safeStableStringify(args.messages),
        {
          maxBytes: MAX_HISTORY_BLOB_BYTES,
        },
      );
      this.append({
        t: "turn.end",
        turn: args.turn,
        historyRef: history.ref,
        changedFiles: args.changedFiles,
        steps: args.steps,
        ...(args.stopReason !== undefined
          ? { stopReason: args.stopReason }
          : {}),
        usage: args.usage,
      });
      const files = await this.snapshotFiles(args.changedFiles);
      this.append({ t: "fs.layer", turn: args.turn, files });
    } catch (err) {
      this.disable(err);
    }
  }

  /**
   * Await every in-flight capture and queued write (call at session
   * finalization). Captures settle first — each one ends in an `append`, so
   * draining the writer before them would flush an incomplete log.
   */
  async flush(): Promise<void> {
    while (this.pendingCaptures.size > 0) {
      await Promise.allSettled([...this.pendingCaptures]);
    }
    await this.writer?.flush().catch(() => {});
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private append(input: Parameters<RecordWriter["append"]>[0]): void {
    if (!this.isRecording) return;
    try {
      this.writer?.append(input);
    } catch (err) {
      this.disable(err);
    }
  }

  private recordToolIo(
    name: string,
    callId: string | undefined,
    input: unknown,
    output: unknown,
    ok: boolean,
    durationMs: number,
  ): void {
    if (!this.isRecording) return;
    this.toolIdx += 1;
    const idx = this.toolIdx;
    const turn = this.currentTurn;
    // Blob writes are async; run them off the tool's critical path so the tool
    // result returns immediately and a write failure disables the recorder,
    // never the tool. `flush` awaits whatever is still in flight.
    const capture = (async () => {
      try {
        const inputBlob = await this.store.putBlob(safeStableStringify(input), {
          maxBytes: MAX_TOOL_BLOB_BYTES,
        });
        const outputBlob = await this.store.putBlob(
          safeStableStringify(output),
          {
            maxBytes: MAX_TOOL_BLOB_BYTES,
          },
        );
        this.append({
          t: "tool.io",
          turn,
          idx,
          name,
          ...(callId !== undefined ? { callId } : {}),
          inputRef: inputBlob.ref,
          outputRef: outputBlob.ref,
          ok,
          durationMs,
        });
      } catch (err) {
        this.disable(err);
      }
    })();
    this.pendingCaptures.add(capture);
    void capture.finally(() => this.pendingCaptures.delete(capture));
  }

  /**
   * Snapshot `paths` (relative to cwd) as layer files; missing → tombstone.
   *
   * Content is decoded as UTF-8, so a changed BINARY file round-trips lossily
   * (invalid sequences become U+FFFD) while `bytes` still reports the true
   * on-disk length. Restoring such a file writes the mangled text back. Fixing
   * that needs a `record-v1` encoding field, so it is a schema decision, not a
   * local one.
   */
  private async snapshotFiles(paths: string[]): Promise<LayerFile[]> {
    const files: LayerFile[] = [];
    for (const path of [...new Set(paths)].sort()) {
      if (isAbsolute(path) || path.split("/").includes("..")) continue; // Never wander outside the tree.
      try {
        const content = await readFile(join(this.cwd, path));
        if (content.byteLength > MAX_LAYER_FILE_BYTES) {
          files.push({
            path,
            ref: null,
            bytes: content.byteLength,
            isSkipped: true,
          });
          continue;
        }
        const blob = await this.store.putBlob(content.toString("utf8"));
        files.push({ path, ref: blob.ref, bytes: content.byteLength });
      } catch {
        files.push({ path, ref: null, bytes: 0 }); // Deleted (or unreadable) → tombstone.
      }
    }
    return files;
  }

  private async gitHead(): Promise<string | null> {
    const res = await this.exec("git", ["rev-parse", "HEAD"], {
      cwd: this.cwd,
    }).catch(() => null);
    if (!res || res.code !== 0) return null;
    const sha = res.stdout.trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  }

  /**
   * Paths dirty at session start (staged, unstaged, and untracked).
   *
   * `core.quotePath=false` is not cosmetic: with git's default, a non-ASCII
   * path comes back C-quoted (`"src/\303\251.ts"`), which then fails to read
   * and gets recorded as a baseline tombstone — i.e. the file silently loses
   * its pre-run content and a restore claims it never existed.
   */
  private async gitDirtyFiles(): Promise<string[]> {
    const res = await this.exec(
      "git",
      ["-c", "core.quotePath=false", "status", "--porcelain"],
      {
        cwd: this.cwd,
      },
    ).catch(() => null);
    if (!res || res.code !== 0) return [];
    const paths: string[] = [];
    for (const line of res.stdout.split("\n")) {
      if (line.length < 4) continue;
      // Porcelain v1: XY <path> (renames: "old -> new" — snapshot the new side).
      const rest = line.slice(3);
      const arrow = rest.indexOf(" -> ");
      paths.push((arrow >= 0 ? rest.slice(arrow + 4) : rest).trim());
    }
    return paths.filter((p) => p !== "");
  }

  private disable(err: unknown): void {
    if (this.isDisabled) return;
    this.isDisabled = true;
    this.onError?.(err instanceof Error ? err.message : String(err));
  }
}

/** Build a recorder for one session. Call `start` before the first turn. */
export function createSessionRecorder(
  opts: SessionRecorderOptions,
): SessionRecorder {
  return new SessionRecorder(opts);
}
