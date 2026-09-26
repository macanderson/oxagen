/**
 * `tachod`: the per-host collector (spec section 3). Composes the listener,
 * the session registry, the WAL, the shipper, the command inbox, the
 * detector, and the checkpoint signer around one host file. Everything with
 * a side effect is injectable so the whole daemon runs in a test against a
 * fake control plane and a scratch `TACHO_HOME`.
 */
import { createContainedRunner } from "../contained/runner";
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { z } from "zod";
import { hookInputSchema } from "../claude-code/hooks";
import { homedir, hostname as osHostname } from "node:os";
import { dirname, join } from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { type ClaudeCodeContext, digestText } from "../claude-code/context";
import { normalizeOtlp, type OtlpPayload } from "../claude-code/otel";
import type {
  ChainMark,
  RecorderState,
  SessionRecorder,
} from "../claude-code/recorder";
import { tachoEventSchema, type TachoEvent } from "../envelope";
import { type FrameBody, retentionAllows } from "../evidence/frame-body";
import { pollEtag, verifyBundle } from "../host/bundle";
import {
  ControlError,
  createControlClient,
  type ControlClient,
  type FetchLike,
  type RateLimitHint,
} from "../host/control-client";
import {
  type CredentialStore,
  openCredentialStore,
} from "../host/credential-store";
import { type DeviceKey, loadOrCreateDeviceKey } from "../host/device-key";
import {
  ensureDir,
  readJsonFileIfExists,
  writeSensitiveFileAtomic,
} from "../host/fs";
import {
  applyControlFacts,
  currentEnrollment,
  type HostFile,
  hostStatusInForce,
  readHostFile,
  readHostFileLenient,
  mcpEndpointFor,
  modelProxyPortFor,
  sessionScopeOf,
} from "../host/host-file";
import { readModelBaseUrlState } from "../host/model-base-url";
import {
  applyModelCredentials,
  type ModelCredentialHarnessState,
  readCodexApiKeyMember,
  readModelCredentialState,
  staticTokenStillGood,
} from "../host/model-credential";
import {
  loadOrCreateRunTokenKey,
  readRunTokenKey,
  RUN_TOKEN_PROVIDERS,
  type RunTokenKey,
  verifyRunToken,
} from "../host/run-token";
import type { TachoPaths } from "../host/paths";
import { isProcessAlive, listClaudeProcesses } from "../host/process-scan";
import type { Exec, ExecAsync, ExecResult } from "../host/service";
import {
  HOST_RETENTION_CLASSES,
  narrowestOf,
  NO_RETENTION,
  RETENTION_CLASS_BY_KIND,
  type RetentionMandate,
} from "../evidence/retention";
import { Wal, WalRecoveryConflict } from "../host/wal";
import { ulid } from "../ids";
import { toProtocolTimestamp } from "../timestamp";
import {
  tachoHarnessSchema,
  TACHO_ENFORCEMENT_TIER_ATTR,
  TACHO_GATEWAY_TIER,
  TACHO_METERING_ATTR,
  TACHO_METERING_OBSERVED,
  type CommandAcknowledgement,
  type AgentDaySpend,
  type ControlEnvelope,
  type DaemonHealth,
  type ModelBaseUrlReport,
  TACHO_BUNDLE_FEATURES,
  TACHO_CREDENTIAL_GATEWAY_BROKERED,
  TACHO_CREDENTIAL_HARNESS_HELD,
} from "../wire";
import { Detector } from "./detector";
import { createGitLane } from "./git-lane";
import { exportSession, type ExportFormat } from "./exporters";
import {
  handleHookEvent,
  hookLedgerKey,
  type HookReplay,
  type PolicyView,
} from "./hook-handler";
import {
  appendHookIdJournal,
  clearHookIdJournal,
  hookIdJournalEntry,
  restoreHookIdJournal,
} from "./hook-id-journal";
import {
  applyCommands as applyDeliveredCommands,
  HandledCommands,
} from "./inbox";
import {
  createMcpGateway,
  type GatewayAttribution,
  type GatewayCallRecord,
  type GatewayFetch,
} from "./mcp-gateway";
import { createGithubProxy } from "./github-proxy";
import { pushCredentialBasis } from "./push-basis";
import { issueRunToken } from "./credential-issuer";
import { utcDay } from "./day-spend";
import { type BeforeForward, createModelProxy } from "./model-proxy";
import { createModelProxyListener } from "./model-proxy-listener";
import {
  DEFAULT_MODEL_UPSTREAMS,
  MODEL_PROXY_ROUTES,
  type ModelUpstreams,
} from "./model-routes";
import {
  forgetHookId,
  HOOK_ID_REPLAY_WINDOW_MS,
  parseRegistryState,
  pruneHookIds,
  sessionMapKey,
  type SessionRecord,
  type RegistryState,
  SessionRegistry,
} from "./registry";
import {
  type CollectorApi,
  type CollectorServer,
  createCollectorServer,
  type HookEnvelope,
} from "./server";
import {
  isHostRevokedRefusal,
  type RetentionDecision,
  Shipper,
  serverRequestedWaitMs,
} from "./spool";
import { TranscriptTailer } from "./transcript-tailer";

export interface DaemonTimers {
  shipMs: number;
  bundleRefreshMs: number;
  commandsPollMs: number;
  detectorMs: number;
  checkpointMs: number;
  sweepMs: number;
  idleSessionMs: number;
  walRetainMs: number;
}

export const DEFAULT_TIMERS: DaemonTimers = {
  shipMs: 5_000,
  bundleRefreshMs: 5 * 60_000,
  commandsPollMs: 30_000,
  detectorMs: 15_000,
  checkpointMs: 60_000,
  sweepMs: 30_000,
  idleSessionMs: 6 * 60 * 60_000,
  walRetainMs: 7 * 24 * 60 * 60_000,
};

/** How often the daemon looks at Codex's static run token. */
const STATIC_TOKEN_RENEWAL_CHECK_MS = 60 * 60_000;

export interface DaemonOptions {
  paths: TachoPaths;
  host?: HostFile;
  fetch?: FetchLike;
  exec?: Exec;
  /**
   * The port the git probes use. Defaults to a promisified `exec` when one
   * is injected, and otherwise to `execFile`.
   */
  execAsync?: ExecAsync;
  now?: () => number;
  log?: (line: string) => void;
  timers?: Partial<DaemonTimers>;
  /** Start the listeners (default true); tests can drive the API directly. */
  listen?: boolean;
  /** Override the loopback port from the host file (0 = ephemeral). */
  port?: number;
  /** `win32` listens on loopback TCP only (no Unix socket). */
  platform?: NodeJS.Platform;
  kill?: (pid: number, signal: "SIGTERM" | "SIGKILL") => boolean;
  transcriptRoots?: string[];
  /** Override the model proxy's port from the host file (0 = ephemeral). */
  modelProxyPort?: number;
  /**
   * Where the model proxy forwards. Defaults to the vendors' own hosts, or to
   * the base URL enrollment displaced from a harness's config, so a harness
   * that was already pointed at a corporate gateway still reaches it.
   */
  modelUpstreams?: Partial<ModelUpstreams>;
  /** The per-turn steering seam; a no-op until Phase 1's assembler exists. */
  beforeForward?: BeforeForward;
  /** The home directory the harness config files live under. */
  home?: string;
}

export interface DaemonHandle {
  api: CollectorApi;
  registry: SessionRegistry;
  wal: Wal;
  shipper: Shipper;
  detector: Detector;
  transcriptTailer: TranscriptTailer;
  hostRecorder: SessionRecorder;
  host: () => HostFile;
  port: number | undefined;
  /** The model proxy's bound port, or undefined when it is not listening. */
  modelProxyPort: number | undefined;
  /**
   * Run the periodic work once, in order, and wait for the git reconciliation
   * it started; tests call this instead of waiting.
   *
   * The interval driver does NOT call this — it drives the control path alone,
   * so a slow worktree cannot delay an operator's command. This seam exists so
   * that a caller stepping the daemon by hand still sees the reconciliation.
   */
  tick: () => Promise<void>;
  /** Wait for the git reconciliation lane to settle, starting one if due. */
  flushGitReads: () => Promise<void>;
  drainSpool: () => Promise<number>;
  refreshBundle: () => Promise<boolean>;
  stop: () => Promise<void>;
}

/**
 * The retention class of a prompt queued for a boundary: the class of the
 * `oxagen:message` frame that delivers it.
 */
const QUEUED_PROMPT_CLASS =
  RETENTION_CLASS_BY_KIND["oxagen:message"] ?? "model_call";

/** How many sealed events each recorder keeps in memory after a tick. */
const RECORDER_EVENTS_KEPT = 64;

interface SpoolFile {
  schema: "tacho.spool.v1";
  received_at: string;
  payload: unknown;
  env?: Record<string, string | undefined>;
  evaluation?: HookReplay["evaluation"];
  harness?: HookEnvelope["harness"];
  agent?: HookEnvelope["agent"];
  hook_id?: HookEnvelope["hook_id"];
}

/**
 * The daemon's own `Exec`, with two bounds the default does not have.
 *
 * `maxBuffer` is 1 MiB by default, and a `git status` in a worktree holding a
 * build directory passes that easily. Over the limit spawnSync reports an
 * error rather than output, so the caller reads it as "not a repository" and
 * loses the fact for exactly the worktrees it most wanted it for. The git
 * reader truncates its own stdout at 2 MiB, so the buffer is set above that
 * and the reader's bound is the one that binds.
 *
 * `timeout` bounds how long one command may take. Nothing read here has an
 * answer worth waiting on: a read that times out returns no status, the
 * caller records no fact, and the session carries on.
 */
function defaultExec(command: string, args: string[]): ReturnType<Exec> {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 10_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/**
 * The daemon's asynchronous `Exec`, carrying the same two bounds.
 *
 * The git probes run through this one rather than through `defaultExec`.
 * `spawnSync` stops this process's event loop until the child exits, and
 * this process is the one answering hooks: a tick may read up to
 * `GIT_READS_PER_TICK` worktrees, each of them several git commands with a
 * ten second ceiling apiece, so one slow repository could keep the listener
 * from answering any hook at all until the hooks gave up and decided
 * locally. A hook that decides locally is a mandate that was not enforced,
 * which is why the probes had to stop blocking.
 *
 * `execFile` reports a non-zero exit as an error carrying the child's own
 * `code`, and a spawn failure as an error with no code at all. Both become a
 * status here rather than a rejection, because the reader upstream treats
 * every failure the same way: no facts, no throw.
 */
function defaultExecAsync(
  command: string,
  args: string[],
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 10_000 },
      (error, stdout, stderr) => {
        const code = (error as (Error & { code?: number | string }) | null)
          ?.code;
        resolve({
          status: error === null ? 0 : typeof code === "number" ? code : 1,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
      },
    );
  });
}

function defaultKill(pid: number, signal: "SIGTERM" | "SIGKILL"): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** A serial queue: hook handling for one daemon never interleaves. */
class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/**
 * Correct a restored recorder cursor against the WAL it is supposed to be
 * standing on top of, before anything is sealed on top of it.
 *
 * `state.json` is written at tick end (`persistState`, gated on
 * `stateDirty`), which is after the WAL append it answers for on the happy
 * path but is not guaranteed to be: a crash between the two, or a `state.json`
 * write that raced a WAL failure, can leave the persisted cursor behind what
 * the log already holds. Restoring that stale cursor unchanged reseals at a
 * seq the file already has, and ClickHouse's `ReplacingMergeTree` — keyed on
 * seq — silently keeps the newer, wrong frame over the original. `Wal.append`
 * now refuses that write outright, but refusing it at startup, once, with the
 * cursor corrected, is what keeps the daemon booting instead of crash-looping
 * on its own recovered state.
 *
 * `wal.lastEvent` reads from the tail of the file, not the whole thing, so
 * this costs one small read per restored session rather than a full replay.
 * A subagent's chain is its own session, in its own WAL file, so children are
 * walked and corrected the same way, recursively.
 */
export function reconcileRestoredCursor(
  state: RecorderState,
  wal: Wal,
  log: (line: string) => void,
): void {
  // Legacy states from a build before `sessionUuid` was persisted derive it
  // from the harness session id at restore time, a step only the registry
  // can take (it alone holds the seed and the scope). Nothing to correct
  // here without it; the registry's own restore still runs.
  if (state.sessionUuid !== undefined) {
    const head = wal.lastEvent(state.sessionUuid);
    if (head !== undefined && head.seq >= state.cursor.seq) {
      log(
        `restored cursor for session ${state.sessionUuid} was seq ${state.cursor.seq}; the WAL already holds through seq ${head.seq}, advancing to match`,
      );
      state.cursor = {
        seq: head.seq + 1,
        prevHash: head.hash as RecorderState["cursor"]["prevHash"],
      };
    }
  }
  for (const child of Object.values(state.children))
    reconcileRestoredCursor(child.state, wal, log);
}

export async function startDaemon(
  options: DaemonOptions,
): Promise<DaemonHandle> {
  const loaded = options.host ?? readHostFile(options.paths.hostFile);
  if (loaded === undefined) {
    throw new Error(
      `no enrollment at ${options.paths.hostFile}; run \`tacho enroll\` first`,
    );
  }
  ensureDir(options.paths.root);
  let ready: CollectorApi | undefined;
  const log =
    options.log ??
    ((line: string) => {
      const now = options.now?.() ?? Date.now();
      process.stderr.write(`${new Date(now).toISOString()} tachod ${line}\n`);
    });
  const server = createCollectorServer(() => ready, log);
  let port: number | undefined;
  try {
    // Own the listeners before loading recorder state or appending any WAL
    // frame. A rejected second process must leave the active chains untouched.
    if (options.listen ?? true) {
      const unixSocket = (options.platform ?? process.platform) !== "win32";
      port = (
        await server.listen({
          ...(unixSocket ? { socketPath: options.paths.socket } : {}),
          port: options.port ?? loaded.port,
        })
      ).port;
    }
    return await initializeDaemon(
      { ...options, host: loaded, log },
      server,
      port,
      (api) => {
        ready = api;
      },
    );
  } catch (error) {
    await server.close();
    throw error;
  }
}

async function initializeDaemon(
  options: DaemonOptions,
  server: CollectorServer,
  port: number | undefined,
  ready: (api: CollectorApi) => void,
): Promise<DaemonHandle> {
  const paths = options.paths;
  const now = options.now ?? (() => Date.now());
  const log =
    options.log ??
    ((line: string) => {
      process.stderr.write(`${new Date(now()).toISOString()} tachod ${line}\n`);
    });
  const timers: DaemonTimers = { ...DEFAULT_TIMERS, ...options.timers };
  const exec = options.exec ?? defaultExec;
  // An injected synchronous `exec` still governs the git probes, so a test
  // that hands the daemon a fake git does not get a real one. Only a daemon
  // given neither port reaches for a child process.
  const execAsync: ExecAsync =
    options.execAsync ??
    (options.exec !== undefined
      ? async (command, args) => exec(command, args)
      : defaultExecAsync);
  const kill = options.kill ?? defaultKill;
  const loaded = options.host ?? readHostFile(paths.hostFile);
  if (loaded === undefined) {
    throw new Error(
      `no enrollment at ${paths.hostFile}; run \`tacho enroll\` first`,
    );
  }
  let host: HostFile = loaded;
  for (const dir of [paths.root, paths.wal, paths.spool, paths.quarantine])
    ensureDir(dir);

  const deviceKey: DeviceKey = loadOrCreateDeviceKey(paths.deviceKey).key;
  const startedAt = now();
  const context: ClaudeCodeContext = {
    agent: {
      agent_key: host.agent_key,
      fleet_id: host.workspace_id,
      runtime: "claude-code",
      harness: "claude-code",
      wrapper_version: host.wrapper_version,
      host_enrollment_id: host.host_enrollment_id,
    },
    host: { hostname_digest: digestText(host.hostname || osHostname()) },
    now,
  };
  const wal = new Wal(
    paths.wal,
    (failure) => {
      log(
        `WAL body unavailable for session ${failure.session_uuid}: ${failure.operation} ${failure.code}`,
      );
    },
    (gap) => {
      log(
        `chain gap written for session ${gap.session_uuid}: ${gap.kind} seq ${gap.seq} follows seq ${gap.after_seq}`,
      );
    },
    (failure) => {
      log(
        `WAL event line unparseable for session ${failure.session_uuid}: ${failure.reason}`,
      );
    },
  );
  // Only the daemon repairs a torn tail, and only once, before anything else
  // touches the WAL: a reader building its own `Wal` (`tacho status`, `tacho
  // export`) must never rewrite a file this process might still be writing
  // to, and a live daemon's own writes only ever extend a file it already
  // holds open through `append`, never race a repair of its own past tail.
  for (const session of wal.sessions()) {
    const outcome = wal.repairTail(session);
    if (outcome !== "ok")
      log(`WAL tail repair for session ${session}: ${outcome}`);
  }
  // After the event tails, which say where each chain ends, and before a
  // recorder seals the next event at an orphan's seq (#3372).
  const orphanBodies = wal.repairOrphanBodies();
  if (orphanBodies > 0)
    log(`WAL removed ${orphanBodies} body lines a crash left with no event`);
  // Every recorder this daemon opens without restored state, a session or a
  // subagent under one, starts after the last event its WAL file already
  // holds. `reconcileRestoredCursor` below does the same for the chains
  // `daemon.json` names; this covers the ones it lost.
  context.chainTail = (sessionUuid) => {
    const head = wal.lastEvent(sessionUuid);
    return head === undefined
      ? undefined
      : {
          seq: head.seq + 1,
          prevHash: head.hash as RecorderState["cursor"]["prevHash"],
          stopped: head.kind === "agent_stop",
        };
  };
  // The session scope outlives an enrollment that replaces this one on the
  // same machine and in the same workspace, so a live session keeps its uuid
  // across `enroll --force`, a harness addition and a harness-only reassign
  // (ADR-179).
  const registry = new SessionRegistry({
    context,
    scope: sessionScopeOf(host),
    now,
  });
  // Read before anything in this startup touches the file, so it names the
  // previous process's last write — the moment its record of a live session
  // stopped, whatever silently killed it. Used by the restart telemetry gap
  // below.
  const priorStateWrittenAt = existsSync(paths.daemonState)
    ? statSync(paths.daemonState).mtimeMs
    : undefined;
  const persisted = parseRegistryState(readJsonFileIfExists(paths.daemonState));
  if (persisted !== undefined) {
    for (const session of persisted.sessions)
      reconcileRestoredCursor(session.recorder, wal, log);
    registry.restore(persisted);
  }
  // The hooks recorded after that state file was written. Read after the
  // restore, which created the records they name. `stateDirty` is set below,
  // once it exists, so the first tick writes them into the state file and
  // the journal can go.
  const journaledHookIds = restoreHookIdJournal(
    paths.hookIdJournal,
    registry,
    (uuid) => wal.lastEvent(uuid)?.seq,
  );

  // The daemon's own chain: host-level incidents, commands, and checkpoints
  // land here so every event the host emits belongs to a verifiable session.
  const bootId = `tachod-${ulid(now())}`;
  const hostRecord = registry.ensure(bootId, { pid: process.pid }).record;
  const hostRecorder = hostRecord.recorder;

  /**
   * The credential seam (ADR-143): the vendor credentials this gateway holds
   * in custody, and the key that signs the run tokens a brokered harness
   * presents instead. Both are re-read from disk on use rather than cached,
   * so `tacho enroll` taking a key into custody, or `tacho unenroll` rotating
   * the signing key, is honoured on the next call without a restart.
   */
  const credentialStore: CredentialStore = openCredentialStore({
    file: paths.credentials,
    key: paths.credentialsKey,
  });
  const runTokenKey = (): RunTokenKey =>
    readRunTokenKey(paths.runTokenKey) ??
    loadOrCreateRunTokenKey(paths.runTokenKey).key;
  runTokenKey();
  function inCustody(provider: "anthropic" | "openai"): boolean {
    try {
      return credentialStore.has(provider);
    } catch (error) {
      log(
        `credential store unreadable: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  let bundleVerified = verifyBundle(
    host.bundle,
    host.bundle_public_key_pem,
    host.host_enrollment_id,
  ).ok;
  /**
   * When the control plane last confirmed the cached mandate, as epoch ms.
   *
   * A poll that answers `not_modified` is a confirmation: it says the etag in
   * force is still this one. Freshness has to be measured from here, because
   * the etag covers policy content only, so an unchanged mandate is re-signed
   * only once the cached copy is past half its window (`pollEtag`). Between
   * re-signings its signed `expires_at` does not move. See `isStale` in
   * host/bundle.ts.
   *
   * Undefined until the control plane confirms something in this process,
   * and deliberately not seeded from `bundle_fetched_at`. That field is
   * unsigned and sits in a file on the operator's machine, while the
   * signature covers the bundle alone, so any reading of it is a freshness
   * window the operator wrote for themselves. Clamping it to startup was not
   * enough: a restart is free, so an operator could date the field forward,
   * restart, and take a fresh window every time, which keeps a revoked or
   * expired mandate in force indefinitely. The mandate is what bounds the
   * operator's own agent, so the operator must not be able to renew it.
   *
   * Nothing is lost by leaving it undefined. Both readers fall back to the
   * bundle's signed `issued_at`, so a mandate still inside its own signed
   * window reads fresh at startup exactly as before, and one that has
   * outlived that window reads stale until the control plane says otherwise.
   * The first poll confirms it, so the gap is one tick, and `issued_at` sits
   * inside the signature, so editing it fails verification and enforce mode
   * denies on `bundle_unverified` before freshness is ever consulted.
   */
  let mandateConfirmedAt: number | undefined;
  /**
   * The retention clause the host may act on: the cached one while its
   * signature holds, and nothing otherwise.
   *
   * `host.json` is a file on the operator's machine. Reading its retention
   * clause without checking the signature would let an edit from
   * `digest_only` to `content_exact` send prompt bodies until the first
   * refresh replaced the bundle, which is the one thing the signature is
   * there to prevent.
   */
  /**
   * The retention clause in force, with whether it is the workspace's answer
   * or the absence of one. Both keep nothing that is not covered; only a
   * proven clause also purges what is already on disk, because a lapsed or
   * unverifiable bundle is usually a transient condition and a purge is not.
   */
  const retentionInForce = (): RetentionDecision =>
    bundleVerified && !mandateLapsed()
      ? { mandate: host.bundle.retention, proven: true }
      : { mandate: NO_RETENTION, proven: false };
  /**
   * Whether the cached mandate has outlived its own signed window since the
   * control plane last confirmed it. The same rule `isStale` applies to tool
   * decisions: a grant is authority for as long as the mandate is current,
   * and no longer. A window that cannot be read grants nothing.
   */
  function mandateLapsed(): boolean {
    const issued = Date.parse(host.bundle.issued_at);
    const expires = Date.parse(host.bundle.expires_at);
    if (!Number.isFinite(issued) || !Number.isFinite(expires)) return true;
    if (expires <= issued) return true;
    // The same fallback `isStale` uses: with no confirmation recorded in this
    // process, the mandate is measured from the signed moment it was issued.
    return now() - (mandateConfirmedAt ?? issued) > expires - issued;
  }
  let lastControlAt: number | undefined;
  /** The control plane's latest figures for the agent's UTC day (ADR-160). */
  let recordedDaySpend: AgentDaySpend | undefined;
  let lastOtlpAt: number | undefined;
  let lastIngestAt: number | undefined;
  // When a command poll last succeeded. The poll's cadence gate reads it next
  // to `lastIngestAt`: a successful poll carries the same control envelope an
  // ingest does, so it earns the same `commandsPollMs` of quiet. Without it, a
  // host with no ingest for 30 s polled on every one-second tick, spent the
  // 30/min `tacho-host` budget in 30 s, and took 429s until the window turned
  // over, every minute, for as long as the host was idle (2026-09-23).
  let lastCommandPollAt: number | undefined;
  let stateDirty = journaledHookIds > 0;
  let stopped = false;
  const pendingAcks: CommandAcknowledgement[] = [];
  // The control plane delivers a `sent` command again until its
  // acknowledgement lands. Every delivery goes through this daemon's record
  // of the commands it already answered, so a steer is queued once and a kill
  // signalled once however often it arrives. In memory only: `daemon.json` is
  // the registry's state and has no place for it.
  const handledCommands = new HandledCommands();
  const applyCommands: typeof applyDeliveredCommands = (commands, deps) =>
    applyDeliveredCommands(commands, { ...deps, handled: handledCommands });
  const serial = new Serial();

  // Exponential backoff for the command poll, the same 2s→60s shape the
  // Shipper already applies to ingest. Without it a control plane that is
  // down converts the daemon into a load generator against it: the tick runs
  // every second, `sendAcks` has no gate of its own once `lastIngestAt` goes
  // stale (and ingest going stale is exactly what an outage does), so every
  // failure is retried a second later, forever. An outage on 2026-09-17 put
  // 1770 identical failures into 2000 lines of tachod.log and grew the log to
  // 3 MB while the control plane was answering 503 to all of them. A daemon
  // that cannot reach its control plane must get quieter, not louder.
  const COMMAND_POLL_MIN_BACKOFF_MS = 2_000;
  const COMMAND_POLL_MAX_BACKOFF_MS = 60_000;
  // A 400 or 422 from the commands endpoint is not an outage, and doubling
  // toward 60 s treats it as one. It means the daemon and the control plane
  // disagree on the wire: on 2026-09-18 a daemon still sending
  // `tacho.commands.v1` polled a control plane that requires v2 and collected
  // 3,683 HTTP 400s in two and a half hours, which tripped the per-host
  // limiter and throttled `/v1/tacho/events` with it. No retry fixes a
  // schema, only an upgrade does, so the poll parks at a 15 minute floor,
  // says so once with the server's own words, and leaves ingest (a separate
  // path with its own budget) shipping.
  const COMMAND_POLL_PROTOCOL_MISMATCH_BACKOFF_MS = 15 * 60_000;
  let commandPollBackoffMs = COMMAND_POLL_MIN_BACKOFF_MS;
  let commandPollNextAttemptAt = 0;
  let commandPollFailures = 0;
  let commandPollProtocolMismatchLogged = false;

  // The client is built before the Shipper but must deliver rate-limit hints
  // to it, so the callback is indirected through a sink that the Shipper fills
  // in below. A hint arriving before the Shipper exists is simply dropped —
  // there is no backlog to pace before the first tick.
  const rateLimitSink: { notify?: (hint: RateLimitHint) => void } = {};

  const client: ControlClient = createControlClient({
    endpoints: host.endpoints,
    apiKey: host.api_key,
    hostEnrollmentId: host.host_enrollment_id,
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    userAgent: `tachod/${host.wrapper_version}`,
    now,
    // Every counted response tells us what is left of this host's budget.
    // Feeding it to the Shipper is what lets a backlog drain pace itself
    // instead of spending the whole window in the first second of a tick.
    onRateLimit: (hint) => rateLimitSink.notify?.(hint),
  });

  function persistState(): void {
    // Commit the WAL bytes this cursor answers for before the cursor itself
    // lands durably. `state.json` is read back at the next startup as a claim
    // about where each session's chain stood; writing that claim before the
    // bytes are fsynced is the ordering that let a crash leave the two
    // disagreeing, which is what `reconcileRestoredCursor` now recovers from
    // — but recovering from it is a fallback, not a reason to keep causing
    // it. One flush per call, covering everything appended since the last
    // one: a group commit, not an fsync per event.
    wal.flush();
    writeSensitiveFileAtomic(
      paths.daemonState,
      JSON.stringify(registry.state()),
    );
    // The state file now holds every ledger entry the journal did. A crash
    // between the write and this removal restores those entries twice,
    // which is harmless: remembering a key the ledger holds is a no-op.
    clearHookIdJournal(paths.hookIdJournal);
    stateDirty = false;
  }

  /**
   * Write sealed events, and the bodies of those the bundle lets this host
   * retain, to the WAL. The retention clause is read from the bundle the
   * host holds right now: enrollment writes one, so there is always a
   * clause to read, and a body the workspace has since stopped retaining is
   * dropped here rather than shipped for the control plane to refuse.
   */
  function record(
    events: readonly TachoEvent[],
    bodies: readonly FrameBody[] = [],
  ): void {
    if (events.length === 0) return;
    // Not `host.bundle.retention`: `host.json` is a file on the operator's
    // machine, and reading its clause unchecked would let an edit from
    // `digest_only` to `content_exact` write prompt bodies until the next
    // refresh replaced the bundle. `retentionInForce` keeps nothing unless
    // the cached mandate verifies and is still current.
    const retention = retentionInForce();
    wal.append(
      events,
      bodies.filter((body) =>
        retentionAllows(retention.mandate, body.content_class),
      ),
    );
    stateDirty = true;
  }

  /**
   * Every currently known session's chain position, so a caller that is
   * about to seal events it may not be able to write can put every chain
   * back if the write fails. `checkpoint` and `recordReconciliation` already
   * do this by hand for the one or few sessions they touch, and so does the
   * registry's sweep. This covers a caller (`applyCommands`,
   * `handleHookEvent`, OTel ingestion, the detector) whose sealing runs
   * inside a call this file does not own, and so does not know in advance
   * which sessions (out of everything the registry currently holds) it will
   * touch. Marking and
   * rolling back a chain the call never reaches costs nothing: the mark
   * matches the chain's position exactly and the rollback is a no-op.
   */
  function markEveryChain(): Array<{
    session: SessionRecord;
    mark: ChainMark;
  }> {
    return registry
      .list()
      .map((session) => ({ session, mark: session.recorder.markChain() }));
  }

  function rollbackEveryChain(
    marks: Array<{ session: SessionRecord; mark: ChainMark }>,
  ): void {
    // A session the failed call created has no mark: it did not exist when
    // the marks were taken. Its chain goes back to where it was born, or its
    // unwritten genesis keeps seq 0 and the retry seals a resume after it.
    // A session with a WAL file is left alone: the model proxy runs off the
    // serial queue, and it may have opened and written that session while
    // the failed call was awaiting. The exception is a session born on a
    // WAL file it continues, either opened over it (`continueFromDisk`) or
    // resumed from restored state such as a tombstone: it goes back too, as
    // long as that file still ends where it was born. Left alone, a resumed
    // chain keeps a cursor past the WAL's tail and the retry seals a gap.
    const marked = new Set(marks.map(({ session }) => session));
    const unmarked = registry.list().filter((session) => !marked.has(session));
    if (unmarked.length > 0) {
      const onDisk = new Set(wal.sessions());
      for (const session of unmarked) {
        const recorder = session.recorder;
        if (!onDisk.has(recorder.sessionUuid)) {
          recorder.rollbackToBirth();
          continue;
        }
        if (!recorder.bornOnDisk && !recorder.bornRestored) continue;
        const born = recorder.birthCursor;
        const tail = context.chainTail?.(recorder.sessionUuid);
        if (
          tail !== undefined &&
          tail.seq === born.seq &&
          tail.prevHash === born.prevHash
        )
          recorder.rollbackToBirth();
      }
    }
    for (const { session, mark } of [...marks].reverse())
      session.recorder.rollbackChain(mark);
  }

  /**
   * Every session's queued operator messages and owed resume, taken before a
   * hook that may drain them. A hook seals each delivery as it takes the item
   * off the queue, so a WAL write that then fails rolls the frame back while
   * the item is already gone. Without this, a steer lost to a full disk was
   * never delivered and never retried (#3944).
   */
  function markEveryQueue(): Array<{
    session: SessionRecord;
    messages: SessionRecord["control"]["messages"];
    resumeOwed: string | undefined;
    sealed: boolean;
  }> {
    return registry.list().map((session) => ({
      session,
      messages: [...session.control.messages],
      resumeOwed: session.control.resumeOwed,
      sealed: session.sealed,
    }));
  }

  /**
   * Withdraw the `expired` acknowledgements a failed hook's seal queued for
   * the marked messages. A SessionEnd seals its record inside
   * `handleHookEvent`, and the seal turns every queued message into an
   * `expired` ack before the terminal frame is written. When that write
   * fails the messages go back on their queues, so the acks must not ship:
   * the plane would record the steer expired and then hear a later boundary
   * report it `applied`. The ack may already have moved to `pendingAcks` if
   * a tick drained the registry during the hook's awaits, so it is taken
   * from there too.
   */
  function withdrawExpiredAcks(marks: ReturnType<typeof markEveryQueue>): void {
    const ids = new Set(
      marks.flatMap(({ messages }) => messages.map((message) => message.id)),
    );
    if (ids.size === 0) return;
    registry.withdrawExpiredOnSeal(ids);
    const kept = pendingAcks.filter(
      (ack) => !(ack.status === "expired" && ids.has(ack.command_id)),
    );
    pendingAcks.splice(0, pendingAcks.length, ...kept);
  }

  /**
   * Put each marked queue back ahead of anything queued while the hook ran.
   * A command applied during the hook's awaits stays behind the ones it
   * found, in the order it arrived, and an item already put back is not
   * queued twice. A record the hook sealed is unsealed, since its terminal
   * frame never landed, and the `expired` acks the seal queued are
   * withdrawn.
   */
  function restoreEveryQueue(marks: ReturnType<typeof markEveryQueue>): void {
    withdrawExpiredAcks(marks);
    for (const { session, messages, resumeOwed, sealed } of marks) {
      if (session.sealed && !sealed) session.sealed = false;
      const held = new Set(messages.map((message) => message.id));
      const arrived = session.control.messages.filter(
        (message) => !held.has(message.id),
      );
      session.control.messages.splice(
        0,
        session.control.messages.length,
        ...messages,
        ...arrived,
      );
      if (session.control.resumeOwed === undefined && resumeOwed !== undefined)
        session.control.resumeOwed = resumeOwed;
    }
  }

  /**
   * Run `seal`, record what it sealed, and roll every chain back to where
   * this call found it if the WAL write throws.
   *
   * A seal moves a recorder's cursor in memory before the WAL write that
   * follows it confirms the event landed. Without this, a write failure —
   * a full disk, a stale seq `Wal.append` now refuses, a body write that
   * throws — left the cursor standing on an event the log never durably
   * held, and the next seal on that chain opened a gap no verifier could
   * close. See `rollbackChain`'s own comment in `recorder.ts` for the fuller
   * account. `applyCommands` is the one caller whose seal is asynchronous
   * end to end; every other caller in this file marks and rolls back by
   * hand, scoped to the one or few sessions it actually touches, because
   * `markEveryChain` costs the whole registry and most of them do not need
   * to pay it.
   */
  async function recordSealedAsync<T>(
    seal: () => Promise<T>,
    toRecorded: (result: T) => {
      events: readonly TachoEvent[];
      bodies?: readonly FrameBody[];
    },
  ): Promise<T> {
    const marks = markEveryChain();
    try {
      const result = await seal();
      const sealedRecord = toRecorded(result);
      record(sealedRecord.events, sealedRecord.bodies ?? []);
      return result;
    } catch (error) {
      rollbackEveryChain(marks);
      throw error;
    }
  }

  /**
   * Whether each routed harness still points at the proxy, for the health
   * report. Written by `refreshUpstreams` below, which already reads the
   * state for the displaced upstreams.
   *
   * Reverting `env.ANTHROPIC_BASE_URL` or `openai_base_url` takes one file
   * edit and no restart, and left the gateway nothing to say about it: the
   * control plane saw only that sessions stopped reaching the `gateway` tier,
   * which is also what a laptop that is merely closed looks like.
   *
   * Empty until the first read succeeds, and empty when the read throws. The
   * wire contract makes absence mean *nothing was said*, never *nothing has
   * drifted*, so a failed read reports no claim rather than a false clean one.
   */
  let modelBaseUrls: ModelBaseUrlReport[] = [];

  function health(): DaemonHealth {
    const stats = wal.stats();
    const spoolFiles = readdirSync(paths.spool).filter((f) =>
      f.endsWith(".json"),
    ).length;
    return {
      version: host.wrapper_version,
      uptime_s: Math.max(0, Math.floor((now() - startedAt) / 1000)),
      spool_depth: stats.unshipped + spoolFiles,
      ...(stats.oldestUnshippedAt !== undefined
        ? { spool_oldest_at: stats.oldestUnshippedAt }
        : {}),
      ...(detector.hooksHealthy !== undefined
        ? { hooks_ok: detector.hooksHealthy }
        : {}),
      otel_ok: lastOtlpAt !== undefined && now() - lastOtlpAt < 10 * 60_000,
      bundle_etag: host.bundle.etag,
      // What this daemon's `policyBundleSchema` names, so the control plane
      // can send a gated bundle field without breaking hosts that predate it.
      // Reported from the running code rather than from `host.json`, which
      // `enroll` writes once and no upgrade rewrites.
      bundle_features: [...TACHO_BUNDLE_FEATURES],
      // Omitted until a read succeeds: absent means nothing was said, and a
      // daemon that could not read the files has nothing to say.
      ...(modelBaseUrls.length > 0 ? { model_base_urls: modelBaseUrls } : {}),
      // Which providers this host brokers (ADR-143): names and a basis,
      // never a secret. Read from the store each time, so a key `tacho
      // enroll` just took into custody is reported on the next poll.
      credentials: RUN_TOKEN_PROVIDERS.map((provider) => ({
        provider,
        basis: inCustody(provider)
          ? TACHO_CREDENTIAL_GATEWAY_BROKERED
          : TACHO_CREDENTIAL_HARNESS_HELD,
      })),
    };
  }

  // Bound once the contained runner exists below. Until then no session is
  // one the launcher started, which is the fail-closed answer.
  let launchedContained: (harnessSessionId: string) => boolean = () => false;
  function policy(): PolicyView {
    const current = host as HostFile;
    return {
      launchedContained: (id) => launchedContained(id),
      bundle: current.bundle,
      verified: bundleVerified,
      mandateConfirmedAt,
      hostStatus: hostStatusInForce(current, bundleVerified),
      denyGeneration: current.deny_generation,
      controlReachable:
        lastControlAt !== undefined &&
        now() - lastControlAt < 2 * timers.bundleRefreshMs,
    };
  }

  /**
   * Erase bodies on disk that a replacement mandate no longer covers.
   *
   * The trigger is a confirmed narrowing, and that is deliberately not the
   * condition that withholds a body from a shipment. The shipper asks
   * `retentionInForce`, which answers `NO_RETENTION` whenever the cached
   * bundle does not verify or has outlived its signed window, because on any
   * doubt the right move is to send nothing. Both of those states are often
   * transient: a bundle that fails verification now can verify on the next
   * poll, and a lapsed window is confirmed again by one `not_modified`. Doubt
   * is reason enough to withhold and is not reason to delete, so this reads
   * only the retention clause of a replacement bundle whose signature has
   * just verified, compares it with the clause that was in force, and runs
   * only for the classes that clause covered and this one does not.
   *
   * Erasing does not reverse. A workspace that narrows and then widens again
   * does not get these bodies back; see `Wal.purgeBodiesOutsideMandate`.
   */
  /**
   * A purge this host owes but has not completed.
   *
   * A marker file rather than a field on the host file: the host file is the
   * control plane's signed word about this machine, and this is local
   * bookkeeping about one unfinished write. It is a debt, not a fact about
   * the mandate.
   *
   * The file carries the clause to enforce, so a retry settles the erasure the
   * control plane ordered rather than whatever clause happens to be in force
   * when the retry runs. Two reasons. A later bundle can narrow one class and
   * widen another, and sweeping against that clause would leave the first
   * class's bytes on disk with nothing left that names them. And a host whose
   * cached bundle has outlived its signed window cannot prove any clause, so a
   * retry that needed a proven one would park the debt for the length of a
   * control-plane outage. The record is itself the proof: nothing writes it
   * but a bundle that verified.
   */
  const bodyPurgeOwedPath = join(paths.wal, "body-purge-owed");

  /**
   * Write down a narrowing this host owes the WAL.
   *
   * A debt already on disk is intersected with the new one rather than
   * replaced, because the host owes both erasures and `narrowestOf` is the one
   * clause that settles both.
   */
  function markBodyPurgeOwed(
    retention: RetentionMandate,
    dropped: readonly string[],
  ): boolean {
    try {
      ensureDir(paths.wal);
      const owed = owedBodyPurge();
      const clause =
        owed?.retention === undefined
          ? retention
          : narrowestOf(owed.retention, retention);
      writeFileSync(
        bodyPurgeOwedPath,
        JSON.stringify({ retention: clause, classes: dropped }),
        { mode: 0o600 },
      );
      return true;
    } catch (error) {
      // Answered rather than swallowed. This used to be best effort, on the
      // reasoning that failing to record the debt must not stop the sweep that
      // was about to run anyway — true while the sweep ran after the etag was
      // committed, and false now that it runs before. If this write and the
      // sweep both fail, which one filesystem fault does, the caller must be
      // able to refuse the commit; a silent `void` left the narrowing cached
      // with no debt and no erase, which is the permanent case.
      log(
        `failed to record an owed body purge (${dropped.join(", ")}): ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  /**
   * The debt on disk, if there is one, and the clause it names.
   *
   * `retention` is undefined for a marker an older build of this daemon wrote
   * empty, and for a file this one cannot parse. The retry then falls back to
   * the clause in force, which is what that build did.
   */
  function owedBodyPurge():
    | { retention: RetentionMandate | undefined; classes: readonly string[] }
    | undefined {
    if (!existsSync(bodyPurgeOwedPath)) return undefined;
    let raw: unknown;
    try {
      const text = readFileSync(bodyPurgeOwedPath, "utf8");
      raw = text.trim().length === 0 ? undefined : JSON.parse(text);
    } catch {
      raw = undefined;
    }
    const record = raw as
      | { retention?: { mode?: unknown; classes?: unknown }; classes?: unknown }
      | undefined;
    const mode = record?.retention?.mode;
    const classes = record?.retention?.classes;
    const named =
      (mode === "content_exact" || mode === "digest_only") &&
      Array.isArray(classes)
        ? ({ mode, classes: classes as readonly string[] } as RetentionMandate)
        : undefined;
    return {
      retention: named,
      classes: Array.isArray(record?.classes)
        ? (record.classes as readonly string[])
        : [],
    };
  }

  function clearBodyPurgeOwed(): void {
    try {
      if (existsSync(bodyPurgeOwedPath)) unlinkSync(bodyPurgeOwedPath);
    } catch {
      // Leaves the marker, so the sweep runs again. Re-sweeping costs a pass
      // over the body files and erases nothing the mandate still covers.
    }
  }

  /**
   * Retry an owed purge, on every confirmation that the cached mandate is
   * still current. That is the `not_modified` branch, which is where a
   * narrowing whose sweep failed comes back through for ever afterwards, and
   * which the first tick after a restart reaches on its own — so a debt
   * recorded before a crash is retried without a separate startup path. A
   * bundle that changes instead goes through `purgeBodiesNarrowedOut`, which
   * sweeps and clears the debt itself.
   *
   * The debt names the clause to sweep against, so this does not ask
   * `retentionInForce`. That is not a widening of the purge trigger: doubt
   * still withholds and does not delete, and nothing writes a debt but a
   * bundle whose signature verified. A debt from an older build names no
   * clause, and that one falls back to the clause in force and sweeps only
   * when it is proven.
   */
  function retryOwedBodyPurge(): void {
    const owed = owedBodyPurge();
    if (owed === undefined) return;
    let clause = owed.retention;
    if (clause === undefined) {
      const inForce = retentionInForce();
      if (!inForce.proven) return;
      clause = inForce.mandate;
    }
    try {
      const purged =
        wal.purgeBodiesOutsideMandate(clause) + purgePendingEndBodies(clause);
      purgeQueuedPrompts(clause);
      clearBodyPurgeOwed();
      log(
        `completed an owed body purge: erased ${purged} queued body(ies) the mandate does not cover`,
      );
    } catch (error) {
      log(
        `an owed body purge failed again; content remains in the WAL: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Withdraw the prompts queued for a boundary when `clause` does not retain
   * prompt content, and rewrite the files that hold them: `daemon.json`, and
   * the registry snapshots in `pending-session-ends.json`. Runs beside the
   * body sweeps with the same clause, so a narrowing erases a queued prompt
   * from disk the way it erases a prompt body.
   *
   * The prompts are withdrawn rather than kept in memory for delivery. The
   * next `persistState` would write a prompt kept in memory straight back to
   * disk, and one written only in memory is lost silently on a restart. Each
   * withdrawn prompt is acknowledged `failed` with the reason, so the
   * operator sees it was not delivered and can send it again.
   */
  function purgeQueuedPrompts(clause: RetentionMandate): number {
    if (retentionAllows(clause, QUEUED_PROMPT_CLASS)) return 0;
    const withdrawn = registry.withdrawQueuedPrompts(
      "withdrawn before delivery: the retention mandate no longer keeps prompt content",
    );
    for (const pending of pendingSessionEnds.values())
      for (const persisted of pending.terminal?.state.sessions ?? [])
        persisted.control.messages = [];
    // Both files are rewritten whether or not this call withdrew anything.
    // A write that threw on an earlier attempt left the prompts on disk and
    // already gone from memory, so the retry finds nothing to withdraw, and
    // it clears the debt once this returns.
    persistPendingEnds();
    persistState();
    if (withdrawn > 0)
      log(
        `mandate narrowed: withdrew ${withdrawn} queued prompt(s) from ${paths.daemonState}`,
      );
    return withdrawn;
  }

  function purgeBodiesNarrowedOut(
    previous: RetentionMandate,
    next: RetentionMandate,
  ): boolean {
    const dropped = HOST_RETENTION_CLASSES.filter(
      (contentClass) =>
        retentionAllows(previous, contentClass) &&
        !retentionAllows(next, contentClass),
    );
    if (dropped.length === 0) return true;
    // Owed before attempted, so the debt survives what the attempt might not.
    // The debt write must succeed, or the erase must.
    // This runs before `applyControlFacts` writes the new etag, and that order
    // is the point: once the etag is written every later poll answers
    // `not_modified` and nothing tells this host the clause narrowed, so a
    // process that exits in between would leave excluded content on disk with
    // nothing left to notice. The marker is cleared only by a sweep that
    // returned.
    const recorded = markBodyPurgeOwed(next, dropped);
    try {
      const purged =
        wal.purgeBodiesOutsideMandate(next) + purgePendingEndBodies(next);
      purgeQueuedPrompts(next);
      clearBodyPurgeOwed();
      log(
        `mandate narrowed (${dropped.join(", ")}): erased ${purged} queued body(ies) from the WAL`,
      );
      return true;
    } catch (error) {
      // Logged and not rethrown, on purpose. Throwing would abort the refresh
      // from inside, losing the distinction the return value carries: whether
      // the narrowing may be cached at all.
      log(
        `failed to erase bodies the narrowed mandate no longer covers (${dropped.join(", ")}); content remains in the WAL: ${error instanceof Error ? error.message : String(error)}`,
      );
      // The erase failed. If the debt was recorded, a later confirmation or
      // the next start settles it and the caller may cache the narrowing. If
      // it was not, nothing on this host remembers the clause narrowed, and
      // caching the etag would make that permanent and silent. Answering false
      // leaves the old etag in place, so the next poll fetches the bundle
      // again and arrives back here — one poll of continued shipping under the
      // clause the workspace withdrew, against content that can never be
      // erased. Bounded and self-healing beats permanent.
      return recorded;
    }
  }

  async function refreshBundle(): Promise<boolean> {
    try {
      // Past half its signed window the poll sends no etag, so an unchanged
      // mandate comes back freshly signed and the copy on disk stays fresh
      // across a restart and for the hook when this daemon is down. A cached
      // copy that did not verify sends none either: its etag would earn a
      // `not_modified`, and the edited file would stand until the mandate
      // next changed.
      const response = await client.bundle(
        bundleVerified ? pollEtag(host.bundle, now()) : undefined,
      );
      lastControlAt = now();
      // `not_modified` is the confirmation freshness is measured from: it
      // says the etag in force is still the current one, which is the only
      // thing an unchanged mandate ever gets to hear.
      //
      // Nothing else renews here. A changed bundle renews only once it has
      // verified, below. Renewing before that check would let a response
      // carrying an unverifiable bundle extend the mandate it was sent to
      // replace, and a control plane answering that way repeatedly would
      // extend it for as long as it kept answering. A `bundle: null`
      // response is not a confirmation either: it says the control plane is
      // serving no bundle, which is the opposite of agreeing with this one.
      if (response.not_modified) {
        mandateConfirmedAt = now();
        // The branch a narrowing whose sweep failed returns through for ever.
        retryOwedBodyPurge();
        return false;
      }
      if (response.bundle === null) return false;
      const verification = verifyBundle(
        response.bundle,
        host.bundle_public_key_pem,
        host.host_enrollment_id,
      );
      if (!verification.ok) {
        log(
          `refused a bundle that does not verify: ${verification.reason ?? "unknown"}`,
        );
        return false;
      }
      // A verified replacement is the control plane's own word on what may be
      // kept, which is the one thing that authorises erasing what is already
      // on disk.
      //
      // Ahead of the etag commit, and that order is the point. Once
      // `applyControlFacts` has written the new etag, every later poll answers
      // `not_modified` and nothing tells this host the clause narrowed, so a
      // process that exits in between would leave excluded content on disk
      // with nothing left to notice. Recording the debt and sweeping first
      // closes that window: either the bytes are gone, or the debt is on disk
      // for the next confirming poll and the next start.
      if (
        !purgeBodiesNarrowedOut(
          host.bundle.retention,
          response.bundle.retention,
        )
      ) {
        log(
          "refusing to cache a narrowed bundle this host can neither enforce on disk nor remember owing; the old etag stands so the next poll retries",
        );
        return false;
      }
      host = applyControlFacts(paths.hostFile, host, {
        bundle: response.bundle,
        bundle_fetched_at: toProtocolTimestamp(now()),
      });
      bundleVerified = true;
      // The replacement verified, so this response is a confirmation.
      mandateConfirmedAt = now();
      log(`bundle ${response.bundle.version} (${response.bundle.etag}) cached`);
      return true;
    } catch (error) {
      log(
        `bundle refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  async function onControl(control: ControlEnvelope): Promise<void> {
    lastControlAt = now();
    // Replaced on every envelope that carries one, and kept when one does
    // not: a poll that omits the figure (no daily ceiling, or the store did
    // not answer) says nothing new about the day. The proxy ignores a figure
    // for any day but today.
    if (control.agent_day_spend !== undefined)
      recordedDaySpend = control.agent_day_spend;
    host = applyControlFacts(paths.hostFile, host, {
      host_status: control.host_status,
      deny_generation: control.deny_generation,
    });
    // A cached bundle that did not verify is never confirmed by its etag: an
    // edited host.json keeps the etag it was signed with, so a match says
    // nothing about the rest of the file. It is fetched again instead.
    if (bundleVerified && control.bundle_etag === host.bundle.etag) {
      mandateConfirmedAt = now();
    } else await refreshBundle();
    if (control.commands.length > 0) {
      const result = await recordSealedAsync(
        () =>
          applyCommands(control.commands, {
            registry,
            hostRecorder: () => hostRecorder,
            kill,
            refreshBundle: async () => {
              await refreshBundle();
            },
            onHostSuspended: (reason) => {
              host = applyControlFacts(paths.hostFile, host, {
                host_status: "suspended",
              });
              log(`host suspended by operator: ${reason}`);
            },
            now,
          }),
        (result) => ({ events: result.events }),
      );
      try {
        // Written before the acknowledgements leave. A queued message or
        // steer seals no frame, so nothing else marked the state dirty, and a
        // crash before the next frame lost a prompt the operator had been
        // told was `received`.
        persistState();
        pendingAcks.push(...result.acknowledgements);
      } finally {
        // The commands took effect whether or not the write landed, and a
        // redelivered one is answered from the ledger rather than applied
        // again, so this is the only chance to cut its model calls. Only
        // the commands that took effect: an expired or refused kill must not
        // cut a session's model calls.
        interruptModelCalls(result.applied);
      }
    }
  }

  const shipper = new Shipper({
    wal,
    client,
    quarantineDir: paths.quarantine,
    // Re-enrolling leaves the WAL holding events stamped with the old id; the
    // control plane 403s a batch containing any of them, and a 403 is
    // retryable, so without this the queue wedges forever.
    hostEnrollmentId: host.host_enrollment_id,
    // A revoked host fetches no control envelope, so the revoked status
    // arrives only as the refusal. Recorded here, the hooks and the model
    // proxy refuse from it and `tacho status` shows it (#3944).
    //
    // Only for a revoke this machine did not start. `reassign`, `unenroll`
    // and a harness add revoke first and mark host.json `revoked_at` (or
    // write the next enrollment over it), then replace or remove this
    // daemon. Until they do, live sessions still call through it, and a
    // harness-only reassign keeps them (ADR-179), so the shipper stops and
    // the hooks and the model proxy carry on.
    onHostRevoked: () => {
      const disk = readHostFileLenient(paths.hostFile).host;
      if (
        disk === undefined ||
        disk.revoked_at !== null ||
        disk.host_enrollment_id !== host.host_enrollment_id
      ) {
        log(
          "enrollment revoked from this machine (host.json is marked or replaced): shipping stopped, and live sessions carry on until the service is replaced",
        );
        return;
      }
      host = applyControlFacts(paths.hostFile, host, {
        host_status: "revoked",
      });
    },
    // Hosts that lost the control plane together do not retry in step.
    jitter: Math.random,
    // Asked at ship time, not only at append time. A body appended under
    // `content_exact` can wait in the WAL through an outage and leave under a
    // mandate that has since narrowed to `digest_only`; the control plane
    // refuses it, but by then it has left the machine, which is the one thing
    // the retention boundary exists to prevent.
    retentionInForce,
    health,
    onControl: async (control) => {
      lastIngestAt = now();
      await onControl(control);
    },
    onChainBreak: (breaks) => {
      for (const brk of breaks) {
        log(
          `control plane reports chain break ${brk.session_uuid}#${brk.at_seq}: ${brk.reason}`,
        );
      }
    },
    // The event was accepted and the session carries a `body_missing` gap;
    // the log line is the only trace on this host of why the bytes are not
    // in the record.
    onBodyRejection: (rejections) => {
      for (const rejection of rejections) {
        log(
          `control plane refused body for ${rejection.event_id_idem}: ${rejection.reason}`,
        );
      }
    },
    log,
    now,
  });

  // The client can now deliver budget hints to the Shipper (see rateLimitSink
  // above): every counted response reports what is left of this host's window.
  rateLimitSink.notify = (hint) => shipper.noteRateLimit(hint);

  const detector = new Detector({
    registry,
    hostRecorder: () => hostRecorder,
    listProcesses: () => listClaudeProcesses(exec),
    transcriptRoots: options.transcriptRoots ?? [paths.claudeProjects],
    readSettings: () => readJsonFileIfExists(paths.claudeSettings) ?? {},
    // The harness list and the enrollment id it belongs to, read together
    // from disk on every tick so a live `reassign` can never pair a fresh
    // harness list with the stale enrollment id this daemon started with
    // (#3398). A Codex-, Stella- or Claude Desktop-only host has no Claude
    // Code hooks to lose; without the harness check every such start
    // chained a severity-3 `oxagen:hooks_removed` incident fifteen seconds
    // in (#3320).
    enrollment: () => currentEnrollment(paths.hostFile, host),
    log,
    now,
  });

  // --- transcript tailer -------------------------------------------------
  // The detector above only stats a transcript's mtime. The tailer reads it:
  // every session that reported a `transcript_path` has its file tailed on
  // the tick, and so has each subagent transcript in that session's
  // `subagents/` directory. A SubagentStop feeds what the tick has not read
  // yet and retires that subagent's cursor. See transcript-tailer.ts for why
  // this exists.
  const transcriptTailer = new TranscriptTailer({
    sessions: () => registry.list(),
    session: (id) => registry.get(id),
    record,
    statePath: paths.transcriptTailState,
    log,
  });

  /**
   * What the tailer does before a hook is sealed: a `Stop` or `SessionEnd`
   * drains the session's transcript and its subagents' so the turn's model
   * calls sit on the chain before the frame that closes it, and a
   * `SubagentStop` feeds the rest of the subagent's transcript to the child
   * chain before that chain is finalized.
   */
  async function tailBeforeHook(payload: unknown): Promise<void> {
    if (payload === null || typeof payload !== "object") return;
    const input = payload as Record<string, unknown>;
    const sessionId = input["session_id"];
    const hookName = input["hook_event_name"];
    if (typeof sessionId !== "string") return;
    try {
      if (hookName === "SubagentStop") {
        const agentId = input["agent_id"];
        const path = input["agent_transcript_path"];
        if (typeof agentId === "string" && typeof path === "string") {
          const fed = await transcriptTailer.ingestSubagentTranscript(
            sessionId,
            agentId,
            path,
          );
          if (fed === undefined)
            log(`subagent transcript ${path} was not there to read`);
        }
      }
      if (hookName === "Stop" || hookName === "SessionEnd")
        await transcriptTailer.drain(sessionId);
    } catch (error) {
      // The hook must still be answered; a transcript that cannot be read
      // is a gap in the record, not a reason to stall the agent.
      log(
        `transcript tail before ${String(hookName)} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  // --- end transcript tailer ---------------------------------------------

  async function sendAcks(): Promise<void> {
    // A revoked host's poll is refused on every attempt and never clears,
    // so it stops once the shipper or a poll has heard the revocation.
    if (shipper.hostRevoked) return;
    // A message whose session sealed before a boundary reached it is
    // `expired`; left unsent, the operator reads it as still on its way.
    pendingAcks.push(...registry.takeExpiredOnSeal());
    const lastEnvelopeAt = Math.max(
      lastIngestAt ?? -Infinity,
      lastCommandPollAt ?? -Infinity,
    );
    if (
      pendingAcks.length === 0 &&
      now() - lastEnvelopeAt < timers.commandsPollMs
    ) {
      return;
    }
    // Backoff gate. Pending acknowledgements do NOT bypass it: an ack is
    // delivered to a control plane that is answering, and hammering one that
    // is not delivers nothing while making the outage worse. The acks are
    // pushed back onto the queue below and ride the next attempt.
    if (now() < commandPollNextAttemptAt) return;
    const acks = pendingAcks.splice(0, 100);
    try {
      const { spool_oldest_at: _o, bundle_etag: _e, ...daemon } = health();
      const response = await client.commands(acks, daemon);
      lastCommandPollAt = now();
      await onControl(response.control);
      if (commandPollFailures > 0) {
        log(`command poll recovered after ${commandPollFailures} failures`);
      }
      commandPollFailures = 0;
      commandPollBackoffMs = COMMAND_POLL_MIN_BACKOFF_MS;
      commandPollNextAttemptAt = 0;
      commandPollProtocolMismatchLogged = false;
    } catch (error) {
      pendingAcks.unshift(...acks);
      commandPollFailures += 1;
      if (error instanceof ControlError && isHostRevokedRefusal(error)) {
        // An idle host learns here rather than at its next ingest. The
        // shipper stops with it, and neither asks again.
        shipper.markHostRevoked();
        return;
      }
      if (
        error instanceof ControlError &&
        (error.status === 400 || error.status === 422)
      ) {
        commandPollBackoffMs = COMMAND_POLL_PROTOCOL_MISMATCH_BACKOFF_MS;
        commandPollNextAttemptAt =
          now() + COMMAND_POLL_PROTOCOL_MISMATCH_BACKOFF_MS;
        // Once, not every 15 minutes: the line is the same until someone
        // upgrades, and repeating it is the log growth this guards against.
        // The health report the host row shows cannot carry it yet, so the
        // log is where the fact lives.
        if (!commandPollProtocolMismatchLogged) {
          commandPollProtocolMismatchLogged = true;
          log(
            `command poll refused with ${error.status}: this tachod (${host.wrapper_version}) and the control plane disagree on the wire, so the poll waits 15 minutes between attempts until tachod is upgraded; the server said: ${error.body.slice(0, 256)}`,
          );
        }
        return;
      }
      // A 429 names its own wait, and the Shipper already obeys it on ingest.
      // The poll used to guess 2, 4, 8, 16 s instead, spending four more
      // requests from a bucket the server had just said was empty.
      const serverWaitMs =
        error instanceof ControlError
          ? serverRequestedWaitMs(error)
          : undefined;
      const retryInMs = serverWaitMs ?? commandPollBackoffMs;
      commandPollNextAttemptAt = now() + retryInMs;
      if (serverWaitMs === undefined) {
        commandPollBackoffMs = Math.min(
          commandPollBackoffMs * 2,
          COMMAND_POLL_MAX_BACKOFF_MS,
        );
      }
      // The failure count and the wait are on the line because a reader
      // watching this log needs to tell one failure from the eight hundredth,
      // and needs to know the daemon is holding off rather than wedged.
      log(
        `command poll failed (${commandPollFailures} in a row, retrying in ${Math.round(retryInMs / 1000)}s): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  function checkpoint(): void {
    const events: TachoEvent[] = [];
    // One write covers every session's checkpoint, so a write that throws
    // leaves none of them on disk. Each chain then goes back to where its
    // seal found it, rather than standing a sequence number ahead of the WAL
    // with a checkpoint frame nothing holds.
    const marks: Array<{
      session: SessionRecord;
      mark: ChainMark;
      lastCheckpointSeq: number;
    }> = [];
    for (const session of registry.list()) {
      const head = session.recorder.chainCursor;
      const headSeq = head.seq - 1;
      if (
        headSeq <= session.lastCheckpointSeq ||
        session.sealed ||
        session.pendingTerminal
      )
        continue;
      const message = `${session.recorder.sessionUuid}:${headSeq}:${head.prevHash}`;
      const mark = session.recorder.markChain();
      const event = session.recorder.sealCollectorEvent("checkpoint", {
        checkpoint_id: ulid(now()),
        checkpoint_event_count: headSeq + 1,
        checkpoint_chain_head: head.prevHash,
        checkpoint_device_signature: deviceKey.sign(message),
        checkpoint_device_key_fingerprint: deviceKey.fingerprint,
      });
      marks.push({
        session,
        mark,
        lastCheckpointSeq: session.lastCheckpointSeq,
      });
      session.lastCheckpointSeq = event.seq;
      events.push(event);
    }
    try {
      record(events);
    } catch (error) {
      for (const entry of marks.reverse()) {
        entry.session.recorder.rollbackChain(entry.mark);
        entry.session.lastCheckpointSeq = entry.lastCheckpointSeq;
      }
      throw error;
    }
  }

  const spoolEnvelope = (file: SpoolFile): HookEnvelope => ({
    payload: file.payload,
    ...(file.env !== undefined ? { env: file.env } : {}),
    ...(file.harness !== undefined ? { harness: file.harness } : {}),
    ...(file.agent !== undefined ? { agent: file.agent } : {}),
    ...(file.hook_id !== undefined ? { hook_id: file.hook_id } : {}),
    replay: {
      receivedAt: file.received_at,
      ...(file.evaluation !== undefined ? { evaluation: file.evaluation } : {}),
    },
  });

  // The path `paths.ts` declares, so `unenroll --purge` and this daemon name
  // one file: it can hold a run's content and is purged with the WAL.
  const pendingEndsPath = paths.pendingEnds;
  const terminalSchema = z.object({
    events: z.array(tachoEventSchema),
    state: z.custom<RegistryState>(
      (value) => parseRegistryState(value) !== undefined,
    ),
    bodies: z.array(
      z.object({
        event_id_idem: z.string(),
        session_uuid: z.string().uuid(),
        seq: z.number().int(),
        content_type: z.string(),
        content_class: z.enum(["model_call", "tool_call", "approval_receipt"]),
        bytes_base64: z.string(),
      }),
    ),
  });
  type PendingSessionEnd = HookEnvelope & {
    terminal?: z.infer<typeof terminalSchema>;
  };
  const pendingSessionEnds = new Map<string, PendingSessionEnd>();
  const pendingEndSchema = z.tuple([
    z.string().uuid(),
    z.object({
      payload: hookInputSchema.refine(
        (input) => input.hook_event_name === "SessionEnd",
      ),
      env: z.record(z.string(), z.string().optional()).optional(),
      harness: tachoHarnessSchema.optional(),
      agent: z.string().optional(),
      replay: z
        .object({
          receivedAt: z.string().datetime(),
          deferred: z.boolean().optional(),
        })
        .optional(),
      terminal: terminalSchema.optional(),
    }),
  ]);
  try {
    const saved = readJsonFileIfExists(pendingEndsPath);
    if (saved !== undefined && !Array.isArray(saved))
      throw new Error("expected a list of pending session ends");
    for (const value of (saved as unknown[] | undefined) ?? []) {
      const entry = pendingEndSchema.safeParse(value);
      if (!entry.success) {
        log("pending session end skipped: invalid saved envelope");
        continue;
      }
      const [uuid, envelope] = entry.data;
      const session = registry.byUuid(uuid);
      if (
        session === undefined ||
        sessionMapKey(session.harnessSessionId, session) !==
          sessionMapKey(hookInputSchema.parse(envelope.payload).session_id, {
            harness: envelope.harness,
            customAgent: envelope.agent,
          })
      ) {
        log(
          "pending session end skipped: saved session identity does not match",
        );
        continue;
      }
      pendingSessionEnds.set(uuid, envelope);
      // A restart must reopen the same window `recordHookOutcome` guards
      // in-process: this session has a terminal computed (or about to be
      // recomputed) that has not reached the WAL, so it must keep refusing
      // new frames until the retry lands, not just once the retry runs.
      session.pendingTerminal = true;
    }
  } catch (error) {
    log(
      `pending session ends unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const persistPendingEnds = () =>
    writeSensitiveFileAtomic(
      pendingEndsPath,
      JSON.stringify([...pendingSessionEnds]),
    );
  const gitReads = createGitLane({
    registry,
    execAsync,
    now,
    serial,
    pendingSessionEnds,
    settleEnding: async (ending, sessionUuid) => {
      await recordHookOutcome(ending, sessionUuid);
      persistState();
      pendingSessionEnds.delete(sessionUuid);
      persistPendingEnds();
    },
    record,
  });
  const requestGitRead = gitReads.requestGitRead;
  for (const id of pendingSessionEnds.keys())
    requestGitRead(id, { force: true, reconcile: true });

  /**
   * Drop the pending terminal bodies a retention clause no longer covers,
   * and rewrite the file. Runs beside `Wal.purgeBodiesOutsideMandate` with
   * the same clause, so a narrowing erases the same classes from both
   * places a body can wait.
   */
  function purgePendingEndBodies(clause: RetentionMandate): number {
    let purged = 0;
    for (const pending of pendingSessionEnds.values()) {
      if (pending.terminal === undefined) continue;
      const kept = pending.terminal.bodies.filter((body) =>
        retentionAllows(clause, body.content_class),
      );
      purged += pending.terminal.bodies.length - kept.length;
      pending.terminal.bodies = kept;
    }
    if (purged > 0) persistPendingEnds();
    return purged;
  }

  /** The hook events that open or close a turn, where the worktree may have moved. */
  const TURN_BOUNDARY_HOOKS = new Set([
    "SessionStart",
    "UserPromptSubmit",
    "Stop",
    "SubagentStop",
    "SessionEnd",
  ]);

  /**
   * The hook events after which the worktree has settled enough to read it.
   *
   * `Stop` is the end of a turn: the agent has finished acting and is
   * handing back, so what the tree holds now is what the turn left behind.
   * SessionEnd also requests a final read before the chain closes.
   *
   * `SubagentStop` does not trigger a duplicate read. SessionEnd asks for a
   * final read and waits off the hook queue before its seal is recorded.
   * A failed read seals without inventing a clean worktree observation.
   *
   * There is no per-tool-call trigger on purpose: `readWorkingTreeChanges`
   * spawns several git processes, one of them per untracked file, and paying
   * that on every `Edit` would cost more than the fact is worth.
   */
  const RECONCILE_HOOKS = new Set(["Stop", "SessionEnd"]);

  async function handleHookInner(
    envelope: HookEnvelope,
  ): Promise<Record<string, unknown>> {
    // The hook asks for the read and does not wait for it: the spawns happen
    // in the tick, off this queue. The facts therefore land on the frames
    // after this one rather than on this one, which is what the recorder's
    // context already is, a standing fact carried until something newer
    // replaces it.
    const payloadFacts = hookInputSchema.parse(envelope.payload);
    const hookName = payloadFacts.hook_event_name;
    const key = sessionMapKey(payloadFacts.session_id, {
      harness: envelope.harness,
      customAgent: envelope.agent,
    });
    const findSession = () =>
      registry
        .list()
        .find(
          (session) => sessionMapKey(session.harnessSessionId, session) === key,
        );
    await tailBeforeHook(envelope.payload);
    const endingSession = findSession();
    // The payload's own working directory is applied before the branch below
    // decides, not after it. A session first seen from OTel, from a transcript,
    // or from a start hook that carried no `cwd` has none to test, and its
    // SessionEnd is the first hook to say where it worked. Reading the stale
    // value sealed that session on the spot, so the final worktree read never
    // ran and the chain closed with no reconciliation on it (#3676).
    //
    // An inferred Cursor `cwd` is not a report of where the session worked, so
    // it is not applied and does not make a session eligible for a final read.
    if (
      hookName === "SessionEnd" &&
      endingSession !== undefined &&
      !endingSession.sealed &&
      !endingSession.pendingTerminal &&
      payloadFacts.cwd !== undefined &&
      !(
        envelope.harness === "cursor" &&
        (envelope.payload as Record<string, unknown>)["cursor_cwd_inferred"] ===
          true
      )
    )
      registry.ensure(payloadFacts.session_id, {
        harness: envelope.harness,
        customAgent: envelope.agent,
        cwd: payloadFacts.cwd,
      });
    if (
      hookName === "SessionEnd" &&
      endingSession?.cwd !== undefined &&
      !endingSession.sealed &&
      !endingSession.pendingTerminal
    ) {
      const uuid = endingSession.recorder.sessionUuid;
      // Stamped now, not when the git read lands: the frame's `ts` is when
      // the session ended, however long the drain waits.
      pendingSessionEnds.set(uuid, {
        ...envelope,
        replay: envelope.replay ?? {
          receivedAt: toProtocolTimestamp(now()),
          deferred: true,
        },
      });
      requestGitRead(uuid, { force: true, reconcile: true });
      persistState();
      persistPendingEnds();
      return {};
    }
    const response = await recordHookOutcome(envelope);
    const session = findSession();
    if (session !== undefined)
      requestGitRead(session.recorder.sessionUuid, {
        force: TURN_BOUNDARY_HOOKS.has(hookName),
        reconcile: RECONCILE_HOOKS.has(hookName),
      });
    return response;
  }

  async function recordHookOutcome(
    envelope: HookEnvelope,
    pendingUuid?: string,
  ): Promise<Record<string, unknown>> {
    const pending =
      pendingUuid === undefined
        ? undefined
        : pendingSessionEnds.get(pendingUuid);
    if (pendingUuid !== undefined && pending?.terminal !== undefined) {
      try {
        flushPendingTerminal(pending.terminal);
        return {};
      } catch (error) {
        if (!(error instanceof WalRecoveryConflict)) throw error;
        // Sealed on a chain the WAL does not hold, so no retry can land it.
        // It is set aside once, and the end is sealed again below from the
        // hook this envelope still carries.
        setAsideConflictingTerminal(pendingUuid, pending, error);
      }
    }
    const before = pending === undefined ? undefined : registry.state();
    // Marked before the seal, not only before the write below: a session
    // whose SessionEnd is pending takes a different path to the WAL
    // (`flushPendingTerminal`, journaled and rolled back through its own
    // `registry.restore`), but `handleHookEvent` itself can throw after
    // sealing on one chain and before finishing another, and that failure
    // has no rollback of its own.
    const marks = markEveryChain();
    // A hook takes a queued message off its session's queue and acknowledges
    // it `applied` as it seals the delivery. Both wait here until the
    // delivery frame is durable: a failed write puts the message back on its
    // queue for the next boundary and sends no acknowledgement, where it used
    // to report a steer applied at a seq the WAL never held (#3944).
    const queues = markEveryQueue();
    const acks: CommandAcknowledgement[] = [];
    let outcome: Awaited<ReturnType<typeof handleHookEvent>>;
    try {
      outcome = await handleHookEvent(
        envelope.payload,
        envelope.env ?? {},
        {
          registry,
          policy,
          refreshBundle: async () => {
            await refreshBundle();
          },
          acknowledge: (ack) => {
            acks.push(ack);
          },
          now,
          pushCredentialBasis: (command, cwd) =>
            pushCredentialBasis(command, cwd, {
              receipts: () =>
                readHostFile(paths.hostFile)?.github_repositories ?? [],
              execAsync,
            }),
        },
        envelope.replay,
        envelope.harness,
        envelope.agent,
        envelope.hook_id,
      );
    } catch (error) {
      rollbackEveryChain(marks);
      restoreEveryQueue(queues);
      throw error;
    }
    if (pending !== undefined) {
      const state = registry.state();
      state.sessions = state.sessions.filter(
        (session) =>
          sessionMapKey(session.harnessSessionId, session) ===
          sessionMapKey(hookInputSchema.parse(envelope.payload).session_id, {
            harness: envelope.harness,
            customAgent: envelope.agent,
          }),
      );
      state.agents = [];
      // The host's tombstones are not this session's: carried here, every
      // pending terminal held the whole list, and a restore put back ones
      // spent since.
      state.tombstones = [];
      const retention = retentionInForce();
      pending.terminal = {
        events: outcome.events,
        state,
        bodies: outcome.bodies
          .filter((body) =>
            retentionAllows(retention.mandate, body.content_class),
          )
          .map(({ bytes, ...body }) => ({
            ...body,
            bytes_base64: Buffer.from(bytes).toString("base64"),
          })),
      };
      try {
        persistPendingEnds();
      } catch (error) {
        delete pending.terminal;
        if (before !== undefined) registry.restore(before);
        // The restore puts the queues back, but the `expired` acks the seal
        // queued live outside the state it restores.
        withdrawExpiredAcks(queues);
        throw error;
      }
      // The journal now holds the delivery frames, and a failed flush below
      // is retried from it, so the acknowledgements stand from here.
      pendingAcks.push(...acks);
      // A sealed registry flag means its terminal event is durable. The
      // journal preserves the exact event bytes and recorder cursor until
      // then, so `sealed` reports `false` for this window. That must not
      // reopen the record to new writers: `pendingTerminal` keeps it closed
      // to `checkpoint`, the model proxy, and a re-entrant SessionEnd while
      // `sealed` alone would let a concurrent write land a sequence after
      // the terminal's and fork the chain the retry then rebuilds against.
      if (outcome.record !== undefined) {
        outcome.record.sealed = false;
        outcome.record.pendingTerminal = true;
      }
      flushPendingTerminal(pending.terminal);
    } else {
      try {
        record(outcome.events, outcome.bodies);
      } catch (error) {
        rollbackEveryChain(marks);
        restoreEveryQueue(queues);
        // The chain rollback does not reach the hook-id ledger, which lives
        // on the session record. Left in place, the key would make the
        // client's spool replay of this same hook look like a repeat, and
        // the hook would be lost.
        if (outcome.hookKey !== undefined && outcome.record !== undefined) {
          forgetHookId(outcome.record, outcome.hookKey);
        }
        throw error;
      }
      pendingAcks.push(...acks);
      if (outcome.hookKey !== undefined && outcome.record !== undefined) {
        journalHookKey(outcome.record, outcome.hookKey, outcome.events);
      }
    }
    return outcome.response;
  }

  /**
   * Journal a ledger key whose hook just reached the WAL, so a crash before
   * the next state write does not forget it (see `hook-id-journal.ts`). A
   * failed append is logged, not thrown: the hook is recorded, and failing
   * it would send the client a failure it answers by spooling the same hook.
   */
  function journalHookKey(
    session: SessionRecord,
    key: string,
    events: readonly TachoEvent[],
  ): void {
    const at = session.hookIds.get(key);
    if (at === undefined) return;
    try {
      appendHookIdJournal(
        paths.hookIdJournal,
        hookIdJournalEntry(session.recorder.sessionUuid, key, at, events),
      );
    } catch (error) {
      log(
        `hook-id journal append failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Move a journaled terminal the WAL refuses as a conflict out of the retry
   * path, and put the session's chains back on the WAL.
   *
   * The conflict is permanent: the WAL already holds that seq with another
   * hash, so every retry fails the same way. The git lane used to requeue it
   * on every tick, and one host logged the same conflict over a thousand
   * times while the session's end never landed (#4093). The events go to
   * `quarantine/` as evidence, where `tacho status` counts them and the
   * retention sweep ages them out. Their bodies do not go with them: content
   * whose event can never reach the chain would outlive every sweep that
   * enforces the retention mandate.
   *
   * The hook's ledger key is forgotten for the same reason
   * `recordHookOutcome` forgets it after a failed write. The route that
   * computed this terminal remembered it, and the end sealed again from this
   * envelope would otherwise be dropped as a repeat.
   */
  function setAsideConflictingTerminal(
    uuid: string,
    pending: PendingSessionEnd,
    conflict: WalRecoveryConflict,
  ): void {
    const name = `${uuid}-terminal-conflict-${String(conflict.seq).padStart(8, "0")}.json`;
    writeSensitiveFileAtomic(
      join(paths.quarantine, name),
      JSON.stringify(
        {
          reason: conflict.message,
          events: pending.terminal?.events ?? [],
          bodies_dropped: pending.terminal?.bodies.length ?? 0,
        },
        null,
        2,
      ),
    );
    delete pending.terminal;
    persistPendingEnds();
    const session = registry.byUuid(uuid);
    if (session !== undefined) {
      session.recorder.continueFromDisk();
      const key = hookLedgerKey(
        pending.payload,
        session.harness,
        pending.hook_id,
      );
      if (key !== undefined) forgetHookId(session, key);
    }
    log(
      `session end for ${uuid} conflicts with the WAL at ${conflict.sessionUuid}:${conflict.seq}; its sealed terminal is in quarantine/${name}, and the end is sealed again on the chain the WAL holds`,
    );
  }

  function flushPendingTerminal(
    terminal: z.infer<typeof terminalSchema>,
  ): void {
    const retention = retentionInForce();
    const bodies = terminal.bodies
      .filter((body) => retentionAllows(retention.mandate, body.content_class))
      .map(({ bytes_base64, ...body }) => ({
        ...body,
        bytes: Buffer.from(bytes_base64, "base64"),
      }));
    wal.appendRecovered(terminal.events, bodies);
    const saved = terminal.state.sessions[0];
    const current =
      saved === undefined
        ? undefined
        : registry
            .list()
            .find(
              (session) =>
                sessionMapKey(session.harnessSessionId, session) ===
                sessionMapKey(saved.harnessSessionId, saved),
            );
    if (
      current !== undefined &&
      saved !== undefined &&
      current.recorder.chainCursor.seq === saved.recorder.cursor.seq &&
      current.recorder.chainCursor.prevHash === saved.recorder.cursor.prevHash
    ) {
      current.sealed = true;
      current.pendingTerminal = false;
    }
    // A mismatch means something else moved this chain while the terminal
    // waited (or a restart rebuilt it from a state.json older than this
    // envelope); `restore` rebuilds fresh `SessionRecord`s from `terminal.state`
    // alone, which carries no `pendingTerminal`, so the restored record comes
    // back closed (`sealed: true`, `pendingTerminal` unset) with nothing left
    // to clear.
    else registry.restore(terminal.state);
    stateDirty = true;
  }

  /**
   * At most this many spool files in one `drainSpool` call. A host whose
   * daemon was down for a long stretch, or whose control plane is refusing
   * every batch, can accumulate an unbounded backlog; unbounded is also what
   * a stuck loop over `readdirSync`'s answer would cost per tick. The rest
   * waits for the next call, which the daemon makes every tick.
   */
  const SPOOL_DRAIN_LIMIT = 200;

  /**
   * The longest gap between two tick drains that still reads as one
   * unbroken clock. The tick runs every second, so a longer gap is a sleep,
   * a stall, or a clock change (see `watchLedgerClock`).
   */
  const LEDGER_CLOCK_BREAK_MS = 60_000;

  /**
   * Whether a spool file will never process, on this attempt or any later
   * one: malformed JSON, the wrong schema envelope, or a payload the hook
   * schema refuses. Anything else (a WAL write that failed, a disk that is
   * full, a control-plane call a handler made mid-hook) is transient, and the
   * caller stops the drain rather than discarding the evidence.
   */
  function isPermanentSpoolRefusal(error: unknown): boolean {
    return (
      error instanceof SyntaxError ||
      error instanceof z.ZodError ||
      (error instanceof Error && error.message === "not a spool file")
    );
  }

  function moveToFailedSpool(path: string, name: string, reason: string): void {
    log(`spool file ${name} moved to spool/failed/: ${reason}`);
    try {
      ensureDir(join(paths.spool, "failed"));
      renameSync(path, join(paths.spool, "failed", name));
    } catch (error) {
      log(
        `spool file ${name} could not be moved to spool/failed/: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * When this process began answering hooks (infinity until it does), and
   * the sessions it has already chained a `daemon_down` gap on for the
   * outage that ended then.
   *
   * A hook is spooled whenever its client gets no good answer: the daemon was
   * down, or it answered with an error or past the hook's time budget. Only
   * the first is an outage. Every drain used to seal a gap for every session
   * it replayed. A hook the daemon refused while it was up sealed a
   * `daemon_down` gap each time it was replayed, and #4051 has the daemon
   * refuse a hook whose write failed so the replay can land it. One host
   * chained about 70 in twenty minutes with the daemon running throughout
   * (#4094). The startup gap below and `drainSpool` both add here, so one
   * outage gives a session one gap.
   */
  let servingSince = Number.POSITIVE_INFINITY;
  const outageGapped = new Set<string>();

  /**
   * What the last drain left in the spool: each file it read and left in
   * place, by name, with the harness session id it names, and whether it
   * left files it has not read.
   *
   * The sweep runs right after the drain, and the drain stops at a transient
   * failure and replays at most `SPOOL_DRAIN_LIMIT` files a call. The sweep
   * used to seal a session whose hooks were still in the spool. The replay
   * then put the session's last turns after its `agent_stop`, and the
   * outcome was judged without them (#4111). The sweep now defers a session
   * the spool still names, and every session while the spool holds files the
   * drain has not read. A spool file never changes once written, so a name
   * kept here is not read again for its session id.
   */
  let spoolLeft = new Map<string, string | undefined>();
  let spoolHeld = new Set<string>();
  let spoolUnread = false;

  /** Whether the spool may still hold a hook for this session. */
  function spoolHolds(session: SessionRecord): boolean {
    return spoolUnread || spoolHeld.has(session.harnessSessionId);
  }

  /** Replay what `tacho-hook` spooled while the daemon was down, in order. */
  async function drainSpool(listedAt?: number): Promise<number> {
    if (listedAt !== undefined) watchLedgerClock(listedAt);
    const listed = readdirSync(paths.spool)
      .filter((name) => name.endsWith(".json"))
      .sort();
    if (listed.length === 0) {
      spoolLeft = new Map();
      spoolHeld = new Set();
      spoolUnread = false;
      if (listedAt !== undefined) pruneHookLedgers(listedAt);
      return 0;
    }
    const gapped = new Map<string, string>();
    // Unlinked only once every file this call touches is durably recorded
    // (or durably set aside): unlinking as each file lands, as this used to,
    // deleted a spool file even when its replay threw, so a hook a daemon
    // outage had already spooled was lost a second time by the drain meant
    // to recover it.
    const succeeded: string[] = [];
    const left = new Map<string, string | undefined>();
    let unread = false;
    let reads = 0;
    let processed = 0;
    let interrupted = false;
    for (const [index, name] of listed.entries()) {
      // A file past the replay limit, or after a transient failure, waits
      // for a later drain. It is read here only for the session it names,
      // once, and within the same budget of reads the replay has.
      const replaying = !interrupted && index < SPOOL_DRAIN_LIMIT;
      if (!replaying && spoolLeft.has(name)) {
        left.set(name, spoolLeft.get(name));
        continue;
      }
      if (reads === SPOOL_DRAIN_LIMIT) {
        unread = true;
        continue;
      }
      reads += 1;
      const path = join(paths.spool, name);
      let file: SpoolFile;
      try {
        file = JSON.parse(readFileSync(path, "utf8")) as SpoolFile;
        if (file.schema !== "tacho.spool.v1")
          throw new Error("not a spool file");
      } catch (error) {
        // It names no session. The drain sets it aside when it reaches it.
        if (!replaying) {
          left.set(name, undefined);
          continue;
        }
        moveToFailedSpool(
          path,
          name,
          error instanceof Error ? error.message : String(error),
        );
        processed += 1;
        continue;
      }
      const sessionId = (file.payload as { session_id?: string }).session_id;
      if (!replaying) {
        left.set(name, sessionId);
        continue;
      }
      // A hook spooled since this process began serving was refused or
      // answered late, not missed: its replay here recovers it, and nothing
      // else the daemon receives directly was lost.
      const spooledWhileDown = !(Date.parse(file.received_at) >= servingSince);
      if (sessionId !== undefined && spooledWhileDown && !gapped.has(sessionId))
        gapped.set(sessionId, file.received_at);
      try {
        await handleHookInner(spoolEnvelope(file));
        succeeded.push(path);
        processed += 1;
      } catch (error) {
        if (isPermanentSpoolRefusal(error)) {
          moveToFailedSpool(
            path,
            name,
            error instanceof Error ? error.message : String(error),
          );
          processed += 1;
          continue;
        }
        // A transient failure: stop replaying here and leave every file this
        // call has not yet attempted, including this one, for the next drain.
        log(
          `spool drain stopped at ${name}: ${error instanceof Error ? error.message : String(error)}`,
        );
        interrupted = true;
        left.set(name, sessionId);
      }
    }
    // A file moved to spool/failed/ is not in `left`, so it holds nothing.
    spoolLeft = left;
    spoolHeld = new Set(
      [...left.values()].filter((id): id is string => typeof id === "string"),
    );
    spoolUnread = unread;
    // The http hooks of the same window were lost: chain the gap honestly,
    // for every session this pass actually reached.
    const gapMarks: Array<{ session: SessionRecord; mark: ChainMark }> = [];
    const gaps: TachoEvent[] = [];
    for (const [sessionId, firstAt] of gapped) {
      const session = registry.get(sessionId);
      if (session === undefined || session.sealed) continue;
      if (outageGapped.has(session.recorder.sessionUuid)) continue;
      const mark = session.recorder.markChain();
      gapMarks.push({ session, mark });
      gaps.push(
        session.recorder.sealCollectorEvent("telemetry_gap", {
          gap_cause: "daemon_down",
          gap_duration_ms: Math.max(0, now() - Date.parse(firstAt)),
          incident_kind: "telemetry_gap",
          incident_severity: 1,
        }),
      );
    }
    try {
      record(gaps);
    } catch (error) {
      rollbackEveryChain(gapMarks);
      throw error;
    }
    for (const { session } of gapMarks)
      outageGapped.add(session.recorder.sessionUuid);
    // Commit the WAL before removing the on-disk evidence it is the only
    // other copy of. A spool file is the sole record of a hook payload until
    // its events are durable; unlinking it before a flush trades a crash
    // that used to lose nothing for one that loses the payload outright.
    wal.flush();
    for (const path of succeeded) unlinkSync(path);
    if (
      listedAt !== undefined &&
      !interrupted &&
      listed.length <= SPOOL_DRAIN_LIMIT
    ) {
      pruneHookLedgers(listedAt);
    }
    return processed;
  }

  // When the tick's drain last listed the spool, and the time before which
  // no ledger key may be pruned. See `watchLedgerClock`.
  let ledgerClockAt: number | undefined;
  let ledgerPruneHeldUntil = Number.NEGATIVE_INFINITY;

  /**
   * Hold ledger pruning for a full replay window after any break in the
   * tick's clock: the first tick after a start, a gap over a minute between
   * two ticks, or a clock that ran backwards. A laptop that slept with a
   * hook in flight wakes with its wall clock hours ahead while the client's
   * own timer has barely moved, so that client can still spool its hook up
   * to a full window after the wake, whatever the wall clock says.
   */
  function watchLedgerClock(listedAt: number): void {
    const gap =
      ledgerClockAt === undefined
        ? Number.POSITIVE_INFINITY
        : listedAt - ledgerClockAt;
    ledgerClockAt = listedAt;
    if (gap < 0 || gap > LEDGER_CLOCK_BREAK_MS) {
      ledgerPruneHeldUntil = listedAt + HOOK_ID_REPLAY_WINDOW_MS;
    }
  }

  /**
   * Drop every ledger key recorded more than `HOOK_ID_REPLAY_WINDOW_MS`
   * before a spool listing that the drain then cleared. Any replay of an
   * older key was already a file when the spool was listed, so this drain
   * handled it, and no client can still write one.
   */
  function pruneHookLedgers(listedAt: number): void {
    if (listedAt < ledgerPruneHeldUntil) return;
    let removed = 0;
    for (const session of registry.list()) {
      removed += pruneHookIds(session, listedAt - HOOK_ID_REPLAY_WINDOW_MS);
    }
    if (removed > 0) stateDirty = true;
  }

  /**
   * The local MCP gateway (ADR-078). Connected apps have no hook surface, so
   * the only thing Oxagen governs for them is the toolbelt it serves, and the
   * gateway is how it serves one without the app ever holding a credential.
   *
   * Calls land on the daemon's own chain, not a session chain: a connected
   * app has no agent session — no prompt, no model, no turn — and inventing
   * one would put a step in the ledger that nobody took.
   *
   * The exception is a hooked session that uses the gateway as one of its
   * MCP servers. Claude Code names each call's `tool_use_id` in the request,
   * and when a live session's `PreToolUse` requested that call, the gateway's
   * frame lands on that session's chain as the call's one `tool_call`, so the
   * `PostToolUse` for it seals nothing (ADR-189).
   */
  const connected = new Map<
    string,
    { calls: number; refused: number; lastSeenAt: string }
  >();

  /**
   * The hash of this daemon chain's first sealed event, which the gateway
   * states on every forwarded call (#3221).
   *
   * Computed on first use and kept, rather than assigned at a distance from
   * the genesis seal below. By the time any gateway call arrives the genesis
   * exists — it is sealed before the server listens — and a chain's genesis
   * does not change, so one read answers for the process.
   *
   * From the WAL rather than from the seal: a RESUMED daemon does not seal a
   * genesis at all, and its chain's first event is already on disk. Reading it
   * per call would put disk I/O on the forward path, which is the one path
   * that was deliberately taken off the daemon's queue.
   */
  let genesisHashCache: string | undefined;
  function hostGenesisHash(): string | undefined {
    genesisHashCache ??= wal.read(hostRecorder.sessionUuid)[0]?.hash;
    return genesisHashCache;
  }

  function recordGatewayCall(call: GatewayCallRecord): void {
    const seen = connected.get(call.client) ?? {
      calls: 0,
      refused: 0,
      lastSeenAt: toProtocolTimestamp(now()),
    };
    seen.calls += 1;
    if (call.status === "rejected") seen.refused += 1;
    seen.lastSeenAt = toProtocolTimestamp(now());
    connected.set(call.client, seen);
    const toolUseId = call.toolUseId;
    if (toolUseId !== undefined && sessionAwaiting(toolUseId) !== undefined) {
      // A session chain is written on the serial queue, where that session's
      // hooks are handled too. Sealed off it, this frame could land while a
      // queued hook stands between its chain mark and its write, and that
      // hook's rollback after a failed write would take the chain back behind
      // a frame the WAL already holds. The client's answer does not wait for
      // the queue. The frame still lands before the call's PostToolUse,
      // because the queue runs in order and the harness sends that hook only
      // once it has the answer. A failed write is logged, and the rollback
      // leaves the call awaited, so the PostToolUse seals it instead.
      serial
        .run(async () => sealGatewayFrame(call, sessionAwaiting(toolUseId)))
        .catch((error: unknown) =>
          log(
            `mcp gateway could not record ${call.toolName} (${toolUseId}): ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      return;
    }
    sealGatewayFrame(call, undefined);
  }

  /**
   * Seal one gateway call on the session chain that is waiting on it, or on
   * the daemon's own chain when none is, and write it in the same
   * synchronous stretch.
   */
  function sealGatewayFrame(
    call: GatewayCallRecord,
    session: SessionRecord | undefined,
  ): void {
    // One chain only, not `markEveryChain`: the daemon's chain is written on
    // the forward path a connected app waits on, and the comment above
    // `recordGatewayCall` explains why nothing there may cost more than the
    // one chain it touches.
    const recorder = session?.recorder ?? hostRecorder;
    const mark = recorder.markChain();
    try {
      const { kind, body, fields } = gatewayFrame(call);
      if (session !== undefined && call.toolUseId !== undefined)
        record(
          session.recorder.sealGatewayCall(
            kind,
            { ...body, tool_use_id: call.toolUseId },
            fields,
          ),
          session.recorder.takeBodies(),
        );
      else
        record(
          [hostRecorder.sealCollectorEvent(kind, body, fields)],
          hostRecorder.takeBodies(),
        );
    } catch (error) {
      recorder.rollbackChain(mark);
      throw error;
    }
  }

  /**
   * The live session whose hook requested this call and is still waiting on
   * it, or undefined. A session that already holds a frame for the id is not
   * waiting, so a second call naming the same id seals on the daemon's chain
   * rather than vanishing as a repeat.
   */
  function sessionAwaiting(toolUseId: string): SessionRecord | undefined {
    return registry
      .list()
      .find(
        (candidate) =>
          !candidate.sealed &&
          !candidate.pendingTerminal &&
          candidate.recorder.awaitsToolCall(toolUseId),
      );
  }

  /** The frame one gateway call seals, on whichever chain it lands. */
  function gatewayFrame(call: GatewayCallRecord): {
    kind: "tool_call" | "policy_decision";
    body: Record<string, unknown>;
    fields: Parameters<SessionRecorder["sealCollectorEvent"]>[2];
  } {
    return {
      kind: call.status === "rejected" ? "policy_decision" : "tool_call",
      body: {
        tool_name: call.toolName,
        tool_source: "mcp",
        mcp_server_name: "oxagen",
        mcp_tool_name: call.toolName,
        tool_status: call.status,
        tool_duration_ms: call.durationMs,
        ...(call.inputDigest === undefined
          ? {}
          : {
              tool_input_digest: call.inputDigest,
              tool_input_bytes: call.inputBytes,
            }),
        ...(call.outputDigest === undefined
          ? {}
          : {
              tool_output_digest: call.outputDigest,
              tool_output_bytes: call.outputBytes,
            }),
        ...(call.status === "rejected"
          ? {
              policy_decision: "deny",
              policy_source: "kernel",
              policy_reason: call.refusedReason ?? "refused",
            }
          : {}),
      },
      fields: {
        attrs: {
          "oxagen.connected_app": call.client,
          "oxagen.mcp_session": call.sessionId,
          [TACHO_ENFORCEMENT_TIER_ATTR]: TACHO_GATEWAY_TIER,
        },
        // The gateway hands over the arguments and the result; the
        // recorder redacts them, digests what is left and buffers the
        // body for the WAL. A rejected call chains the digest the same
        // way, but `contentClassOf` gives `policy_decision` no retention
        // class, so its bytes are never kept: the record says what was
        // attempted, not what it would have said.
        ...(call.content === undefined ? {} : { content: call.content }),
      },
    };
  }

  const gateway = createMcpGateway({
    attribution: (): GatewayAttribution | undefined => {
      // Read through `host` every time: a revoke applied by `applyControlFacts`
      // takes the gateway with it on the next call, not the next restart.
      if (host.revoked_at !== null) return undefined;
      if (host.host_status === "revoked" || host.host_status === "suspended")
        return undefined;
      // The gateway presents its OWN key, never the host key. The host key
      // reports events and fetches the mandate; a connected app's tool calls
      // must not carry that authority (ADR-078, and the escalation
      // `machineKeyDenial` closes). A host enrolled before the gateway existed
      // has no such key, and then the gateway serves nothing rather than
      // falling back -- which is the whole point of the split.
      const gatewayKey = host.gateway_api_key;
      if (gatewayKey === undefined || gatewayKey.length === 0) return undefined;
      return {
        organizationId: host.organization_id,
        workspaceId: host.workspace_id,
        orgSlug: host.org_slug,
        workspaceSlug: host.workspace_slug,
        apiKey: gatewayKey,
        hostEnrollmentId: host.host_enrollment_id,
        // The chain this call will be sealed onto, named on the request so
        // the control plane's record of it points at a specific session
        // rather than at the host alone (#3221). Read here, from the same
        // recorder `recordGatewayCall` seals with, so the two cannot name
        // different chains.
        chainSessionUuid: hostRecorder.sessionUuid,
        // What makes the chain id above evidence rather than a name anyone
        // holding the ingest key could also write.
        ...(hostGenesisHash() === undefined
          ? {}
          : { chainGenesisHash: hostGenesisHash() }),
      };
    },
    endpoint: mcpEndpointFor(host),
    fetch: ((url: string, init: Parameters<GatewayFetch>[1]) =>
      (options.fetch ?? ((input, opts) => fetch(input, opts) as never))(
        url,
        init,
      )) as GatewayFetch,
    bundle: () => host.bundle,
    record: recordGatewayCall,
    log,
    now,
  });

  /**
   * The loopback model proxy (story sheet item 10). Its frames land on the
   * session's own chain when the call can be correlated to one, and on the
   * daemon's chain otherwise.
   */
  let displacedUpstreams: Partial<ModelUpstreams> = {};
  async function refreshUpstreams(): Promise<void> {
    try {
      const state = await readModelBaseUrlState({
        home: options.home ?? homedir(),
        port: modelProxyPortFor(host),
        stellaHome: dirname(options.paths.stellaToml),
        harnesses: ["claude-code", "codex", "stella"],
      });
      const next: Partial<ModelUpstreams> = {};
      for (const entry of state.harnesses) {
        if (entry.previous === null) continue;
        // Stella never displaces a value (its own URL is left in place), so
        // it has no previous upstream to report.
        if (entry.harness === "claude-code") next.anthropic = entry.previous;
        else if (entry.harness === "codex") {
          next.openai = entry.previous;
          next.chatgpt = entry.previous;
        }
      }
      displacedUpstreams = next;
      modelBaseUrls = state.harnesses.map((entry) => ({
        harness: entry.harness,
        key: entry.key,
        ours: entry.ours,
        // The value itself is not sent. Whether ours is in force is the whole
        // question, and a URL a user chose is theirs.
        ...(entry.shadowedBy !== undefined
          ? { shadowed_by: entry.shadowedBy.file }
          : {}),
      }));
    } catch (error) {
      log(
        `model proxy: could not read the displaced base URLs: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  await refreshUpstreams();

  const modelProxy = createModelProxy({
    registry,
    hostRecorder: () => hostRecorder,
    record,
    policy: () => ({
      bundle: host.bundle,
      hostStatus: hostStatusInForce(host, bundleVerified),
    }),
    upstreams: () => ({
      ...DEFAULT_MODEL_UPSTREAMS,
      ...displacedUpstreams,
      ...options.modelUpstreams,
    }),
    // A restart must not hand the agent's day back either (ADR-160). Only a
    // session whose last frame is from `day` can hold a frame from it, so
    // the rest of the week the WAL keeps is not parsed.
    priorDaySpendMicros: (day) => {
      const start = Date.parse(`${day}T00:00:00.000Z`);
      let total = 0;
      for (const session of wal.sessions()) {
        const last = wal.lastEvent(session);
        if (last !== undefined && Date.parse(last.ts) < start) continue;
        for (const event of wal.read(session)) {
          if (event.kind !== "llm_call") continue;
          if (event.attrs[TACHO_METERING_ATTR] !== TACHO_METERING_OBSERVED)
            continue;
          if (utcDay(Date.parse(event.ts)) !== day) continue;
          const cost = (event.body as { cost_usd_micros?: number })
            .cost_usd_micros;
          if (typeof cost === "number") total += cost;
        }
      }
      return total;
    },
    recordedDaySpend: () =>
      recordedDaySpend === undefined
        ? undefined
        : {
            day: recordedDaySpend.day,
            thisHostMicros: recordedDaySpend.this_host_usd_micros,
            otherHostsMicros: recordedDaySpend.other_hosts_usd_micros,
          },
    // A restart must not hand a session its budget back: what the chain
    // already holds is counted before the first call is admitted.
    priorSpendMicros: (sessionUuid) => {
      let total = 0;
      for (const event of wal.read(sessionUuid)) {
        if (event.kind !== "llm_call") continue;
        if (event.attrs[TACHO_METERING_ATTR] !== TACHO_METERING_OBSERVED)
          continue;
        const cost = (event.body as { cost_usd_micros?: number })
          .cost_usd_micros;
        if (typeof cost === "number") total += cost;
      }
      return total;
    },
    ...(options.beforeForward !== undefined
      ? { beforeForward: options.beforeForward }
      : {}),
    credentials: {
      brokered: (provider) => inCustody(provider),
      custody: (provider) => {
        try {
          return credentialStore.read(provider);
        } catch (error) {
          // An unreadable store is a fault of Oxagen's, and the proxy fails
          // open on those: the call is treated as `harness_held`. A brokered
          // harness holds only a run token, so its call is then refused as
          // `credential_unavailable` with a reason, never forwarded blind.
          log(
            `credential store unreadable: ${error instanceof Error ? error.message : String(error)}`,
          );
          return undefined;
        }
      },
      verify: (token, provider) =>
        verifyRunToken(token, {
          key: runTokenKey(),
          host: host.host_enrollment_id,
          provider,
          now: now(),
        }),
    },
    port: () => modelProxyListener.port(),
    log,
    now,
  });
  const modelProxyListener = createModelProxyListener({
    proxy: modelProxy,
    // A test that asks for an ephemeral collector port gets an ephemeral
    // proxy port too, so parallel daemons never contend for `port + 1`.
    port:
      options.modelProxyPort ??
      (options.port === 0 ? 0 : modelProxyPortFor(host)),
    log,
  });

  const contained = createContainedRunner({
    host: () => host,
    registry,
    genesis: (uuid) => wal.read(uuid)[0]?.hash,
    hook: (envelope) => serial.run(() => handleHookInner(envelope)),
    record,
    model: modelProxy,
    modelPort: () => modelProxyListener.port(),
    issueCredential: (harness) =>
      issueRunToken(
        { harness },
        {
          key: runTokenKey,
          store: credentialStore,
          host: () => host,
          hostRecorder: () => hostRecorder,
          record,
          now,
          log,
        },
      ),
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    log,
  });
  launchedContained = contained.launched;

  /**
   * The real interrupt. A pause, cancel or kill already stops the session at
   * its next hook boundary; here it also cuts the model calls that are in
   * flight, and the proxy refuses new ones until the session is resumed. A
   * steer delivered as `interrupt` cuts the current call as retryable: the
   * harness retries it, and the next PreToolUse refuses the call it produces
   * with the steer as the reason (`hook-handler.ts`), so the steer lands
   * before that step runs. A refused cut would end the turn in StopFailure
   * and the steer would never arrive.
   */
  function interruptModelCalls(commands: ControlEnvelope["commands"]): void {
    for (const command of commands) {
      const cuts =
        command.command === "pause" ||
        command.command === "cancel" ||
        command.command === "kill" ||
        (command.command === "steer" && command.delivery_mode === "interrupt");
      if (!cuts) continue;
      const targets =
        command.session_uuid !== null
          ? [registry.byUuid(command.session_uuid)]
          : registry.live();
      for (const target of targets) {
        if (target === undefined) continue;
        if (command.command === "cancel" || command.command === "kill")
          contained.stop(target.recorder.sessionUuid);
        const cut = modelProxy.abortSession(
          target.recorder.sessionUuid,
          command.reason ?? `operator ${command.command}`,
          command.command === "steer" ? "steer" : undefined,
        );
        if (cut > 0 && command.command === "steer") {
          // The frame that records the steer says the step was cut short.
          const queued = target.control.messages.find(
            (message) => message.id === command.id,
          );
          if (queued !== undefined) queued.interrupted = true;
        }
        if (cut > 0)
          log(
            `interrupted ${cut} model call(s) of session ${target.harnessSessionId} (${command.command})`,
          );
      }
    }
  }

  function gatewayStatus(): {
    listening: boolean;
    port: number;
    routes: string[];
    calls_observed: number;
  } {
    return {
      listening: modelProxyListener.listening(),
      port: modelProxyListener.port(),
      routes: [...MODEL_PROXY_ROUTES],
      calls_observed: modelProxy.stats().callsObserved,
    };
  }

  /**
   * The tier a session earned, computed from what was routed (ADR-095).
   * `gateway` only when the proxy saw a model call for it: a base URL written
   * into a config file is intent, not traffic.
   */
  function tierOf(sessionUuid: string): "gateway" | "harness" | "observe" {
    if (modelProxy.callsObservedFor(sessionUuid) > 0) return TACHO_GATEWAY_TIER;
    return host.bundle.mode === "enforce" ? "harness" : "observe";
  }

  const githubProxy = createGithubProxy({
    host: () => {
      const current = readHostFile(paths.hostFile);
      return {
        ...host,
        github_broker_enabled: current?.github_broker_enabled === true,
        github_repositories: current?.github_repositories ?? [],
      };
    },
    policy,
    refreshBundle,
    registry,
    controlFetch: options.fetch ?? globalThis.fetch,
    now,
    record,
    log,
  });

  const api: CollectorApi = {
    runContained: contained.run,
    githubLease: (input) => githubProxy.issue(input),
    githubProxy: (req, res) => githubProxy.handle(req, res),
    localToken: host.local_token,
    enrollmentId: host.host_enrollment_id,
    // Deliberately NOT on `serial`. A gateway call is a round trip to the
    // control plane with a 30-second timeout, and the queue it used to sit in
    // is the same one `PreToolUse` hooks, OTel ingestion and spool draining
    // wait on: one connected app's slow tool call held every wrapped agent on
    // this machine past its 5-10 second decision budget, and held every other
    // MCP client behind it too. Nothing is lost by taking it off. The only
    // shared state the gateway touches is `recordGatewayCall`, which is
    // synchronous end to end — `sealCollectorEvent` advances the chain and
    // `wal.append` appends, neither with an await inside — so it cannot
    // interleave with a queued task however many forwards are in flight. The
    // queue was never protecting the forward; it was only ever costing. A
    // call a hooked session is waiting on is the one exception: its frame is
    // sealed on the session's chain, through the queue, and the forward's
    // answer does not wait for it (ADR-189).
    mcp: (body, context) => gateway.handle(body, context),
    mcpClose: (sessionId) => gateway.forget(sessionId),
    issueRunToken: (input) =>
      issueRunToken(input, {
        key: runTokenKey,
        store: credentialStore,
        host: () => host,
        hostRecorder: () => hostRecorder,
        record,
        now,
        log,
      }),
    handleHook: (envelope) =>
      serial.run(async () => {
        await drainSpool();
        return handleHookInner(envelope);
      }),
    handleOtlp: (signal, payload) =>
      serial.run(async () => {
        lastOtlpAt = now();
        if (signal === "traces") return;
        const { drafts, metrics } = normalizeOtlp(payload as OtlpPayload);
        const sessionIds = new Set<string>();
        for (const draft of drafts)
          if (draft.standard.session_id !== undefined)
            sessionIds.add(draft.standard.session_id);
        for (const metric of metrics)
          if (metric.standard.session_id !== undefined)
            sessionIds.add(metric.standard.session_id);
        for (const sessionId of sessionIds) {
          const { record: session, created } = registry.ensure(sessionId, {
            ambient: true,
          });
          // Its terminal is sealed but not yet in the WAL. A frame sealed now
          // takes the seq after it and reaches the WAL first, so the records
          // are dropped; a sealed chain takes them, marked after the stop.
          if (session.pendingTerminal === true) {
            log(
              `OTel records for session ${sessionId} dropped: its end is not yet written`,
            );
            continue;
          }
          if (created)
            log(
              `session ${sessionId} first seen through OTel; no hook stream yet`,
            );
          const mark = session.recorder.markChain();
          try {
            record(session.recorder.ingestOtlp(payload as OtlpPayload));
          } catch (error) {
            // One session's WAL failure must not lose another's OTel signal:
            // roll this chain back to where `ingestOtlp` found it and move on
            // to the rest of the payload.
            session.recorder.rollbackChain(mark);
            log(
              `OTel ingest not recorded for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
            );
            continue;
          }
          for (const refusal of session.recorder.takeOtelRefusals())
            log(`OTel record not sealed for session ${sessionId}: ${refusal}`);
        }
      }),
    health: () => ({
      ok: true,
      ...health(),
      host_status: host.host_status,
      sessions: registry.live().length,
      gateway: gatewayStatus(),
    }),
    status: () => ({
      ...health(),
      host_enrollment_id: host.host_enrollment_id,
      agent_key: host.agent_key,
      host_status: host.host_status,
      mode: host.bundle.mode,
      bundle_version: host.bundle.version,
      bundle_fetched_at: host.bundle_fetched_at,
      bundle_verified: bundleVerified,
      deny_generation: host.deny_generation,
      last_control_at:
        lastControlAt !== undefined ? toProtocolTimestamp(lastControlAt) : null,
      last_ingest_at:
        shipper.lastSuccessAt !== undefined
          ? toProtocolTimestamp(shipper.lastSuccessAt)
          : null,
      last_error: shipper.lastError ?? null,
      // Events the control plane refused as malformed. The shipper writes
      // each one to the quarantine directory and marks it shipped, so the
      // spool drains to zero and no error is left standing: the directory is
      // the only record that they never reached Oxagen. Counted per read
      // rather than kept in memory so it survives a daemon restart; `tacho
      // unenroll --purge` is what clears it.
      quarantined: readdirSync(paths.quarantine).filter((f) =>
        f.endsWith(".json"),
      ).length,
      hooks: detector.presence ?? null,
      unobserved_sessions: detector.unobserved,
      // Every kind of agent this host has run; the daemon's own chain is
      // not one of them.
      agents: registry.agents(),
      // Connected apps (ADR-078): one row per MCP client that has called
      // through the local gateway. Deliberately a separate list from
      // `agents`, which is the wrapped ones: a surface that merged them
      // would have to invent a tier for each row after the fact.
      connected: [...connected.entries()].map(([client, seen]) => ({
        client,
        enforcement_tier: "gateway",
        calls: seen.calls,
        refused: seen.refused,
        last_seen_at: seen.lastSeenAt,
      })),
      mcp_endpoint: mcpEndpointFor(host),
      // The loopback model proxy. `calls_observed` counts model calls since
      // the daemon started; a session's own count is on its row below.
      gateway: gatewayStatus(),
      // What the gateway holds in custody (ADR-143): provider, kind, source
      // and when it was taken. The secret is not here and has no field.
      credential_custody: (() => {
        try {
          return credentialStore.status();
        } catch {
          return [];
        }
      })(),
      sessions: registry.list().map((session) => ({
        session_id: session.harnessSessionId,
        session_uuid: session.recorder.sessionUuid,
        runtime: registry.agentOf(session).runtime,
        harness: registry.agentOf(session).harness,
        last_hook_event: session.lastHookEvent ?? null,
        seq: session.recorder.chainCursor.seq,
        sealed: session.sealed,
        ambient: session.ambient,
        paused: session.control.paused,
        cancelled: session.control.cancelled,
        enforcement_tier: tierOf(session.recorder.sessionUuid),
        model_calls_observed: modelProxy.callsObservedFor(
          session.recorder.sessionUuid,
        ),
        cwd: session.cwd ?? null,
        pid: session.pid ?? null,
        started_at: session.startedAt,
        last_seen_at: session.lastSeenAt,
      })),
    }),
    sessions: () =>
      registry.list().map((session) => ({
        session_id: session.harnessSessionId,
        session_uuid: session.recorder.sessionUuid,
        // `tacho verify` matches a harness that reports no session id by
        // the newest chain carrying its label.
        runtime: registry.agentOf(session).runtime,
        harness: registry.agentOf(session).harness,
        sealed: session.sealed,
        seq: session.recorder.chainCursor.seq,
      })),
    exportSession: (key: string, format: ExportFormat) => {
      const byId = registry.get(key)?.recorder.sessionUuid;
      const uuid = byId ?? key;
      const events = wal.read(uuid);
      if (events.length === 0) return undefined;
      return exportSession(events, format);
    },
  };

  // Genesis of the daemon chain.
  if (!hostRecorder.hasStarted) {
    record([
      hostRecorder.sealCollectorEvent("agent_start", {
        session_start_source: "daemon",
      }),
    ]);
  }

  // A session recorded entirely over HTTP hooks (no spool file, because the
  // daemon was reachable right up to the moment it died) leaves no trace of
  // an outage anywhere on disk: the WAL simply stops. `drainSpool` already
  // chains this gap for what a dead daemon forced onto the spool; this
  // covers everything else a restart resumed, every session `persisted`
  // named as live, with the downtime measured from the last time this
  // process's predecessor wrote `state.json`.
  if (persisted !== undefined && priorStateWrittenAt !== undefined) {
    const restartMarks: Array<{ session: SessionRecord; mark: ChainMark }> = [];
    const restartGaps: TachoEvent[] = [];
    for (const session of registry.live()) {
      if (session === hostRecord) continue;
      // A session whose termination is still pending has a terminal event
      // already computed and journaled at a fixed seq, waiting for the git
      // lane or the next tick to retry it (`recordHookOutcome`'s own
      // pending-terminal path). Sealing a gap on that chain first would
      // claim the seq the journaled terminal is fixed to, and the retry
      // would either be refused by the seq guard in `Wal.append` or land as
      // a chain fork `appendRecovered` reports as a recovery conflict. This
      // session's own gap is exactly what the pending terminal's retry
      // already accounts for; nothing here would add information.
      if (session.pendingTerminal) continue;
      const mark = session.recorder.markChain();
      restartMarks.push({ session, mark });
      restartGaps.push(
        session.recorder.sealCollectorEvent("telemetry_gap", {
          gap_cause: "daemon_down",
          gap_duration_ms: Math.max(0, Math.round(now() - priorStateWrittenAt)),
          incident_kind: "telemetry_gap",
          incident_severity: 1,
        }),
      );
    }
    try {
      record(restartGaps);
      for (const { session } of restartMarks)
        outageGapped.add(session.recorder.sessionUuid);
    } catch (error) {
      rollbackEveryChain(restartMarks);
      log(
        `restart telemetry gap not recorded: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  ready(api);
  servingSince = now();
  if (options.listen ?? true) {
    const unixSocket = (options.platform ?? process.platform) !== "win32";
    log(
      unixSocket
        ? `listening on ${paths.socket} and 127.0.0.1:${port ?? "?"}`
        : `listening on 127.0.0.1:${port ?? "?"}`,
    );
    // Never throws: a port that is taken is retried on a backoff, and the
    // status says `listening: false` until the bind succeeds.
    await modelProxyListener.start();
  }

  /**
   * Drop refused events once they are as old as the WAL history they belong
   * to. Nothing else clears the quarantine directory, so without this one
   * refused event would read as a degraded agent forever; ageing it out on
   * the WAL's own retention keeps the signal loud while it is fresh and
   * quiet once the run it came from is gone.
   */
  function sweepQuarantine(at: number, retainMs: number): void {
    let removed = 0;
    for (const name of readdirSync(paths.quarantine)) {
      if (!name.endsWith(".json")) continue;
      const file = join(paths.quarantine, name);
      try {
        if (at - statSync(file).mtimeMs < retainMs) continue;
        unlinkSync(file);
        removed += 1;
      } catch {
        // a file that vanished or cannot be read is one less to sweep
      }
    }
    if (removed > 0) log(`swept ${removed} refused events out of quarantine`);
  }

  let lastRefresh = 0;
  let lastDetect = 0;
  let lastCheckpoint = 0;
  let lastSweep = 0;
  let lastCompact = 0;

  // A narrowing this host owed when it last exited. Run here rather than left
  // to the first poll: a poll can be a bundle refresh interval away, or an
  // outage away, and the content is on disk now.
  retryOwedBodyPurge();

  /**
   * The git reconciliation lane: at most one drain in flight, never awaited by
   * the work an operator's command travels through.
   *
   * ## Why this is a lane and not a step in the tick
   *
   * `drainGitReads` used to be awaited in the middle of `tick`, ahead of
   * `refreshBundle` (the allow-state fetch) and `sendAcks` (which is also how a
   * queued control command reaches this host). Moving it after them is half the
   * answer and not this one: the drain would still be inside the tick, so the
   * interval driver's `ticking` guard would still drop every tick that
   * overlapped it and the NEXT poll would be as late as the old one. Its bounds
   * are generous by
   * design, because a git read that is slow is a read worth abandoning rather
   * than waiting on — but the ceilings multiply. One reconciliation is
   * `readGitFacts` (`rev-parse HEAD`, then three reads at once: 2 x 10 s) plus
   * `readWorkingTreeChanges` (`status`, then numstat-and-root at once with a
   * no-HEAD fallback, then `MAX_UNTRACKED_LINE_COUNTS` = 64 untracked probes
   * through a pool of `UNTRACKED_COUNT_CONCURRENCY` = 4, which is 16 waves):
   * 10 + 20 + 160 = 190 s, so 210 s in all. `GIT_READS_PER_TICK` = 4 sessions
   * are drained one after another, and the interval driver's `ticking` guard
   * drops every tick that would overlap — so on a network-backed worktree the
   * whole control path stalled for up to **840 s, fourteen minutes**, on top of
   * the five-minute `bundleRefreshMs` cadence.
   *
   * Fourteen minutes is not a slow refresh, it is a kill switch that does not
   * work. An operator's suspend, revoke or cancel is enforced by the hooks
   * reading the bundle this loop fetches, so for that whole window the agent
   * kept acting under the allow state the mandate had already withdrawn, and
   * the record named the withdrawn state as the live one.
   *
   * With the drain in its own lane the control path waits on none of it: the
   * poll runs every tick — `Math.min(shipMs, 1_000)` = **1 s** — and the bundle
   * on its own five-minute cadence, whatever git is doing. Reconciliation is
   * unchanged in every other respect: it is still bounded to four sessions a
   * tick, still spawns off the serial queue, and still applies its results
   * back THROUGH that queue, which is what makes detaching it safe — the seal
   * ordering a hook depends on is enforced there, not by the tick's `await`.
   *
   * `tick()` still awaits the lane before it resolves, so a caller driving the
   * daemon a tick at a time sees the reconciliation it asked for. The interval
   * driver calls {@link controlTick} instead and releases its guard without
   * waiting, which is the half that matters: nothing an operator sends queues
   * behind a git process any more.
   */
  let gitLane: Promise<void> | undefined;
  function startGitReads(): Promise<void> {
    if (gitLane !== undefined) return gitLane;
    if (stopped || !gitReads.hasPending()) return Promise.resolve();
    const lane = gitReads
      .drainGitReads()
      .catch((error) => {
        for (const uuid of pendingSessionEnds.keys())
          requestGitRead(uuid, { force: true, reconcile: true });
        log(
          `git reads failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        if (gitLane === lane) gitLane = undefined;
      });
    gitLane = lane;
    return lane;
  }

  /**
   * One pass of everything an operator's command travels through.
   *
   * This is what the interval drives, and it is deliberately free of the git
   * lane: see {@link startGitReads}.
   */
  /**
   * Run one stage of `controlTick` in isolation: a throw is logged and
   * swallowed rather than left to unwind the whole tick.
   *
   * `controlTick` used to run its stages as one `await` chain, so a throw
   * from an early stage (the detector, the sweep, a checkpoint) skipped
   * every stage after it — including `shipper.drain()` and `wal.compact`,
   * every single tick, for as long as the failing stage kept failing. A host
   * whose sweep or checkpoint started throwing stopped shipping anything at
   * all, silently, rather than losing only the stage that was actually
   * broken.
   */
  async function stage(
    name: string,
    run: () => void | Promise<void>,
  ): Promise<void> {
    try {
      await run();
    } catch (error) {
      log(
        `controlTick stage "${name}" failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function controlTick(): Promise<void> {
    if (stopped) return;
    for (const session of registry.list()) {
      for (const repair of session.recorder.takeSealRepairs()) {
        log(
          `recorder sealed an event no path returned; written anyway: ${repair}`,
        );
      }
    }
    // The detector runs off the serial queue: its scan is asynchronous file
    // I/O over every project directory, and a hook that arrived while it
    // ran would otherwise wait on it. It records each frame in the same
    // synchronous stretch that seals it, the property the gateway relies on
    // to record off-queue: a model or gateway call sealed on the host chain
    // during the scan must not be appended ahead of an earlier detector frame.
    await stage("detector", async () => {
      if (now() - lastDetect >= timers.detectorMs) {
        lastDetect = now();
        const marks = markEveryChain();
        try {
          await detector.tick((events) => record(events));
        } catch (error) {
          rollbackEveryChain(marks);
          throw error;
        }
      }
    });
    await stage("spool, transcripts, sweep, checkpoint", () =>
      serial.run(async () => {
        const t = now();
        await drainSpool(t);
        // transcript tailer: bounded per file per tick, asynchronous reads
        await transcriptTailer.tick();
        if (t - lastSweep >= timers.sweepMs) {
          lastSweep = t;
          // Each session is written and sealed on its own. A write that
          // fails rolls back only that chain and leaves it open for the next
          // sweep. Sealing every chain first and writing them together left
          // a chain whose write failed marked sealed with no `agent_stop` on
          // disk, and `forgetSealed` then dropped it (#3719).
          let failure: { error: unknown } | undefined;
          const candidates = registry.sweepCandidates(
            isProcessAlive,
            timers.idleSessionMs,
            (session) =>
              pendingSessionEnds.has(session.recorder.sessionUuid) ||
              spoolHolds(session),
          );
          for (const candidate of candidates) {
            const recorder = candidate.record.recorder;
            const mark = recorder.markChain();
            try {
              record(registry.finalizeSwept(candidate));
            } catch (error) {
              recorder.rollbackChain(mark);
              failure ??= { error };
              continue;
            }
            registry.settleSwept(candidate);
          }
          registry.forgetSealed(timers.walRetainMs);
          if (failure !== undefined) throw failure.error;
        }
        if (t - lastCheckpoint >= timers.checkpointMs) {
          lastCheckpoint = t;
          checkpoint();
        }
        if (stateDirty) persistState();
      }),
    );
    // Refresh before draining, so a batch carrying bodies leaves under the
    // mandate the control plane holds now rather than the one cached before
    // an outage.
    await stage("bundle refresh", async () => {
      // A revoked host's key fetches nothing, so it stops asking (#3944).
      if (shipper.hostRevoked) return;
      if (now() - lastRefresh >= timers.bundleRefreshMs) {
        lastRefresh = now();
        await refreshBundle();
        await refreshUpstreams();
      }
    });
    await stage("ship", async () => {
      await shipper.drain();
    });
    await stage("acks", () => sendAcks());
    // Started after the poll and awaited by nothing — both halves matter, and
    // they answer different halves of the same defect.
    //
    // AFTER, so the poll in this tick never sits behind a git spawn. NOT
    // AWAITED, because ordering alone only narrows the window: the drain would
    // still run inside the tick, the `ticking` guard would still drop every
    // tick that overlaps it, and the NEXT poll would still be up to fourteen
    // minutes late. In a lane of its own nothing waits on it in this tick or
    // any later one. `startGitReads` has the arithmetic.
    //
    // Reconciliation frames the lane seals ship on a following tick, which
    // costs them one interval and nothing else — they are already asynchronous
    // and already land a batch or more after the tool frames they belong with.
    void startGitReads();
    await stage("compact", () => {
      if (now() - lastCompact >= 60 * 60_000) {
        lastCompact = now();
        wal.compact(now(), timers.walRetainMs);
        sweepQuarantine(now(), timers.walRetainMs);
      }
    });
    // The WAL is the record; a recorder's in-memory list of what it sealed is
    // only read inside one synchronous ingest (`everySealed`). Kept whole, it
    // grew with every event of every session for the daemon's lifetime.
    await stage("trim", () => {
      for (const session of registry.list())
        session.recorder.trimSealedEvents(RECORDER_EVENTS_KEPT);
      hostRecorder.trimSealedEvents(RECORDER_EVENTS_KEPT);
    });
  }

  /**
   * One pass, plus the git lane it started.
   *
   * The seam a caller driving the daemon by hand uses, so that awaiting a tick
   * means "and the reconciliation it asked for has landed". The interval driver
   * does NOT use it, for the reason {@link startGitReads} gives.
   */
  /**
   * Codex reads a static run token from `auth.json` and has no helper to
   * fetch a fresh one, so the gateway that issued it renews it (ADR-143):
   * once an hour, when the token in place no longer verifies for this
   * enrollment or is inside the renewal window, a new one is minted through
   * the issuer (so the record carries it) and written in place. A host with
   * no OpenAI key in custody, or a Codex on a ChatGPT login, is left alone.
   */
  let lastStaticRenewalAt = 0;
  async function renewStaticTokens(): Promise<void> {
    if (!host.harnesses.includes("codex")) return;
    if (now() - lastStaticRenewalAt < STATIC_TOKEN_RENEWAL_CHECK_MS) return;
    lastStaticRenewalAt = now();
    if (host.host_status !== "active" || !inCustody("openai")) return;
    const home = options.home ?? homedir();
    let state: ModelCredentialHarnessState | undefined;
    try {
      state = (await readModelCredentialState({ home, harnesses: ["codex"] }))
        .harnesses[0];
    } catch (error) {
      log(
        `static token renewal: cannot read Codex's auth file: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (state === undefined || !state.brokered) return;
    const current = readCodexApiKeyMember(home);
    if (staticTokenStillGood(current, host, paths.runTokenKey, now())) return;
    const issued = api.issueRunToken?.({
      harness: "codex",
      placement: "static",
    });
    if (issued === undefined || issued.status !== 200) {
      log(
        `static token renewal: not issued (${issued?.body.error ?? "no issuer"})`,
      );
      return;
    }
    try {
      await applyModelCredentials({
        home,
        harnesses: ["codex"],
        staticTokens: { codex: issued.body.token },
      });
      log(
        `renewed Codex's static run token ${issued.body.token_id}, expires ${issued.body.expires_at}`,
      );
    } catch (error) {
      log(
        `static token renewal: could not write Codex's auth file: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function tick(): Promise<void> {
    await controlTick();
    await renewStaticTokens();
    await gitLane;
  }

  let timer: NodeJS.Timeout | undefined;
  let ticking = false;
  if (options.listen ?? true) {
    timer = setInterval(
      () => {
        if (ticking) return;
        ticking = true;
        // `controlTick`, not `tick`: the guard must be released as soon as the
        // control path is done, or a fourteen-minute git drain would drop every
        // poll in between and put the stall straight back.
        controlTick()
          .then(() => renewStaticTokens())
          .catch((error) => {
            // The code and the first frame name the site. A message alone
            // ("Cannot create a string longer than 0x1fffffe8 characters",
            // nine thousand times over nine hours) named nothing.
            const code =
              error instanceof Error && "code" in error
                ? ` [${String((error as { code: unknown }).code)}]`
                : "";
            const site =
              error instanceof Error && typeof error.stack === "string"
                ? (error.stack.split("\n")[1]?.trim() ?? "")
                : "";
            log(
              `tick failed${code}: ${error instanceof Error ? error.message : String(error)}${site ? ` at ${site}` : ""}`,
            );
          })
          .finally(() => {
            ticking = false;
          });
      },
      Math.min(timers.shipMs, 1_000),
    );
    timer.unref();
  }

  return {
    api,
    registry,
    wal,
    shipper,
    detector,
    transcriptTailer,
    hostRecorder,
    host: () => host,
    port,
    get modelProxyPort() {
      return modelProxyListener.listening()
        ? modelProxyListener.port()
        : undefined;
    },
    tick,
    /**
     * Wait for the git lane to settle, starting one if work is pending.
     *
     * For a caller that wants the reconciliation without a whole tick — and for
     * the assertion that a slow one does not hold the control path up, which
     * needs to observe the two independently.
     */
    flushGitReads: () => startGitReads(),
    drainSpool: () => serial.run(drainSpool),
    refreshBundle,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      // Persist now, before the potentially long wait below. `gitLane` can
      // run for minutes (`startGitReads`'s own comment has the arithmetic),
      // and a stop timeout that SIGKILLs this process mid-wait must not leave
      // `state.json` any further behind the WAL than the last ordinary tick
      // already left it. The finalize below persists again once the wait and
      // the shutdown sequence after it are done.
      persistState();
      // The lane may be mid-spawn. Its results are applied through `serial`, so
      // shutting down without waiting would race the finalize below and could
      // append a reconciliation after the host chain was sealed.
      await gitLane;
      modelProxy.close();
      await modelProxyListener.close();
      await server.close();
      await serial.run(async () => {
        record(hostRecorder.finalize("completed", toProtocolTimestamp(now())));
        hostRecord.sealed = true;
        persistState();
      });
      await shipper.drain();
    },
  };
}
