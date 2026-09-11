/**
 * `tachod`: the per-host collector (spec section 3). Composes the listener,
 * the session registry, the WAL, the shipper, the command inbox, the
 * detector, and the checkpoint signer around one host file. Everything with
 * a side effect is injectable so the whole daemon runs in a test against a
 * fake control plane and a scratch `TACHO_HOME`.
 */
import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { type ClaudeCodeContext, digestText } from "../claude-code/context";
import { normalizeOtlp, type OtlpPayload } from "../claude-code/otel";
import type { SessionRecorder } from "../claude-code/recorder";
import type { TachoEvent } from "../envelope";
import { verifyBundle } from "../host/bundle";
import {
  createControlClient,
  type ControlClient,
  type FetchLike,
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
} from "../host/host-file";
import type { TachoPaths } from "../host/paths";
import { isProcessAlive, listClaudeProcesses } from "../host/process-scan";
import type { Exec } from "../host/service";
import { Wal } from "../host/wal";
import { ulid } from "../ids";
import { toProtocolTimestamp } from "../timestamp";
import type {
  CommandAcknowledgement,
  ControlEnvelope,
  DaemonHealth,
} from "../wire";
import { Detector } from "./detector";
import { exportSession, type ExportFormat } from "./exporters";
import {
  handleHookEvent,
  type HookReplay,
  type PolicyView,
} from "./hook-handler";
import { applyCommands } from "./inbox";
import { type RegistryState, SessionRegistry } from "./registry";
import {
  type CollectorApi,
  createCollectorServer,
  type HookEnvelope,
} from "./server";
import { Shipper } from "./spool";

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
  kill?: (pid: number, signal: "SIGTERM" | "SIGKILL") => boolean;
  transcriptRoots?: string[];
}

export interface DaemonHandle {
  api: CollectorApi;
  registry: SessionRegistry;
  wal: Wal;
  shipper: Shipper;
  detector: Detector;
  hostRecorder: SessionRecorder;
  host: () => HostFile;
  port: number | undefined;
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
}

function defaultExec(command: string, args: string[]): ReturnType<Exec> {
  const result = spawnSync(command, args, { encoding: "utf8" });
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
  const persisted = readJsonFileIfExists(paths.daemonState) as
    | RegistryState
    | undefined;
  if (persisted?.schema === "tacho.daemon-state.v1")
    registry.restore(persisted);

  // The daemon's own chain: host-level incidents, commands, and checkpoints
  // land here so every event the host emits belongs to a verifiable session.
  const bootId = `tachod-${ulid(now())}`;
  const hostRecord = registry.ensure(bootId, { pid: process.pid }).record;
  const hostRecorder = hostRecord.recorder;

  let bundleVerified = verifyBundle(host.bundle, host.bundle_public_key_pem).ok;
  let lastControlAt: number | undefined;
  let lastOtlpAt: number | undefined;
  let lastIngestAt: number | undefined;
  let stateDirty = false;
  let stopped = false;
  const pendingAcks: CommandAcknowledgement[] = [];
  const serial = new Serial();

  const client: ControlClient = createControlClient({
    endpoints: host.endpoints,
    apiKey: host.api_key,
    hostEnrollmentId: host.host_enrollment_id,
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    userAgent: `tachod/${host.wrapper_version}`,
  });

  function persistState(): void {
    writeSensitiveFileAtomic(
      paths.daemonState,
      JSON.stringify(registry.state()),
    );
    stateDirty = false;
  }

  function record(events: readonly TachoEvent[]): void {
    if (events.length === 0) return;
    wal.append(events);
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
    };
  }

  function policy(): PolicyView {
    const current = host as HostFile;
    return {
      bundle: current.bundle,
      verified: bundleVerified,
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
      if (response.not_modified || response.bundle === null) return false;
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
    if (control.bundle_etag !== host.bundle.etag) await refreshBundle();
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
    }
  }

  const shipper = new Shipper({
    wal,
    client,
    quarantineDir: paths.quarantine,
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
    log,
    now,
  });

  const detector = new Detector({
    registry,
    hostRecorder: () => hostRecorder,
    listProcesses: () => listClaudeProcesses(exec),
    transcriptRoots: options.transcriptRoots ?? [paths.claudeProjects],
    readSettings: () => readJsonFileIfExists(paths.claudeSettings) ?? {},
    enrollmentId: host.host_enrollment_id,
    now,
  });

  async function sendAcks(): Promise<void> {
    if (
      pendingAcks.length === 0 &&
      lastIngestAt !== undefined &&
      now() - lastIngestAt < timers.commandsPollMs
    ) {
      return;
    }
    const acks = pendingAcks.splice(0, 100);
    try {
      const { spool_oldest_at: _o, bundle_etag: _e, ...daemon } = health();
      const response = await client.commands(acks, daemon);
      await onControl(response.control);
    } catch (error) {
      pendingAcks.unshift(...acks);
      log(
        `command poll failed: ${error instanceof Error ? error.message : String(error)}`,
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
    replay: {
      receivedAt: file.received_at,
      ...(file.evaluation !== undefined ? { evaluation: file.evaluation } : {}),
    },
  });

  async function handleHookInner(
    envelope: HookEnvelope,
  ): Promise<Record<string, unknown>> {
    const outcome = await handleHookEvent(
      envelope.payload,
      envelope.env ?? {},
      {
        registry,
        policy,
        refreshBundle: async () => {
          await refreshBundle();
        },
        onMessageDelivered: (commandId, sessionUuid, seq) => {
          pendingAcks.push({
            command_id: commandId,
            outcome: "applied",
            session_uuid: sessionUuid,
            applied_at_seq: seq,
          });
        },
        now,
      },
      envelope.replay,
    );
    record(outcome.events);
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

  const api: CollectorApi = {
    localToken: host.local_token,
    enrollmentId: host.host_enrollment_id,
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
      hooks: detector.presence ?? null,
      unobserved_sessions: detector.unobserved,
      sessions: registry.list().map((session) => ({
        session_id: session.harnessSessionId,
        session_uuid: session.recorder.sessionUuid,
        seq: session.recorder.chainCursor.seq,
        sealed: session.sealed,
        ambient: session.ambient,
        paused: session.control.paused,
        cancelled: session.control.cancelled,
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
    const listening = await server.listen({
      socketPath: paths.socket,
      port: options.port ?? host.port,
    });
    port = listening.port;
    log(`listening on ${paths.socket} and 127.0.0.1:${port ?? "?"}`);
  }

  let lastRefresh = 0;
  let lastDetect = 0;
  let lastCheckpoint = 0;
  let lastSweep = 0;
  let lastCompact = 0;

  async function tick(): Promise<void> {
    if (stopped) return;
    await serial.run(async () => {
      const t = now();
      await drainSpool();
      if (t - lastDetect >= timers.detectorMs) {
        lastDetect = t;
        record(detector.tick());
      }
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
    await shipper.drain();
    if (now() - lastRefresh >= timers.bundleRefreshMs) {
      lastRefresh = now();
      await refreshBundle();
    }
    await sendAcks();
    if (now() - lastCompact >= 60 * 60_000) {
      lastCompact = now();
      wal.compact(now(), timers.walRetainMs);
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
    hostRecorder,
    host: () => host,
    port,
    tick,
    drainSpool: () => serial.run(drainSpool),
    refreshBundle,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
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
