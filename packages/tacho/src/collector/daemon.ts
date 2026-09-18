/**
 * `tachod`: the per-host collector (spec section 3). Composes the listener,
 * the session registry, the WAL, the shipper, the command inbox, the
 * detector, and the checkpoint signer around one host file. Everything with
 * a side effect is injectable so the whole daemon runs in a test against a
 * fake control plane and a scratch `TACHO_HOME`.
 */
import { readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { homedir, hostname as osHostname } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { type ClaudeCodeContext, digestText } from "../claude-code/context";
import { normalizeOtlp, type OtlpPayload } from "../claude-code/otel";
import type { SessionRecorder } from "../claude-code/recorder";
import type { TachoEvent } from "../envelope";
import { type FrameBody, retentionAllows } from "../evidence/frame-body";
import { verifyBundle } from "../host/bundle";
import {
  ControlError,
  createControlClient,
  type ControlClient,
  type FetchLike,
  type RateLimitHint,
} from "../host/control-client";
import { type DeviceKey, loadOrCreateDeviceKey } from "../host/device-key";
import {
  ensureDir,
  readJsonFileIfExists,
  writeSensitiveFileAtomic,
} from "../host/fs";
import {
  applyControlFacts,
  type HostFile,
  readHostFile,
  mcpEndpointFor,
  modelProxyPortFor,
} from "../host/host-file";
import { readModelBaseUrlState } from "../host/model-base-url";
import type { TachoPaths } from "../host/paths";
import { isProcessAlive, listClaudeProcesses } from "../host/process-scan";
import type { Exec } from "../host/service";
import { NO_RETENTION, type RetentionMandate } from "../evidence/retention";
import { Wal } from "../host/wal";
import { ulid } from "../ids";
import { toProtocolTimestamp } from "../timestamp";
import {
  TACHO_ENFORCEMENT_TIER_ATTR,
  TACHO_GATEWAY_TIER,
  TACHO_METERING_ATTR,
  TACHO_METERING_OBSERVED,
  type CommandAcknowledgement,
  type ControlEnvelope,
  type DaemonHealth,
  TACHO_BUNDLE_FEATURES,
} from "../wire";
import { Detector } from "./detector";
import {
  type GitFacts,
  type GitWorkingTreeChange,
  readGitFacts,
  readWorkingTreeChanges,
  worktreeReconciledBody,
} from "./git-facts";
import { exportSession, type ExportFormat } from "./exporters";
import {
  handleHookEvent,
  type HookReplay,
  type PolicyView,
} from "./hook-handler";
import { applyCommands } from "./inbox";
import {
  createMcpGateway,
  type GatewayAttribution,
  type GatewayCallRecord,
  type GatewayFetch,
} from "./mcp-gateway";
import { type BeforeForward, createModelProxy } from "./model-proxy";
import { createModelProxyListener } from "./model-proxy-listener";
import {
  DEFAULT_MODEL_UPSTREAMS,
  MODEL_PROXY_ROUTES,
  type ModelUpstreams,
} from "./model-routes";
import {
  parseRegistryState,
  type SessionRecord,
  SessionRegistry,
} from "./registry";
import {
  type CollectorApi,
  createCollectorServer,
  type HookEnvelope,
} from "./server";
import { Shipper } from "./spool";
import { TranscriptTailer } from "./transcript-tailer";

export const TACHO_WRAPPER_VERSION = "2.1.1";

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

export interface DaemonOptions {
  paths: TachoPaths;
  host?: HostFile;
  fetch?: FetchLike;
  exec?: Exec;
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
  /** Run the periodic work once, in order; tests call this instead of waiting. */
  tick: () => Promise<void>;
  drainSpool: () => Promise<number>;
  refreshBundle: () => Promise<boolean>;
  stop: () => Promise<void>;
}

interface SpoolFile {
  schema: "tacho.spool.v1";
  received_at: string;
  payload: unknown;
  env?: Record<string, string | undefined>;
  evaluation?: HookReplay["evaluation"];
  harness?: HookEnvelope["harness"];
  agent?: HookEnvelope["agent"];
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

export async function startDaemon(
  options: DaemonOptions,
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
  const wal = new Wal(paths.wal);
  const registry = new SessionRegistry({
    context,
    scope: host.host_enrollment_id,
    now,
  });
  const persisted = parseRegistryState(readJsonFileIfExists(paths.daemonState));
  if (persisted !== undefined) registry.restore(persisted);

  // The daemon's own chain: host-level incidents, commands, and checkpoints
  // land here so every event the host emits belongs to a verifiable session.
  const bootId = `tachod-${ulid(now())}`;
  const hostRecord = registry.ensure(bootId, { pid: process.pid }).record;
  const hostRecorder = hostRecord.recorder;

  let bundleVerified = verifyBundle(host.bundle, host.bundle_public_key_pem).ok;
  /**
   * When the control plane last confirmed the cached mandate, as epoch ms.
   *
   * A poll that answers `not_modified` is a confirmation: it says the etag in
   * force is still this one. Freshness has to be measured from here, because
   * the etag covers policy content only, so an unchanged mandate is never
   * re-sent and its signed `expires_at` cannot be renewed on the host. See
   * `isStale` in host/bundle.ts.
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
  const retentionInForce = (): RetentionMandate =>
    bundleVerified && !mandateLapsed() ? host.bundle.retention : NO_RETENTION;
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
  let lastOtlpAt: number | undefined;
  let lastIngestAt: number | undefined;
  let stateDirty = false;
  let stopped = false;
  const pendingAcks: CommandAcknowledgement[] = [];
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
    writeSensitiveFileAtomic(
      paths.daemonState,
      JSON.stringify(registry.state()),
    );
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
      bodies.filter((body) => retentionAllows(retention, body.content_class)),
    );
    stateDirty = true;
  }

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
    };
  }

  function policy(): PolicyView {
    const current = host as HostFile;
    return {
      bundle: current.bundle,
      verified: bundleVerified,
      mandateConfirmedAt,
      hostStatus: current.host_status,
      denyGeneration: current.deny_generation,
      controlReachable:
        lastControlAt !== undefined &&
        now() - lastControlAt < 2 * timers.bundleRefreshMs,
    };
  }

  async function refreshBundle(): Promise<boolean> {
    try {
      const response = await client.bundle(host.bundle.etag);
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
        return false;
      }
      if (response.bundle === null) return false;
      const verification = verifyBundle(
        response.bundle,
        host.bundle_public_key_pem,
      );
      if (!verification.ok) {
        log(
          `refused a bundle that does not verify: ${verification.reason ?? "unknown"}`,
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
    host = applyControlFacts(paths.hostFile, host, {
      host_status: control.host_status,
      deny_generation: control.deny_generation,
    });
    if (control.bundle_etag === host.bundle.etag) mandateConfirmedAt = now();
    else await refreshBundle();
    if (control.commands.length > 0) {
      const result = await applyCommands(control.commands, {
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
      });
      record(result.events);
      pendingAcks.push(...result.acknowledgements);
      interruptModelCalls(control.commands);
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
    enrollmentId: host.host_enrollment_id,
    now,
  });

  // --- transcript tailer -------------------------------------------------
  // The detector above only stats a transcript's mtime. The tailer reads it:
  // every session that reported a `transcript_path` has its file tailed on
  // the tick, and a subagent's finished transcript is fed once when its
  // SubagentStop arrives. See transcript-tailer.ts for why this exists.
  const transcriptTailer = new TranscriptTailer({
    sessions: () => registry.list(),
    session: (id) => registry.get(id),
    record,
    statePath: paths.transcriptTailState,
    log,
  });

  /**
   * What the tailer does before a hook is sealed: a `Stop` or `SessionEnd`
   * drains the session's transcript so the turn's model calls sit on the
   * chain before the frame that closes it, and a `SubagentStop` feeds the
   * subagent's transcript to the child chain before that chain is finalized.
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
    if (
      pendingAcks.length === 0 &&
      lastIngestAt !== undefined &&
      now() - lastIngestAt < timers.commandsPollMs
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
      const retryInMs = commandPollBackoffMs;
      commandPollNextAttemptAt = now() + retryInMs;
      commandPollBackoffMs = Math.min(
        commandPollBackoffMs * 2,
        COMMAND_POLL_MAX_BACKOFF_MS,
      );
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
    for (const session of registry.list()) {
      const head = session.recorder.chainCursor;
      const headSeq = head.seq - 1;
      if (headSeq <= session.lastCheckpointSeq || session.sealed) continue;
      const message = `${session.recorder.sessionUuid}:${headSeq}:${head.prevHash}`;
      const event = session.recorder.sealCollectorEvent("checkpoint", {
        checkpoint_id: ulid(now()),
        checkpoint_event_count: headSeq + 1,
        checkpoint_chain_head: head.prevHash,
        checkpoint_device_signature: deviceKey.sign(message),
        checkpoint_device_key_fingerprint: deviceKey.fingerprint,
      });
      session.lastCheckpointSeq = event.seq;
      events.push(event);
    }
    record(events);
  }

  const spoolEnvelope = (file: SpoolFile): HookEnvelope => ({
    payload: file.payload,
    ...(file.env !== undefined ? { env: file.env } : {}),
    ...(file.harness !== undefined ? { harness: file.harness } : {}),
    ...(file.agent !== undefined ? { agent: file.agent } : {}),
    replay: {
      receivedAt: file.received_at,
      ...(file.evaluation !== undefined ? { evaluation: file.evaluation } : {}),
    },
  });

  /**
   * Git facts per working directory, with the time they were read.
   *
   * The seam is here, in the daemon, rather than in `contextFactsFromEnv` or
   * in the hook handler. `contextFactsFromEnv` is pure and reads environment
   * variables only; shelling out from it would put a process spawn inside a
   * normalizer that the transcript reader and the OTel path also call. The
   * hook handler runs on the serial queue that every wrapped agent on this
   * host waits on, and a hook has a decision budget measured in seconds. The
   * daemon already owns the `Exec` port, already knows each session's cwd,
   * and already has a place to hold state across frames, so it reads the
   * facts once per worktree and hands them to the recorder, which merges
   * them into the context block of every frame it seals afterwards.
   *
   * The cache is what keeps this off the per-frame path: a turn fires many
   * hooks, and the head sha does not move between them. Entries refresh at
   * turn boundaries and whenever one goes stale, so a commit made mid-session
   * is picked up without four `git` invocations per tool call.
   */
  const gitFactsByCwd = new Map<string, { at: number; facts?: GitFacts }>();
  const GIT_FACTS_TTL_MS = 30_000;

  function gitFactsFor(cwd: string, force: boolean): GitFacts | undefined {
    const cached = gitFactsByCwd.get(cwd);
    if (cached !== undefined && !force && now() - cached.at < GIT_FACTS_TTL_MS)
      return cached.facts;
    const facts = readGitFacts(exec, cwd);
    gitFactsByCwd.set(cwd, {
      at: now(),
      ...(facts !== undefined ? { facts } : {}),
    });
    return facts;
  }

  /**
   * The git work one session is waiting for, by harness session id.
   *
   * A hook never reads a worktree. It records that one wants reading and
   * returns; the tick drains this map outside the serial queue. Two reasons.
   * A hook holds the queue that every wrapped agent on this host waits on,
   * and a prompt hook has a budget measured in seconds, so four `git`
   * invocations for one session times every live session was a way to spend
   * that budget on someone else's repository. And the read this seam now
   * also does, the worktree reconciliation, is heavier still: a whole-tree
   * `git status` plus a numstat. Neither belongs on the path a hook answers
   * on. Only the session the hook names is queued, never every live one.
   *
   * `force` skips the facts cache. `reconcile` asks for the observed change
   * list as well.
   */
  const gitPending = new Map<string, { force: boolean; reconcile: boolean }>();

  /** The most sessions one tick reads worktrees for. */
  const GIT_READS_PER_TICK = 4;

  /**
   * The least time between two worktree reconciliations of one session.
   *
   * The trigger is `Stop`, so the sampling rule is one reconciliation per
   * turn at most, and no more than one per this interval however short the
   * turns are. A burst of one-line turns therefore costs one whole-tree
   * `git status` every fifteen seconds rather than one per turn.
   */
  const RECONCILE_MIN_INTERVAL_MS = 15_000;
  const lastReconcileAt = new Map<string, number>();

  function requestGitRead(
    harnessSessionId: string,
    want: { force: boolean; reconcile: boolean },
  ): void {
    const pending = gitPending.get(harnessSessionId);
    gitPending.set(harnessSessionId, {
      force: want.force || (pending?.force ?? false),
      reconcile: want.reconcile || (pending?.reconcile ?? false),
    });
  }

  /**
   * The git context of one worktree as a whole block, for `noteContext`.
   *
   * Every member is present, holding its value or undefined, because the
   * recorder merges what it is handed and drops the undefined ones. A
   * conditional spread would leave the last branch a session reported
   * standing on every later frame after the checkout went detached, which is
   * a stale fact stated as a current one. This is only ever called with the
   * result of a read that SUCCEEDED: a read that failed is not a report of a
   * detached head or a clean tree, it is no report at all, and it clears
   * nothing.
   */
  function gitContextOf(facts: GitFacts): Record<string, unknown> {
    return {
      git_head_sha: facts.head_sha,
      git_branch: facts.branch,
      git_dirty: facts.dirty,
      git_remote_digest: facts.remote_digest,
    };
  }

  /**
   * Do the pending git reads, then apply what they found.
   *
   * Called from the tick outside `serial.run`, so the spawns are not holding
   * the hook queue. Applying the results is in-memory work and goes back on
   * the queue, because sealing a frame moves a chain a hook may be moving
   * too.
   */
  async function drainGitReads(): Promise<void> {
    if (gitPending.size === 0) return;
    const work = [...gitPending.keys()].slice(0, GIT_READS_PER_TICK);
    const found: Array<{
      session: SessionRecord;
      facts: GitFacts;
      changes?: GitWorkingTreeChange[];
    }> = [];
    for (const harnessSessionId of work) {
      const want = gitPending.get(harnessSessionId);
      gitPending.delete(harnessSessionId);
      if (want === undefined) continue;
      const session = registry.get(harnessSessionId);
      const cwd = session?.cwd;
      if (session === undefined || session.sealed || cwd === undefined)
        continue;
      const facts = gitFactsFor(cwd, want.force);
      // Undefined is "not a repository this host can read", and there is
      // nothing to say about the worktree of a directory that is not one.
      if (facts === undefined) continue;
      const at = now();
      const last = lastReconcileAt.get(harnessSessionId);
      const due =
        want.reconcile &&
        (last === undefined || at - last >= RECONCILE_MIN_INTERVAL_MS);
      if (due) lastReconcileAt.set(harnessSessionId, at);
      found.push({
        session,
        facts,
        ...(due ? { changes: readWorkingTreeChanges(exec, cwd) } : {}),
      });
    }
    if (found.length === 0) return;
    await serial.run(async () => {
      const events: TachoEvent[] = [];
      for (const { session, facts, changes } of found) {
        if (session.sealed) continue;
        session.recorder.noteContext(gitContextOf(facts));
        if (changes === undefined) continue;
        events.push(
          session.recorder.sealCollectorEvent(
            "oxagen:worktree_reconciled",
            worktreeReconciledBody(changes),
          ),
        );
      }
      record(events);
    });
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
   * It is the only trigger.
   *
   * `SubagentStop` is not, because a subagent finishes inside its parent's
   * turn and the parent's own `Stop` observes the same tree once, rather
   * than once per subagent. `SessionEnd` is not either: it seals the chain
   * in the same pass that handles it, and a read that lands a tick later
   * would be sealing a frame onto a chain that has already ended. For Claude
   * Code the last `Stop` precedes it with nothing in between, so the final
   * turn is observed anyway. A session killed without a `Stop` leaves its
   * last turn unobserved, which the record already says with
   * `unobserved_tail` rather than guessing at it.
   *
   * There is no per-tool-call trigger on purpose: `readWorkingTreeChanges`
   * spawns up to four git processes, and paying that on every `Edit` would
   * cost more than the fact is worth.
   */
  const RECONCILE_HOOKS = new Set(["Stop"]);

  async function handleHookInner(
    envelope: HookEnvelope,
  ): Promise<Record<string, unknown>> {
    // The hook asks for the read and does not wait for it: the spawns happen
    // in the tick, off this queue. The facts therefore land on the frames
    // after this one rather than on this one, which is what the recorder's
    // context already is, a standing fact carried until something newer
    // replaces it.
    const payloadFacts = envelope.payload as {
      hook_event_name?: string;
      session_id?: string;
    };
    const hookName = payloadFacts.hook_event_name;
    if (payloadFacts.session_id !== undefined && hookName !== undefined) {
      requestGitRead(payloadFacts.session_id, {
        force: TURN_BOUNDARY_HOOKS.has(hookName),
        reconcile: RECONCILE_HOOKS.has(hookName),
      });
    }
    // After the git read is queued, so the frames the tailer emits are
    // sealed under the same standing context.
    await tailBeforeHook(envelope.payload); // transcript tailer
    const outcome = await handleHookEvent(
      envelope.payload,
      envelope.env ?? {},
      {
        registry,
        policy,
        refreshBundle: async () => {
          await refreshBundle();
        },
        acknowledge: (ack) => {
          pendingAcks.push(ack);
        },
        now,
      },
      envelope.replay,
      envelope.harness,
      envelope.agent,
    );
    record(outcome.events, outcome.bodies);
    return outcome.response;
  }

  /** Replay what `tacho-hook` spooled while the daemon was down, in order. */
  async function drainSpool(): Promise<number> {
    const files = readdirSync(paths.spool)
      .filter((name) => name.endsWith(".json"))
      .sort();
    if (files.length === 0) return 0;
    const gapped = new Map<string, string>();
    for (const name of files) {
      const path = join(paths.spool, name);
      try {
        const file = JSON.parse(readFileSync(path, "utf8")) as SpoolFile;
        if (file.schema !== "tacho.spool.v1")
          throw new Error("not a spool file");
        const sessionId = (file.payload as { session_id?: string }).session_id;
        if (sessionId !== undefined && !gapped.has(sessionId))
          gapped.set(sessionId, file.received_at);
        await handleHookInner(spoolEnvelope(file));
      } catch (error) {
        log(
          `spool file ${name} skipped: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      unlinkSync(path);
    }
    // The http hooks of the same window were lost: chain the gap honestly.
    const gaps: TachoEvent[] = [];
    for (const [sessionId, firstAt] of gapped) {
      const session = registry.get(sessionId);
      if (session === undefined || session.sealed) continue;
      gaps.push(
        session.recorder.sealCollectorEvent("telemetry_gap", {
          gap_cause: "daemon_down",
          gap_duration_ms: Math.max(0, now() - Date.parse(firstAt)),
          incident_kind: "telemetry_gap",
          incident_severity: 1,
        }),
      );
    }
    record(gaps);
    return files.length;
  }

  /**
   * The local MCP gateway (ADR-078). Connected apps have no hook surface, so
   * the only thing Oxagen governs for them is the toolbelt it serves, and the
   * gateway is how it serves one without the app ever holding a credential.
   *
   * Calls land on the daemon's own chain, not a session chain: a connected
   * app has no agent session — no prompt, no model, no turn — and inventing
   * one would put a step in the ledger that nobody took.
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
    record(
      [
        hostRecorder.sealCollectorEvent(
          call.status === "rejected" ? "policy_decision" : "tool_call",
          {
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
          {
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
        ),
      ],
      hostRecorder.takeBodies(),
    );
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
        harnesses: ["claude-code", "codex"],
      });
      const next: Partial<ModelUpstreams> = {};
      for (const entry of state.harnesses) {
        if (entry.previous === null) continue;
        if (entry.harness === "claude-code") next.anthropic = entry.previous;
        else {
          next.openai = entry.previous;
          next.chatgpt = entry.previous;
        }
      }
      displacedUpstreams = next;
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
    policy: () => ({ bundle: host.bundle, hostStatus: host.host_status }),
    upstreams: () => ({
      ...DEFAULT_MODEL_UPSTREAMS,
      ...displacedUpstreams,
      ...options.modelUpstreams,
    }),
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

  /**
   * The real interrupt. A pause, cancel or kill already stops the session at
   * its next hook boundary; here it also cuts the model calls that are in
   * flight, and the proxy refuses new ones until the session is resumed. A
   * steer delivered as `interrupt` cuts the current call so the steer lands
   * at the next boundary instead of after the step finishes.
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
        const cut = modelProxy.abortSession(
          target.recorder.sessionUuid,
          command.reason ?? `operator ${command.command}`,
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

  const api: CollectorApi = {
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
    // queue was never protecting the forward; it was only ever costing.
    mcp: (body, context) => gateway.handle(body, context),
    mcpClose: (sessionId) => gateway.forget(sessionId),
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
          if (created)
            log(
              `session ${sessionId} first seen through OTel; no hook stream yet`,
            );
          record(session.recorder.ingestOtlp(payload as OtlpPayload));
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

  const server = createCollectorServer(api, log);
  let port: number | undefined;
  if (options.listen ?? true) {
    const unixSocket = (options.platform ?? process.platform) !== "win32";
    const listening = await server.listen({
      ...(unixSocket ? { socketPath: paths.socket } : {}),
      port: options.port ?? host.port,
    });
    port = listening.port;
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

  async function tick(): Promise<void> {
    if (stopped) return;
    // The detector runs off the serial queue: its scan is asynchronous file
    // I/O over every project directory, and a hook that arrived while it
    // ran would otherwise wait on it. It records each frame in the same
    // synchronous stretch that seals it, the property the gateway relies on
    // to record off-queue: a model or gateway call sealed on the host chain
    // during the scan must not be appended ahead of an earlier detector frame.
    if (now() - lastDetect >= timers.detectorMs) {
      lastDetect = now();
      await detector.tick((events) => record(events));
    }
    await serial.run(async () => {
      const t = now();
      await drainSpool();
      // transcript tailer: bounded per file per tick, asynchronous reads
      await transcriptTailer.tick();
      if (t - lastSweep >= timers.sweepMs) {
        lastSweep = t;
        record(registry.sweep(isProcessAlive, timers.idleSessionMs));
        registry.forgetSealed(timers.walRetainMs);
      }
      if (t - lastCheckpoint >= timers.checkpointMs) {
        lastCheckpoint = t;
        checkpoint();
      }
      if (stateDirty) persistState();
    });
    // Outside the serial block above on purpose: this is where the git
    // process spawns happen, and a hook must never queue behind them.
    await drainGitReads();
    // Refresh before draining, so a batch carrying bodies leaves under the
    // mandate the control plane holds now rather than the one cached before
    // an outage.
    if (now() - lastRefresh >= timers.bundleRefreshMs) {
      lastRefresh = now();
      await refreshBundle();
      await refreshUpstreams();
    }
    await shipper.drain();
    await sendAcks();
    if (now() - lastCompact >= 60 * 60_000) {
      lastCompact = now();
      wal.compact(now(), timers.walRetainMs);
      sweepQuarantine(now(), timers.walRetainMs);
    }
  }

  let timer: NodeJS.Timeout | undefined;
  let ticking = false;
  if (options.listen ?? true) {
    timer = setInterval(
      () => {
        if (ticking) return;
        ticking = true;
        tick()
          .catch((error) =>
            log(
              `tick failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
          )
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
    drainSpool: () => serial.run(drainSpool),
    refreshBundle,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
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
