/**
 * Unit coverage for the collector pieces the daemon composes: the command
 * inbox, the detector, the exporters, the shipper's failure handling, the
 * registry's sweep and persistence, and the listener's request handling.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  GENESIS_CURSOR,
  sealEvent,
  verifyChain,
  type ChainCursor,
} from "../chain";
import type { ClaudeCodeContext } from "../claude-code/context";
import {
  ControlError,
  ControlUnreachable,
  type ControlClient,
} from "../host/control-client";
import { sessionUuid } from "../ids";
import { mergeTachoSettings } from "../host/settings-writer";
import { scratchPaths, TEST_ENROLLMENT } from "../host/test-support";
import { Wal } from "../host/wal";
import type { TachoEvent, UnsealedTachoEvent } from "../envelope";
import type { FrameBody } from "../evidence/frame-body";
import { minimalSession, sealAll, TEST_HOST, unsealed } from "../test-helpers";
import {
  TACHO_MAX_BATCH,
  base64Size,
  TACHO_MAX_BODY_BYTES,
  TACHO_MAX_REQUEST_BYTES,
  TACHO_REQUEST_ENVELOPE_BYTES,
  type DeliveredCommand,
  type TachoBody,
} from "../wire";
import { Detector, listTranscripts } from "./detector";
import {
  exportOtlpJson,
  exportSession,
  exportTachoNdjson,
  exportTraceNdjson,
} from "./exporters";
import { applyCommands } from "./inbox";
import { SessionRegistry } from "./registry";
import { createRequestHandler, type CollectorApi } from "./server";
import {
  Shipper,
  MAX_BODY_AUTHORITY_WAIT_MS,
  MAX_CONSECUTIVE_QUARANTINES,
  RETENTION_HOLD_LOG_INTERVAL_MS,
} from "./spool";

const CONTEXT: ClaudeCodeContext = {
  agent: {
    agent_key: "acme.core.cc-laptop",
    fleet_id: "wrk_1",
    runtime: "claude-code",
    harness: "claude-code",
    wrapper_version: "2.1.1",
    host_enrollment_id: TEST_ENROLLMENT,
  },
};

function registryWithSession(now: () => number) {
  const registry = new SessionRegistry({
    context: CONTEXT,
    scope: TEST_ENROLLMENT,
    now,
  });
  const { record } = registry.ensure("sess-1", {
    pid: 4242,
    cwd: "/repo",
    transcriptPath: "/t.jsonl",
  });
  record.recorder.sealCollectorEvent("agent_start", {
    session_start_source: "startup",
  });
  const host = registry.ensure("tachod-boot", { pid: process.pid }).record;
  host.recorder.sealCollectorEvent("agent_start", {
    session_start_source: "daemon",
  });
  return { registry, record, host };
}

function command(overrides: Partial<DeliveredCommand>): DeliveredCommand {
  return {
    id: "cmd",
    command: "pause",
    session_uuid: null,
    payload: {},
    requested_mode: null,
    delivery_mode: null,
    degraded_reason: null,
    reason: null,
    issued_at: "2026-09-10T10:00:00.000Z",
    expires_at: null,
    ...overrides,
  };
}

describe("inbox", () => {
  it("applies every command kind and acknowledges with the recording seq", async () => {
    let clock = Date.parse("2026-09-10T10:00:00.000Z");
    const now = () => (clock += 1000);
    const { registry, record, host } = registryWithSession(now);
    const uuid = record.recorder.sessionUuid;
    const kills: string[] = [];
    let refreshed = 0;
    let suspended: string | undefined;
    const deps = {
      registry,
      hostRecorder: () => host.recorder,
      kill: (pid: number, signal: string) => {
        kills.push(`${pid}:${signal}`);
        return signal === "SIGTERM";
      },
      refreshBundle: async () => {
        refreshed += 1;
      },
      onHostSuspended: (reason: string) => {
        suspended = reason;
      },
      now,
    };
    const result = await applyCommands(
      [
        command({
          id: "p",
          command: "pause",
          session_uuid: uuid,
          payload: { reason: "hold" },
        }),
        command({
          id: "m",
          command: "message",
          session_uuid: uuid,
          payload: { message: "wrap up" },
        }),
        command({
          id: "m0",
          command: "message",
          session_uuid: uuid,
          payload: {},
        }),
        command({
          id: "st",
          command: "steer",
          session_uuid: uuid,
          payload: { text: "use staging" },
          requested_mode: "interrupt",
          delivery_mode: "next_step",
          degraded_reason: "harness_tier",
          expires_at: "2026-09-10T11:00:00.000Z",
        }),
        command({ id: "r", command: "resume", session_uuid: uuid }),
        command({ id: "k", command: "kill", session_uuid: uuid }),
        command({ id: "c", command: "cancel", session_uuid: uuid }),
        command({ id: "rb", command: "refresh_bundle", session_uuid: uuid }),
        command({
          id: "x",
          command: "expired",
          session_uuid: uuid,
          expires_at: "2020-01-01T00:00:00.000Z",
        } as never),
        command({
          id: "nf",
          command: "pause",
          session_uuid: "00000000-0000-4000-8000-000000000001",
        }),
        command({ id: "hrb", command: "refresh_bundle" }),
        command({
          id: "hm",
          command: "message",
          payload: { text: "all hands" },
        }),
        // The row's reason travels as `reason`; a row queued before the
        // column existed carries it in the payload.
        command({ id: "hp", command: "pause", reason: "fleet hold" }),
        command({
          id: "hrv",
          command: "revoke",
          payload: { reason: "offboarded" },
        }),
        command({ id: "bad", command: "bogus" as never }),
      ],
      deps,
    );
    const acks = Object.fromEntries(
      result.acknowledgements.map((a) => [a.command_id, a.status]),
    );
    expect(acks).toEqual({
      p: "applied",
      m: "received",
      m0: "failed",
      st: "received",
      r: "applied",
      // SIGKILL was refused, so the kill is not `applied`: the process is
      // still running and `oxagen:kill_attempted` records `failed`.
      k: "failed",
      c: "applied",
      rb: "failed",
      x: "expired",
      nf: "failed",
      hrb: "applied",
      hm: "received",
      hp: "applied",
      hrv: "applied",
      bad: "failed",
    });
    expect(
      result.acknowledgements.find((a) => a.command_id === "x")?.detail,
    ).toMatch(/expired/);
    expect(record.control.paused).toBe("fleet hold");
    expect(record.control.cancelled).toBe("operator cancel");
    expect(record.control.messages.map((m) => m.text)).toEqual([
      "wrap up",
      "use staging",
      "all hands",
    ]);
    expect(record.control.messages[1]).toEqual({
      id: "st",
      text: "use staging",
      issuedAt: "2026-09-10T10:00:00.000Z",
      command: "steer",
      requestedMode: "interrupt",
      deliveryMode: "next_step",
      degradedReason: "harness_tier",
      expiresAt: "2026-09-10T11:00:00.000Z",
    });
    expect(record.control.messages[0]?.expiresAt).toBeNull();
    expect(kills).toEqual(["4242:SIGKILL", "4242:SIGTERM"]);
    expect(refreshed).toBe(1);
    expect(suspended).toBe("offboarded");
    const kinds = result.events.map((e) => e.kind);
    expect(kinds.filter((k) => k === "oxagen:kill_attempted")).toHaveLength(2);
    const killOutcomes = result.events
      .filter((e) => e.kind === "oxagen:kill_attempted")
      .map((e) => (e.body as { kill_outcome: string }).kill_outcome);
    expect(killOutcomes).toEqual(["failed", "sent"]);
    expect(
      result.acknowledgements.find((a) => a.command_id === "p")?.applied_at_seq,
    ).toBe(1);
    expect(
      verifyChain(record.recorder.sealedEvents, { expectGenesis: true })
        .violations,
    ).toEqual([]);
    expect(
      verifyChain(host.recorder.sealedEvents, { expectGenesis: true })
        .violations,
    ).toEqual([]);
    // A session without a pid records no_pid.
    const noPid = registry.ensure("sess-2").record;
    noPid.recorder.sealCollectorEvent("agent_start", {
      session_start_source: "startup",
    });
    const second = await applyCommands(
      [
        command({
          id: "c2",
          command: "cancel",
          session_uuid: noPid.recorder.sessionUuid,
        }),
      ],
      deps,
    );
    expect(
      (second.events[1]?.body as { kill_outcome: string }).kill_outcome,
    ).toBe("no_pid");
    // The acknowledgement reports the same fact as the event beside it.
    const noPidAck = second.acknowledgements.find((a) => a.command_id === "c2");
    expect(noPidAck?.status).toBe("failed");
    expect(noPidAck?.detail).toMatch(/no_pid/);
  });

  it("acknowledges a cancel as applied only when the signal was delivered", async () => {
    let clock = Date.parse("2026-09-10T10:00:00.000Z");
    const now = () => (clock += 1000);
    const { registry, record, host } = registryWithSession(now);
    const deps = {
      registry,
      hostRecorder: () => host.recorder,
      kill: () => true,
      refreshBundle: async () => {},
      onHostSuspended: () => {},
      now,
    };
    const result = await applyCommands(
      [
        command({
          id: "c",
          command: "cancel",
          session_uuid: record.recorder.sessionUuid,
        }),
      ],
      deps,
    );
    const ack = result.acknowledgements.find((a) => a.command_id === "c");
    expect(ack?.status).toBe("applied");
    expect(ack?.detail).toBeUndefined();
    expect(
      result.events
        .filter((e) => e.kind === "oxagen:kill_attempted")
        .map((e) => (e.body as { kill_outcome: string }).kill_outcome),
    ).toEqual(["sent"]);
  });
});

describe("registry", () => {
  it("sweeps dead or idle sessions, persists, and restores chains", () => {
    let clock = Date.parse("2026-09-10T10:00:00.000Z");
    const now = () => clock;
    const { registry, record } = registryWithSession(now);
    const idle = registry.ensure("sess-idle").record;
    idle.recorder.sealCollectorEvent("agent_start", {
      session_start_source: "startup",
    });
    const never = registry.ensure("sess-never-started", { pid: 1 }).record;
    expect(registry.live()).toHaveLength(4);
    expect(registry.byUuid(record.recorder.sessionUuid)?.harnessSessionId).toBe(
      "sess-1",
    );
    expect(
      registry.byUuid("00000000-0000-4000-8000-000000000000"),
    ).toBeUndefined();
    clock += 10 * 60_000;
    const sealed = registry.sweep(
      (pid) => pid !== 4242 && pid !== 1,
      5 * 60_000,
    );
    expect(sealed.map((e) => [e.session_id, e.kind])).toEqual([
      ["sess-1", "agent_stop"],
      ["sess-idle", "agent_stop"],
    ]);
    expect(
      (sealed[0]?.body as { session_outcome: string }).session_outcome,
    ).toBe("crashed");
    expect(record.sealed).toBe(true);
    expect(never.sealed).toBe(true);
    expect(registry.sweep(() => true, 1)).toEqual([]);
    // A queued steer keeps its deadline across a daemon restart, so the
    // boundary after the restart still refuses to inject it past expiry; a
    // state file written before steer carried `{ id, text }` only.
    record.control.messages.push({
      id: "cmd_steer",
      text: "use staging",
      command: "steer",
      requestedMode: "next_step",
      deliveryMode: "next_step",
      degradedReason: null,
      expiresAt: "2026-09-10T11:00:00.000Z",
    });
    const state = registry.state();
    const legacy = state.sessions.find((s) => s.harnessSessionId === "sess-1");
    if (legacy === undefined) throw new Error("no persisted session");
    legacy.control.messages.push({ id: "cmd_old", text: "wrap up" });
    const restored = new SessionRegistry({
      context: CONTEXT,
      scope: TEST_ENROLLMENT,
      now,
    });
    restored.restore(JSON.parse(JSON.stringify(state)) as typeof state);
    const back = restored.get("sess-1");
    expect(back?.recorder.chainCursor).toEqual(record.recorder.chainCursor);
    expect(back?.pid).toBe(4242);
    expect(back?.sealed).toBe(true);
    expect(back?.control.messages).toEqual([
      {
        id: "cmd_steer",
        text: "use staging",
        command: "steer",
        requestedMode: "next_step",
        deliveryMode: "next_step",
        degradedReason: null,
        expiresAt: "2026-09-10T11:00:00.000Z",
      },
      {
        id: "cmd_old",
        text: "wrap up",
        command: "message",
        requestedMode: null,
        deliveryMode: null,
        degradedReason: null,
        expiresAt: null,
      },
    ]);
    const continued = back?.recorder.sealCollectorEvent("oxagen:notification", {
      notification_type: "after-restart",
    });
    expect(continued?.seq).toBe(record.recorder.chainCursor.seq);
    expect(continued?.prev_hash).toBe(record.recorder.chainCursor.prevHash);
    registry.touch("sess-1");
    registry.touch("nope");
    clock += 8 * 24 * 60 * 60_000;
    expect(registry.forgetSealed(7 * 24 * 60 * 60_000)).toEqual(
      expect.arrayContaining(["sess-1", "sess-idle", "sess-never-started"]),
    );
  });
});

describe("detector", () => {
  it("chains hooks_removed and hook_health on transitions, and unobserved transcripts after the grace", async () => {
    const paths = scratchPaths();
    let clock = Date.parse("2026-09-10T10:00:00.000Z");
    const now = () => clock;
    const { registry, host } = registryWithSession(now);
    let settings: unknown = mergeTachoSettings(
      {},
      {
        enrollmentId: TEST_ENROLLMENT,
        hookCommand: "x",
        port: 1,
        localToken: "t",
      },
    ).settings;
    let processes = [{ pid: 9, ppid: 1, command: "claude" }];
    const detector = new Detector({
      registry,
      hostRecorder: () => host.recorder,
      listProcesses: () => processes,
      transcriptRoots: [paths.claudeProjects, join(paths.root, "missing")],
      readSettings: () => settings,
      enrollment: () => ({
        enrollmentId: TEST_ENROLLMENT,
        harnesses: ["claude-code"],
        verified: true,
      }),
      now,
      graceMs: 10_000,
    });
    expect(await detector.tick()).toEqual([]);
    expect(detector.hooksHealthy).toBe(true);
    settings = { hooks: {} };
    const removed = await detector.tick();
    expect(removed.map((e) => e.kind)).toEqual(["oxagen:hooks_removed"]);
    expect(
      (removed[0]?.body as { incident_evidence: { missing: string[] } })
        .incident_evidence.missing.length,
    ).toBeGreaterThan(30);
    expect(await detector.tick()).toEqual([]);
    settings = mergeTachoSettings(
      {},
      {
        enrollmentId: TEST_ENROLLMENT,
        hookCommand: "x",
        port: 1,
        localToken: "t",
      },
    ).settings;
    expect((await detector.tick()).map((e) => e.kind)).toEqual([
      "oxagen:hook_health",
    ]);
    const unreadable = new Detector({
      registry,
      hostRecorder: () => host.recorder,
      listProcesses: () => processes,
      transcriptRoots: [],
      readSettings: () => {
        throw new Error("unreadable");
      },
      enrollment: () => ({
        enrollmentId: TEST_ENROLLMENT,
        harnesses: ["claude-code"],
        verified: true,
      }),
      now,
    });
    expect((await unreadable.tick()).map((e) => e.kind)).toEqual([
      "oxagen:hooks_removed",
    ]);
    expect(await unreadable.tick()).toEqual([]);
    // Transcripts: a known session is ignored; an unknown one is reported once after the grace.
    const project = join(paths.claudeProjects, "-repo");
    mkdirSync(project, { recursive: true });
    const known = join(project, "11111111-1111-4111-8111-111111111111.jsonl");
    const unknown = join(project, "22222222-2222-4222-8222-222222222222.jsonl");
    writeFileSync(join(project, "notes.txt"), "x");
    writeFileSync(known, "{}\n");
    writeFileSync(unknown, "{}\n");
    registry.ensure("11111111-1111-4111-8111-111111111111");
    const stamp = (path: string, at: number) =>
      utimesSync(path, new Date(at), new Date(at));
    stamp(known, clock);
    stamp(unknown, clock);
    expect(
      (await listTranscripts([paths.claudeProjects]))
        .map((t) => t.sessionId)
        .sort(),
    ).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ]);
    expect(await detector.tick()).toEqual([]); // first sighting
    clock += 5_000;
    stamp(unknown, clock);
    expect(await detector.tick()).toEqual([]); // advanced, but inside the grace
    clock += 6_000;
    stamp(unknown, clock);
    const incidents = await detector.tick();
    expect(incidents.map((e) => e.kind)).toEqual(["oxagen:unobserved_session"]);
    expect(
      (
        incidents[0]?.body as {
          incident_evidence: { session_id: string; claude_pids: number[] };
        }
      ).incident_evidence,
    ).toMatchObject({
      session_id: "22222222-2222-4222-8222-222222222222",
      claude_pids: [9],
    });
    expect(detector.unobserved).toEqual([
      "22222222-2222-4222-8222-222222222222",
    ]);
    clock += 1_000;
    stamp(unknown, clock);
    expect(await detector.tick()).toEqual([]); // reported once
    // An old idle transcript from before boot is not an incident.
    const stale = join(project, "33333333-3333-4333-8333-333333333333.jsonl");
    writeFileSync(stale, "{}\n");
    stamp(stale, clock - 60_000);
    processes = [];
    expect(await detector.tick()).toEqual([]);
    expect(
      verifyChain(host.recorder.sealedEvents, { expectGenesis: true })
        .violations,
    ).toEqual([]);
  });

  it("records a hook frame before the scan yields, so a call sealed during the scan appends after it", async () => {
    const paths = scratchPaths();
    const now = () => Date.parse("2026-09-10T10:00:00.000Z");
    const { registry, host } = registryWithSession(now);
    const detector = new Detector({
      registry,
      hostRecorder: () => host.recorder,
      listProcesses: () => [],
      transcriptRoots: [paths.claudeProjects],
      readSettings: () => ({ hooks: {} }),
      enrollment: () => ({
        enrollmentId: TEST_ENROLLMENT,
        harnesses: ["claude-code"],
        verified: true,
      }),
      now,
    });
    // Stands in for the WAL: frames in the order they were appended.
    const appended: TachoEvent[] = [];
    const record = (events: readonly TachoEvent[]) => appended.push(...events);
    const pass = detector.tick(record);
    // The scan has yielded. A model or gateway call lands on the host chain
    // and is recorded off-queue before the detector's promise settles.
    record([
      host.recorder.sealCollectorEvent("oxagen:hook_health", { hook_count: 0 }),
    ]);
    const sealed = await pass;
    expect(sealed.map((e) => e.kind)).toEqual(["oxagen:hooks_removed"]);
    expect(appended.map((e) => e.kind)).toEqual([
      "oxagen:hooks_removed",
      "oxagen:hook_health",
    ]);
    const seqs = appended.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });
});

describe("exporters", () => {
  it("exports tacho NDJSON, a trace journal, and OTLP with GenAI spans", () => {
    const events = minimalSession();
    const ndjson = exportTachoNdjson(events);
    expect(ndjson.trim().split("\n")).toHaveLength(events.length);
    expect(exportTraceNdjson(events)).toContain("session_start");
    const otlp = JSON.parse(exportOtlpJson(events)) as {
      resourceSpans: Array<{
        scopeSpans: Array<{
          spans: Array<{ name: string; attributes: Array<{ key: string }> }>;
        }>;
      }>;
      resourceLogs: Array<{ scopeLogs: Array<{ logRecords: unknown[] }> }>;
    };
    const spans = otlp.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
    expect(spans[0]?.name).toBe("session claude-code");
    expect(spans.some((s) => s.name.startsWith("execute_tool"))).toBe(true);
    expect(spans.some((s) => s.name.startsWith("chat "))).toBe(true);
    expect(
      spans
        .find((s) => s.name.startsWith("chat "))
        ?.attributes.some((a) => a.key === "gen_ai.usage.input_tokens"),
    ).toBe(true);
    expect(otlp.resourceLogs[0]?.scopeLogs[0]?.logRecords).toHaveLength(
      events.length,
    );
    expect(exportSession(events, "tacho")).toBe(ndjson);
    expect(exportSession(events, "otlp")).toContain("resourceSpans");
    expect(() => exportSession(events, "xml" as never)).toThrow(
      /unknown export format/,
    );
    expect(
      JSON.parse(exportOtlpJson([])).resourceSpans[0].scopeSpans[0].spans,
    ).toEqual([]);
  });
});

/**
 * `minimalSession()`, reseeded onto a distinct session uuid.
 *
 * `Wal.append` now refuses to reseal an already-written seq (Tacho collector
 * P0-1), so a volume test that wants many events can no longer fake bulk by
 * appending the same fixture, same session, same seqs, over and over. This
 * keeps every kind and body `minimalSession` already covers and reseals the
 * chain fresh for a session id the caller supplies, so each call is a
 * distinct, independently valid chain.
 */
function distinctSession(id: string): TachoEvent[] {
  const uuid = sessionUuid(TEST_HOST, id);
  let cursor: ChainCursor = GENESIS_CURSOR;
  return minimalSession().map((event) => {
    const sealed = sealEvent(
      {
        ...event,
        session_id: id,
        session_uuid: uuid,
        root_session_uuid: uuid,
      } as unknown as UnsealedTachoEvent,
      cursor,
    );
    cursor = sealed.next;
    return sealed.event;
  });
}

describe("shipper", () => {
  function shipper(
    wal: Wal,
    client: Partial<ControlClient>,
    dir: string,
    now: () => number,
    hostEnrollmentId?: string,
  ) {
    const controls: unknown[] = [];
    const logs: string[] = [];
    const s = new Shipper({
      wal,
      client: client as ControlClient,
      quarantineDir: dir,
      health: () => ({ version: "1" }),
      onControl: (c) => {
        controls.push(c);
      },
      // These cases are about batching, backoff and quarantine, so the mandate
      // is the permissive one and never the thing under test.
      retentionInForce: () => ({
        mandate: {
          mode: "content_exact",
          classes: ["model_call", "tool_call", "approval_receipt"],
        },
        proven: true,
      }),
      log: (l) => logs.push(l),
      now,
      minBackoffMs: 1_000,
      maxBackoffMs: 4_000,
      ...(hostEnrollmentId !== undefined ? { hostEnrollmentId } : {}),
    });
    return { s, controls, logs };
  }

  const okResponse = (events: unknown[]) => ({
    accepted: events.length,
    event_ids: [],
    chain_breaks: [],
    control: {
      host_status: "active" as const,
      deny_generation: { org: 1, workspace: 1 },
      bundle_etag: "e",
      commands: [],
    },
  });

  it("quarantines the single event a refused batch bisects down to", async () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const events = minimalSession();
    wal.append(events);
    const bad = events[2]?.seq;
    const { s, controls, logs } = shipper(
      wal,
      {
        ingest: async (batch) => {
          if (batch.some((e) => e.seq === bad))
            throw new ControlError(400, "seq 2 is malformed");
          return okResponse(batch);
        },
      },
      paths.quarantine,
      () => 0,
    );
    const result = await s.drain();
    expect(result.quarantined).toBe(1);
    expect(result.shipped).toBe(events.length - 1);
    expect(wal.stats().unshipped).toBe(0);
    expect(controls.length).toBeGreaterThan(0);
    expect(logs.some((l) => l.includes("quarantined"))).toBe(true);
  });

  it("keeps a quarantined event's body beside it, after trying the event without it", async () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const events = minimalSession();
    const bad = events[1] as (typeof events)[number];
    wal.append(events, [
      {
        event_id_idem: bad.event_id_idem,
        session_uuid: bad.session_uuid,
        seq: bad.seq,
        content_type: "text/plain; charset=utf-8",
        bytes: new TextEncoder().encode("the prompt the route refused"),
        content_class: "model_call",
      },
    ]);
    const tries: number[] = [];
    const { s } = shipper(
      wal,
      {
        ingest: async (batch, _daemon, bodies = []) => {
          if (batch.some((e) => e.seq === bad.seq)) {
            if (batch.length === 1) tries.push(bodies.length);
            throw new ControlError(422, "refused");
          }
          return okResponse(batch);
        },
      },
      paths.quarantine,
      () => 0,
    );
    const result = await s.drain();
    expect(result.quarantined).toBe(1);
    // Offered alone with its body, then once more without it.
    expect(tries).toEqual([1, 0]);
    const [file] = readdirSync(paths.quarantine).filter((f) =>
      f.endsWith(".json"),
    );
    const record = JSON.parse(
      readFileSync(join(paths.quarantine, file as string), "utf8"),
    ) as { event: { seq: number }; body?: { event_id_idem: string } };
    expect(record.event.seq).toBe(bad.seq);
    expect(record.body?.event_id_idem).toBe(bad.event_id_idem);
  });

  it("stops quarantining and backs off when the control plane refuses everything", async () => {
    // A server regression that answers 400 to every batch must not bisect the
    // whole backlog into quarantine and mark it shipped.
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const sessions = Array.from({ length: 8 }, (_, i) =>
      distinctSession(`refuse-all-${String(i)}`),
    );
    for (const events of sessions) wal.append(events);
    const total = sessions.reduce((sum, events) => sum + events.length, 0);
    expect(total).toBeGreaterThan(MAX_CONSECUTIVE_QUARANTINES);
    const { s, logs } = shipper(
      wal,
      {
        ingest: async () => {
          throw new ControlError(400, "every batch is malformed today");
        },
      },
      paths.quarantine,
      () => 0,
    );
    const result = await s.drain();
    expect(result.quarantined).toBe(MAX_CONSECUTIVE_QUARANTINES);
    expect(wal.stats().unshipped).toBe(total - MAX_CONSECUTIVE_QUARANTINES);
    expect(s.lastError).toContain("every batch is malformed today");
    expect(logs.some((l) => l.includes("holding the rest"))).toBe(true);
  });

  it("spreads a blind backoff by up to a fifth when given jitter", async () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    wal.append(minimalSession());
    let clock = 0;
    const s = new Shipper({
      wal,
      client: {
        ingest: async () => {
          throw new ControlError(500, "down");
        },
      } as unknown as ControlClient,
      quarantineDir: paths.quarantine,
      health: () => ({ version: "1" }),
      onControl: () => undefined,
      retentionInForce: () => ({
        mandate: { mode: "digest_only", classes: [] },
        proven: true,
      }),
      log: () => undefined,
      now: () => clock,
      minBackoffMs: 1_000,
      jitter: () => 0.5,
    });
    await s.drain();
    // 1s of backoff plus half of the 20% spread.
    clock = 1_099;
    expect(s.ready()).toBe(false);
    clock = 1_100;
    expect(s.ready()).toBe(true);
  });

  it("sets aside a session whose root has not landed and ships the others", async () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const early = distinctSession("early-child");
    const ready = distinctSession("ready-root");
    wal.append(early);
    wal.append(ready);
    const earlyUuid = (early[0] as TachoEvent).session_uuid;
    let clock = 0;
    const { s, logs } = shipper(
      wal,
      {
        ingest: async (batch) => {
          if (batch.some((e) => e.session_uuid === earlyUuid))
            throw new ControlError(409, '{"code":"root_session_unrecorded"}');
          return okResponse(batch);
        },
      },
      paths.quarantine,
      () => clock,
    );
    await s.drain();
    await s.drain();
    // The other session shipped; the early one waits, unquarantined.
    expect(wal.stats().unshipped).toBe(early.length);
    expect(
      readdirSync(paths.quarantine).filter((f) => f.endsWith(".json")),
    ).toHaveLength(0);
    expect(logs.some((l) => l.includes("waits"))).toBe(true);
    // Once its wait is over it is offered again.
    clock = 60_000;
    let offered = false;
    const retry = shipper(
      wal,
      {
        ingest: async (batch) => {
          offered ||= batch.some((e) => e.session_uuid === earlyUuid);
          return okResponse(batch);
        },
      },
      paths.quarantine,
      () => clock,
    );
    await retry.s.drain();
    expect(offered).toBe(true);
    expect(wal.stats().unshipped).toBe(0);
  });

  it("drains past a request the route refuses as too large, rather than wedging", async () => {
    // The ingest route caps a request at `TACHO_MAX_REQUEST_BYTES` and answers
    // 413 above it. A retry
    // cannot make a batch smaller, so treating 413 as retryable meant
    // offering the same oversized request on every drain for ever. The WAL
    // head never advanced past it and every later event on the host queued
    // behind it, so that host stopped recording while still reporting
    // itself healthy. This is the test that says it drains instead.
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const events = minimalSession();
    wal.append(events);
    // One event the route will never accept, whatever it is batched with.
    const oversized = events[2]?.seq;
    const { s } = shipper(
      wal,
      {
        ingest: async (batch) => {
          if (batch.some((e) => e.seq === oversized))
            throw new ControlError(413, "Payload Too Large");
          return okResponse(batch);
        },
      },
      paths.quarantine,
      () => 0,
    );
    const result = await s.drain();

    // The one event nobody can ship is set aside, and everything behind it
    // reaches the control plane.
    expect(result.quarantined).toBe(1);
    expect(result.shipped).toBe(events.length - 1);
    // The queue is empty, which is the property that was lost: a wedged host
    // leaves every later event unshipped for ever.
    expect(wal.stats().unshipped).toBe(0);
  });
  it("splits a batch the route refuses as too large, and ships an oversized event without its body", async () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const events = minimalSession();
    const heavy = events[1] as (typeof events)[number];
    wal.append(events, [
      {
        event_id_idem: heavy.event_id_idem,
        session_uuid: heavy.session_uuid,
        seq: heavy.seq,
        content_type: "text/plain; charset=utf-8",
        bytes: new TextEncoder().encode("a retained prompt"),
        content_class: "model_call",
      },
    ]);
    const sent: Array<{ seqs: number[]; bodies: number }> = [];
    const { s, logs } = shipper(
      wal,
      {
        ingest: async (batch, _daemon, bodies = []) => {
          sent.push({ seqs: batch.map((e) => e.seq), bodies: bodies.length });
          // The route refuses any request that carries this body.
          if (bodies.length > 0)
            throw new ControlError(413, "Payload Too Large");
          return okResponse(batch);
        },
      },
      paths.quarantine,
      () => 0,
    );
    const result = await s.drain();
    // Nothing is quarantined and nothing is left behind: the queue moves.
    expect(result.quarantined).toBe(0);
    expect(result.shipped).toBe(events.length);
    expect(wal.stats().unshipped).toBe(0);
    // The last attempt for the heavy event went out alone and bodiless.
    const last = sent.filter((b) => b.seqs.includes(heavy.seq)).at(-1);
    expect(last).toEqual({ seqs: [heavy.seq], bodies: 0 });
    expect(logs.some((l) => l.includes("without its body"))).toBe(true);
  });

  it("does not ship the right half of a 413 split when the left half fails", async () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const events = minimalSession();
    wal.append(events);
    const sent: number[][] = [];
    // Fail every leaf in the lower half; accept every leaf in the upper half.
    // Shipping the upper half first would markShipped past the lower seqs and
    // drop them from the WAL without the control plane ever seeing them.
    const leftCeiling =
      events[Math.ceil(events.length / 2) - 1]?.seq ?? Number.POSITIVE_INFINITY;
    const { s } = shipper(
      wal,
      {
        ingest: async (batch) => {
          sent.push(batch.map((e) => e.seq));
          if (batch.length > 1)
            throw new ControlError(413, "Payload Too Large");
          const seq = batch[0]?.seq;
          if (seq !== undefined && seq <= leftCeiling)
            throw new ControlError(503, "busy");
          return okResponse(batch);
        },
      },
      paths.quarantine,
      () => 0,
    );
    const result = await s.drain();
    expect(result.shipped).toBe(0);
    expect(wal.stats().unshipped).toBe(events.length);
    // No leaf above the left ceiling was attempted: the split stopped.
    expect(
      sent.some(
        (seqs) => seqs.length === 1 && (seqs[0] as number) > leftCeiling,
      ),
    ).toBe(false);
  });

  it("keeps the body caps inside the request budget they are spent against", () => {
    // These numbers are only correct with respect to each other, in both
    // directions. A cap above the budget yields a request nobody can ship.
    // A cap far below it discards recordings for nothing.
    //
    // The earlier version of this test hardcoded the route's limit as a
    // literal, which is how the drift got through: the route moved from a
    // hardcoded 1 MiB to the host's own ceiling, the caps stayed sized for
    // the old number, and the test went on agreeing with the copy rather
    // than the source. It asserts against the real constant now.
    const batchBudget = TACHO_MAX_REQUEST_BYTES - TACHO_REQUEST_ENVELOPE_BYTES;
    expect(base64Size(TACHO_MAX_BODY_BYTES)).toBeLessThan(
      TACHO_MAX_REQUEST_BYTES,
    );
    expect(base64Size(TACHO_MAX_BODY_BYTES)).toBeLessThan(batchBudget);
    // A full batch of bodies has to leave room for the events carrying
    // them, so a body at the cap may not fill the budget on its own.
    expect(base64Size(TACHO_MAX_BODY_BYTES)).toBeLessThan(batchBudget * 0.8);
    // And the budget is not so far above the cap that bodies a workspace
    // pays to keep are discarded while the request had room for them.
    expect(base64Size(TACHO_MAX_BODY_BYTES)).toBeGreaterThan(batchBudget * 0.2);
  });

  // ── Orphaned events after a re-enrollment ──────────────────────────────────
  //
  // Re-enrolling mints a new host_enrollment_id and leaves whatever is still
  // spooled stamped with the old one. The control plane 403s a batch if ANY
  // event in it names a different host, and a 403 is retryable (a revoked key
  // is also a 403), so one orphaned event at the head of the WAL wedges the
  // queue forever. A real host had five enrollment ids in one WAL and 30,206
  // of 45,135 events unshippable, with nothing drained since the first
  // re-enrollment.

  it("quarantines events from a previous enrollment instead of wedging the queue", async () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const events = minimalSession();
    // Stamp the whole session with an enrollment this host no longer has.
    const orphaned = events.map((e) => ({
      ...e,
      agent: { ...e.agent, host_enrollment_id: "tch_previous_enrollment" },
    })) as typeof events;
    wal.append(orphaned);

    const shipped: number[] = [];
    const { s, logs } = shipper(
      wal,
      {
        ingest: async (batch) => {
          shipped.push(batch.length);
          return okResponse(batch);
        },
      },
      paths.quarantine,
      () => 0,
      "tch_current_enrollment",
    );

    const result = await s.drain();
    // Nothing was sent — every event belonged to the old enrollment — and the
    // WAL advanced past them rather than offering them again forever.
    expect(shipped).toHaveLength(0);
    expect(result.quarantined).toBe(orphaned.length);
    expect(wal.stats().unshipped).toBe(0);
    expect(logs.some((l) => l.includes("previous enrollment"))).toBe(true);
  });

  it("sets aside a session the control plane holds under another host and ships the rest", async () => {
    // A re-enrollment mid-session: the live session's new events carry this
    // host's id, but the control plane recorded the session under the old
    // host and refuses any batch holding it with 403. Retrying stopped every
    // other session queued behind it.
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const mine = minimalSession();
    const spanning = minimalSession().map((e) => ({
      ...e,
      session_uuid: `${e.session_uuid}-spanning`,
    })) as typeof mine;
    wal.append(spanning);
    wal.append(mine);

    const accepted: string[] = [];
    let calls = 0;
    const { s, logs } = shipper(
      wal,
      {
        ingest: async (batch) => {
          calls += 1;
          if (batch.some((e) => e.session_uuid.endsWith("-spanning")))
            throw new ControlError(
              403,
              '{"error":{"code":"forbidden","message":"Forbidden: session belongs to another host"}}',
            );
          accepted.push(...batch.map((e) => `${e.session_uuid}#${e.seq}`));
          return okResponse(batch);
        },
      },
      paths.quarantine,
      () => 0,
      mine[0]?.agent.host_enrollment_id,
    );

    const result = await s.drain();
    expect(result.shipped).toBe(mine.length);
    expect(result.quarantined).toBe(spanning.length);
    expect(accepted).toHaveLength(mine.length);
    expect(wal.stats().unshipped).toBe(0);
    expect(s.lastError).toBeUndefined();
    expect(logs.some((l) => l.includes("under another host"))).toBe(true);

    // Later events of that session are set aside without being offered.
    const before = calls;
    const later = minimalSession().map((e) => ({
      ...e,
      session_uuid: spanning[0]?.session_uuid as string,
      seq: e.seq + spanning.length,
    })) as typeof mine;
    wal.append(later);
    const again = await s.drain();
    expect(calls).toBe(before);
    expect(again.quarantined).toBe(later.length);
    expect(wal.stats().unshipped).toBe(0);
  });

  it("keeps retrying a 403 that is not about session ownership", async () => {
    // A revoked or denied key is also a 403, and quarantining on it would
    // throw away every queued event on the host.
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const events = minimalSession();
    wal.append(events);
    const { s } = shipper(
      wal,
      {
        ingest: async () => {
          throw new ControlError(
            403,
            '{"error":{"code":"forbidden","message":"Forbidden"}}',
          );
        },
      },
      paths.quarantine,
      () => 0,
    );
    const result = await s.drain();
    expect(result.quarantined).toBe(0);
    expect(wal.stats().unshipped).toBe(events.length);
  });

  it("still ships this host's own events in a batch that also held orphans", async () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const mine = minimalSession();
    wal.append(mine);
    const theirs = minimalSession().map((e) => ({
      ...e,
      session_uuid: `${e.session_uuid}-old`,
      agent: { ...e.agent, host_enrollment_id: "tch_previous_enrollment" },
    })) as typeof mine;
    wal.append(theirs);

    let sentTotal = 0;
    const { s } = shipper(
      wal,
      {
        ingest: async (batch) => {
          sentTotal += batch.length;
          return okResponse(batch);
        },
      },
      paths.quarantine,
      () => 0,
      mine[0]?.agent.host_enrollment_id,
    );

    const result = await s.drain();
    expect(sentTotal).toBe(mine.length);
    expect(result.shipped).toBe(mine.length);
    expect(result.quarantined).toBe(theirs.length);
    expect(wal.stats().unshipped).toBe(0);
  });

  // ── Rate-limit awareness (throughput under many agents) ────────────────────
  //
  // One tachod carries every agent on a machine — 222 sessions on the machine
  // that prompted this — so agent count becomes event volume, not request
  // volume, and the batching absorbs it. What does not absorb is a backlog:
  // 45,000 spooled events are 226 batches, and `drain()` used to fire them
  // back to back, spend a per-minute ceiling in seconds, and then take a 429
  // for every batch after it while blind exponential backoff climbed to its
  // cap. The server already says what is left and how long to wait; these
  // tests pin that the daemon listens.

  it("waits exactly as long as a 429 asked, without escalating its own backoff", async () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    wal.append(minimalSession());
    let clock = 0;
    const { s } = shipper(
      wal,
      {
        ingest: async () => {
          throw new ControlError(429, "rate_limited", undefined, {
            retryAfterMs: 3_000,
          });
        },
      },
      paths.quarantine,
      () => clock,
    );

    await s.drain();
    // minBackoffMs is 1s here; the server said 3s, and the server wins.
    clock = 2_999;
    expect(s.ready()).toBe(false);
    clock = 3_000;
    expect(s.ready()).toBe(true);

    // A second 429 asking the same wait gets the same wait — obeying a ceiling
    // is not a degrading control plane and must not ratchet the blind backoff.
    await s.drain();
    clock = 6_000;
    expect(s.ready()).toBe(true);
  });

  it("never returns sooner than a 503 asked, and still escalates its backoff", async () => {
    // #3662. The ingest route answers 503 with `Retry-After` when ClickHouse
    // refuses the write under pressure. Unlike a 429, repeated backpressure is
    // the store degrading rather than the limiter working, so the server's
    // number is a floor under the backoff, not a replacement for it.
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    wal.append(minimalSession());
    let clock = 0;
    const { s } = shipper(
      wal,
      {
        ingest: async () => {
          throw new ControlError(503, "store_overloaded", undefined, {
            retryAfterMs: 3_000,
          });
        },
      },
      paths.quarantine,
      () => clock,
    );

    // minBackoffMs is 1s, so without the floor the host would come back at 1s
    // and be refused again for two seconds the server had already named.
    await s.drain();
    clock = 2_999;
    expect(s.ready()).toBe(false);
    clock = 3_000;
    expect(s.ready()).toBe(true);

    // The backoff escalated underneath: 1s doubled to 2s, then 4s, and once it
    // passes the floor it is what decides the wait.
    await s.drain();
    clock = 6_000;
    expect(s.ready()).toBe(true);
    await s.drain();
    clock = 6_000 + 3_999;
    expect(s.ready()).toBe(false);
    clock = 6_000 + 4_000;
    expect(s.ready()).toBe(true);
  });

  it("falls back to X-RateLimit-Reset when a 429 carries no Retry-After", async () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    wal.append(minimalSession());
    let clock = 0;
    const { s } = shipper(
      wal,
      {
        ingest: async () => {
          throw new ControlError(429, "rate_limited", undefined, {
            resetAtMs: Date.now() + 8_000,
          });
        },
      },
      paths.quarantine,
      () => clock,
    );
    await s.drain();
    // Past maxBackoffMs (4s), so blind exponential backoff would already be
    // ready here. Only the server's reset hint keeps it waiting at 5s.
    clock = 5_000;
    expect(s.ready()).toBe(false);
  });

  it("stops draining when the server reports the window is spent", async () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    // Enough events to need more than one batch: TACHO_MAX_BATCH is 200, so an
    // unpaced drain would issue several requests back to back. That burst is
    // precisely what a real backlog does and what the pacing has to stop.
    // Each iteration is its own session (`Wal.append` now refuses to reseal
    // an already-written seq, Tacho collector P0-1, so 60 sessions rather
    // than the same fixture appended 60 times).
    for (let i = 0; i < 60; i += 1)
      wal.append(distinctSession(`vol-window-${i}`));
    const before = wal.stats().unshipped;
    expect(before).toBeGreaterThan(TACHO_MAX_BATCH);

    let calls = 0;
    const { s } = shipper(
      wal,
      {
        ingest: async (batch) => {
          calls += 1;
          // The first response says this was the last request in the window.
          s.noteRateLimit({ remaining: 0, resetAtMs: 60_000 });
          return okResponse(batch);
        },
      },
      paths.quarantine,
      () => 0,
    );

    // One request, not a loop: the drain stopped the moment the server said the
    // window was spent, instead of firing every remaining batch into a 429.
    // `shipped` must be non-zero — without it this assertion is also satisfied
    // by the batch FAILING once, which is how it would pass against a Shipper
    // that has no noteRateLimit at all.
    const result = await s.drain();
    expect(calls).toBe(1);
    expect(result.shipped).toBeGreaterThan(0);
    // Held until the window turns over, then free to continue.
    expect(s.ready()).toBe(false);
  });

  it("drains without pacing when the server sends no rate-limit headers", async () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    for (let i = 0; i < 3; i += 1)
      wal.append(distinctSession(`vol-nopace-${i}`));
    let calls = 0;
    const { s } = shipper(
      wal,
      {
        ingest: async (batch) => {
          calls += 1;
          return okResponse(batch);
        },
      },
      paths.quarantine,
      () => 0,
    );
    await s.drain();
    expect(calls).toBeGreaterThan(0);
    expect(wal.stats().unshipped).toBe(0);
  });

  it("ships each event once when two drains overlap", async () => {
    // The daemon's interval tick, a caller's tick() and stop() all drain, and
    // none waits on the others. Two drains that both read the batch before
    // either marked it shipped sent a window of frames twice (#3782).
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    wal.append(minimalSession());
    const sent: number[] = [];
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { s } = shipper(
      wal,
      {
        ingest: async (batch) => {
          sent.push(...batch.map((e) => e.seq));
          await held;
          return okResponse(batch);
        },
      },
      paths.quarantine,
      () => 0,
    );
    const first = s.drain();
    const second = s.drain();
    await new Promise((resolve) => setTimeout(resolve, 10));
    release?.();
    await Promise.all([first, second]);
    expect(sent).toEqual([...new Set(sent)].sort((a, b) => a - b));
    expect(sent.length).toBe(minimalSession().length);
    expect(wal.stats().unshipped).toBe(0);
  });

  it("ships events appended mid-drain once, and the chain verifies", async () => {
    // tachod starts a drain from its interval tick, from a tick a caller
    // drives, and from stop(), and nothing stopped two of them reading the
    // same unshipped tail while the first one's ingest was still awaited.
    // Both sent it, so the control plane saw seq 144 arrive after seq 145 on
    // a chain that was dense in the WAL (#3782).
    //
    // Each drain stops after one batch here, because the stub reports the
    // rate window as spent. Without that, the first drain's own loop would
    // ship the late events and the second drain would find nothing to do,
    // so a drain() that merely shared the one in flight would still pass.
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const events = minimalSession();
    const split = Math.ceil(events.length / 2);
    wal.append(events.slice(0, split));
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ingested: TachoEvent[] = [];
    const { s } = shipper(
      wal,
      {
        ingest: async (batch) => {
          await held;
          ingested.push(...batch);
          // A spent window ends each drain after this batch. resetAtMs 0
          // keeps ready() true, because the clock below reads 0.
          s.noteRateLimit({ remaining: 0, resetAtMs: 0 });
          return okResponse(batch);
        },
      },
      paths.quarantine,
      () => 0,
    );

    const a = s.drain();
    // Let the first drain reach its ingest request.
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Written after the first drain read the WAL, so only a later read ships
    // it. The second drain has to wait for the first, then ship it itself.
    wal.append(events.slice(split));
    const b = s.drain();
    await new Promise((resolve) => setTimeout(resolve, 20));
    release?.();
    const [first, second] = await Promise.all([a, b]);

    expect(first.shipped).toBe(split);
    expect(second.shipped).toBe(events.length - split);

    const ids = ingested.map((event) => event.event_id_idem);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(events.length);
    expect(wal.stats().unshipped).toBe(0);
    expect(verifyChain(ingested, { expectGenesis: true }).violations).toEqual(
      [],
    );
  });

  it("backs off exponentially on transport failure and retries after a 5xx", async () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    wal.append(minimalSession());
    let clock = 0;
    let attempts = 0;
    const { s } = shipper(
      wal,
      {
        ingest: async (batch) => {
          attempts += 1;
          if (attempts === 1)
            throw new ControlUnreachable(new Error("ECONNREFUSED"));
          if (attempts === 2) throw new ControlError(503, "busy");
          return okResponse(batch);
        },
      },
      paths.quarantine,
      () => clock,
    );
    expect((await s.shipOnce()).reachable).toBe(false);
    expect(s.ready()).toBe(false);
    expect(await s.shipOnce()).toMatchObject({ shipped: 0 });
    clock = 1_000;
    expect((await s.shipOnce()).reachable).toBe(true); // 503: reachable, but nothing shipped
    expect(s.lastError).toContain("503");
    clock = 1_000 + 2_000;
    expect((await s.shipOnce()).shipped).toBeGreaterThan(0);
    expect(s.reachable).toBe(true);
    expect(s.lastError).toBeUndefined();
    expect(await s.shipOnce()).toMatchObject({ shipped: 0, quarantined: 0 });
  });

  // ── Frame bodies ───────────────────────────────────────────────────────────
  //
  // A body must ship in the same request as its event: the control plane
  // refuses one naming an event it did not receive in that batch
  // (`unknown_event`). So the shipper reads the batch's bodies from the WAL,
  // sends them as `bodies`, keeps a bisected half's bodies with its events,
  // and cuts a batch where its bodies would pass the byte budget.

  function bodyFor(
    event: TachoEvent,
    text: string,
    contentClass: FrameBody["content_class"] = "model_call",
  ): FrameBody {
    return {
      event_id_idem: event.event_id_idem,
      session_uuid: event.session_uuid,
      seq: event.seq,
      content_type: "text/plain; charset=utf-8",
      bytes: new TextEncoder().encode(text),
      content_class: contentClass,
    };
  }

  it("ships each body in the batch that carries its event", async () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const events = minimalSession();
    const prompt = events[1] as TachoEvent;
    wal.append(events, [bodyFor(prompt, "the prompt")]);
    const sent: Array<{
      events: TachoEvent[];
      bodies: TachoBody[] | undefined;
    }> = [];
    const { s } = shipper(
      wal,
      {
        ingest: async (batch, _daemon, bodies) => {
          sent.push({ events: batch as TachoEvent[], bodies });
          return okResponse(batch);
        },
      },
      paths.quarantine,
      () => 0,
    );
    await s.drain();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.bodies).toEqual([
      {
        event_id_idem: prompt.event_id_idem,
        content_type: "text/plain; charset=utf-8",
        bytes_base64: Buffer.from("the prompt").toString("base64"),
      },
    ]);
    expect(
      sent[0]?.events.some((e) => e.event_id_idem === prompt.event_id_idem),
    ).toBe(true);
  });

  it("keeps a bisected half's bodies with its events", async () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const events = minimalSession();
    const prompt = events[1] as TachoEvent;
    // `turn_end`, not the closing `agent_stop`: a body only exists for a kind
    // the retention table classifies, and the ship-time gate drops one whose
    // kind names no class. A fixture that hung a body on `agent_stop` was
    // testing a body the recorder never writes.
    const last = events[6] as TachoEvent;
    wal.append(events, [bodyFor(prompt, "p"), bodyFor(last, "l")]);
    const bad = events[2]?.seq;
    const sent: Array<{
      events: TachoEvent[];
      bodies: TachoBody[] | undefined;
    }> = [];
    const { s } = shipper(
      wal,
      {
        ingest: async (batch, _daemon, bodies) => {
          if (batch.some((e) => e.seq === bad))
            throw new ControlError(400, "seq 2 is malformed");
          sent.push({ events: batch as TachoEvent[], bodies });
          return okResponse(batch);
        },
      },
      paths.quarantine,
      () => 0,
    );
    await s.drain();
    expect(sent.length).toBeGreaterThan(1);
    for (const request of sent) {
      const idems = new Set(request.events.map((e) => e.event_id_idem));
      for (const body of request.bodies ?? [])
        expect(idems.has(body.event_id_idem)).toBe(true);
    }
    const shippedBodies = sent.flatMap((r) => r.bodies ?? []);
    expect(shippedBodies.map((b) => b.event_id_idem).sort()).toEqual(
      [prompt.event_id_idem, last.event_id_idem].sort(),
    );
  });

  it("cuts a batch where the encoded request would pass the route's limit", async () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const events = minimalSession();
    // Three bodies at the 1 MiB cap are 3 MiB raw, under the 4 MiB request
    // limit, but about 4.2 MB once base64-encoded. Measured raw, all three
    // would ship in one request the route refuses with 413. Measured on the
    // wire, the third waits for the next batch with its event.
    const full = "x".repeat(TACHO_MAX_BODY_BYTES);
    // Hung on classified kinds (`turn_start`, `llm_call`, `tool_requested`):
    // the opening `agent_start` has no retention class, so the ship-time gate
    // would drop its body and the cut under test would never happen.
    wal.append(events, [
      bodyFor(events[1] as TachoEvent, full),
      bodyFor(events[2] as TachoEvent, full),
      bodyFor(events[3] as TachoEvent, full, "tool_call"),
    ]);
    const sent: Array<{
      events: TachoEvent[];
      bodies: TachoBody[] | undefined;
    }> = [];
    const { s } = shipper(
      wal,
      {
        ingest: async (batch, daemon, bodies) => {
          const request = JSON.stringify({
            schema: "tacho/1.0",
            host_enrollment_id: "hen_x",
            events: batch,
            bodies,
            daemon,
          });
          expect(Buffer.byteLength(request)).toBeLessThanOrEqual(
            TACHO_MAX_REQUEST_BYTES,
          );
          sent.push({ events: batch as TachoEvent[], bodies });
          return okResponse(batch);
        },
      },
      paths.quarantine,
      () => 0,
    );
    const result = await s.drain();
    expect(result.shipped).toBe(events.length);
    expect(sent).toHaveLength(2);
    expect(sent[0]?.events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(sent[0]?.bodies).toHaveLength(2);
    expect(sent[1]?.events[0]?.seq).toBe(3);
    expect(sent[1]?.bodies).toHaveLength(1);
    expect(wal.stats().unshipped).toBe(0);
  });

  it("bisects a batch the route refuses as too large instead of retrying it", async () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const events = minimalSession();
    wal.append(events);
    const sizes: number[] = [];
    const { s } = shipper(
      wal,
      {
        ingest: async (batch) => {
          sizes.push(batch.length);
          if (batch.length > 2)
            throw new ControlError(413, "Payload Too Large");
          return okResponse(batch);
        },
      },
      paths.quarantine,
      () => 0,
    );
    const result = await s.drain();
    expect(result.shipped).toBe(events.length);
    expect(result.quarantined).toBe(0);
    expect(sizes[0]).toBe(events.length);
    expect(wal.stats().unshipped).toBe(0);
  });

  it("ships a lone event without its body when the body makes it too large", async () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const events = minimalSession();
    const prompt = events[1] as TachoEvent;
    wal.append(events, [bodyFor(prompt, "a body the route will not take")]);
    const shippedWithout: string[] = [];
    const { s } = shipper(
      wal,
      {
        ingest: async (batch, _daemon, bodies) => {
          if ((bodies ?? []).length > 0)
            throw new ControlError(413, "Payload Too Large");
          for (const e of batch) shippedWithout.push(e.event_id_idem);
          return okResponse(batch);
        },
      },
      paths.quarantine,
      () => 0,
    );
    const result = await s.drain();
    expect(result.shipped).toBe(events.length);
    expect(result.quarantined).toBe(0);
    expect(shippedWithout).toContain(prompt.event_id_idem);
    expect(wal.stats().unshipped).toBe(0);
  });

  it("quarantines a lone event the route refuses as too large on its own", async () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const events = minimalSession();
    wal.append(events);
    const big = events[2]?.seq;
    const { s } = shipper(
      wal,
      {
        ingest: async (batch) => {
          if (batch.some((e) => e.seq === big))
            throw new ControlError(413, "Payload Too Large");
          return okResponse(batch);
        },
      },
      paths.quarantine,
      () => 0,
    );
    const result = await s.drain();
    expect(result.quarantined).toBe(1);
    expect(result.shipped).toBe(events.length - 1);
    expect(wal.stats().unshipped).toBe(0);
  });

  it("does not ship a queued body the mandate no longer covers", async () => {
    // The leak this guards: a body appended under `content_exact` waits in
    // the WAL through an outage, the workspace narrows to `digest_only`, and
    // the drain sends it anyway. The control plane refuses it, which protects
    // the record and not the machine — the prompt has already left.
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const events = minimalSession();
    const prompt = events[1] as TachoEvent;
    wal.append(events, [bodyFor(prompt, "the prompt")]);
    const sent: Array<readonly TachoBody[] | undefined> = [];
    const s = new Shipper({
      wal,
      client: {
        ingest: async (
          batch: TachoEvent[],
          _health: unknown,
          bodies?: readonly TachoBody[],
        ) => {
          sent.push(bodies);
          return okResponse(batch);
        },
      } as unknown as ControlClient,
      quarantineDir: paths.quarantine,
      health: () => ({ version: "1" }),
      onControl: () => undefined,
      // Narrowed since the append, and proven, so this also purges.
      retentionInForce: () => ({
        mandate: { mode: "digest_only", classes: [] },
        proven: true,
      }),
      log: () => undefined,
      now: () => 0,
    });
    await s.drain();
    // The events still ship; only the bytes stay home.
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((b) => b === undefined || b.length === 0)).toBe(true);
    expect(wal.stats().unshipped).toBe(0);
    // And the bytes do not stay home: a narrowed mandate reaches the disk.
    // Omitting the body from the request alone would leave the prompt in the
    // WAL until the session sealed and aged out.
    expect(wal.bodiesFor(events)).toEqual([]);
  });

  /** What `<session>.bodies.jsonl` holds for a session, or "" when gone. */
  function bodyFileText(walDir: string, sessionUuid: string): string {
    const path = join(walDir, `${sessionUuid}.bodies.jsonl`);
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  }

  it("purges a withheld body from the WAL when the narrowing is proven", async () => {
    // Withholding protects the network boundary and nothing else. The bytes
    // sit in `<session>.bodies.jsonl` until the session seals, ships and ages
    // out, so an unsealed session would keep prompt content the workspace has
    // already withdrawn authority for, readable by anything running as this
    // user. `docs/specs/gateway/spec.md` requires the narrowing to drop what
    // is already on disk.
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const events = minimalSession();
    const prompt = events[1] as TachoEvent;
    wal.append(events, [bodyFor(prompt, "the secret prompt")]);
    expect(bodyFileText(paths.wal, prompt.session_uuid)).toContain(
      Buffer.from("the secret prompt").toString("base64"),
    );
    const s = new Shipper({
      wal,
      client: {
        ingest: async (batch: TachoEvent[]) => okResponse(batch),
      } as unknown as ControlClient,
      quarantineDir: paths.quarantine,
      health: () => ({ version: "1" }),
      onControl: () => undefined,
      retentionInForce: () => ({
        mandate: { mode: "digest_only", classes: [] },
        proven: true,
      }),
      log: () => undefined,
      now: () => 0,
    });
    await s.drain();
    // Not merely unshipped: gone from disk, bytes and all.
    expect(wal.bodiesFor([prompt])).toEqual([]);
    expect(bodyFileText(paths.wal, prompt.session_uuid)).not.toContain(
      Buffer.from("the secret prompt").toString("base64"),
    );
  });

  it("keeps a withheld body when the mandate cannot be proven", async () => {
    // The other half, and the reason the two are distinguished. A control
    // plane outage lapses every cached bundle at once. If withholding alone
    // purged, an outage would destroy the queued evidence of every session on
    // the host — permanent loss, committed by the component whose job is the
    // record, on a condition that usually clears at the next poll.
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const events = minimalSession();
    const prompt = events[1] as TachoEvent;
    wal.append(events, [bodyFor(prompt, "the secret prompt")]);
    const sent: Array<readonly TachoBody[] | undefined> = [];
    const s = new Shipper({
      wal,
      client: {
        ingest: async (
          batch: TachoEvent[],
          _health: unknown,
          bodies?: readonly TachoBody[],
        ) => {
          sent.push(bodies);
          return okResponse(batch);
        },
      } as unknown as ControlClient,
      quarantineDir: paths.quarantine,
      health: () => ({ version: "1" }),
      onControl: () => undefined,
      // NO_RETENTION because nothing can be shown to be covered, which is not
      // the workspace narrowing anything.
      retentionInForce: () => ({
        mandate: { mode: "digest_only", classes: [] },
        proven: false,
      }),
      log: () => undefined,
      now: () => 0,
    });
    await s.drain();
    // Withheld from the wire, kept on disk.
    expect(sent.every((b) => b === undefined || b.length === 0)).toBe(true);
    expect(bodyFileText(paths.wal, prompt.session_uuid)).toContain(
      Buffer.from("the secret prompt").toString("base64"),
    );
  });

  it("holds the session suffix, drains another session, then sends the retained body when authority returns", async () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const events = sealAll([
      unsealed("agent_start", { session_start_source: "startup" }),
      ...Array.from({ length: TACHO_MAX_BATCH + 5 }, () =>
        unsealed("turn_start", { prompt_length: 8 }),
      ),
    ]);
    const prompt = events[1]!;
    const other = sealAll([
      unsealed(
        "agent_start",
        { session_start_source: "startup" },
        { session_uuid: "ffffffff-ffff-4fff-8fff-ffffffffffff" },
      ),
    ]);
    wal.append(events, [bodyFor(prompt, "retained")]);
    wal.append(other);
    let proven = false;
    let clock = Date.parse(prompt.ts) + 1_000;
    const sent: TachoEvent[][] = [];
    const bodies: TachoBody[] = [];
    const log: string[] = [];
    const shipper = new Shipper({
      wal,
      client: {
        ingest: async (
          batch: TachoEvent[],
          _health: unknown,
          body: TachoBody[],
        ) => {
          sent.push(batch);
          bodies.push(...body);
          return okResponse(batch);
        },
      } as unknown as ControlClient,
      quarantineDir: paths.quarantine,
      health: () => ({ version: "1" }),
      onControl: () => undefined,
      retentionInForce: () => ({
        mandate: proven
          ? { mode: "content_exact", classes: ["model_call", "tool_call"] }
          : { mode: "digest_only", classes: [] },
        proven,
      }),
      now: () => clock,
      log: (line) => log.push(line),
    });
    await shipper.drain();
    expect(wal.shippedThrough(prompt.session_uuid)).toBe(0);
    expect(
      wal.unshipped(TACHO_MAX_BATCH + 10).map((event) => event.seq),
    ).toEqual(events.slice(1).map((event) => event.seq));
    expect(
      sent
        .flat()
        .some((event) => event.session_uuid === other[0]!.session_uuid),
    ).toBe(true);
    expect(bodies).toHaveLength(0);
    expect(log.filter((line) => line.includes("retention: held"))).toHaveLength(
      1,
    );
    await shipper.drain();
    clock += RETENTION_HOLD_LOG_INTERVAL_MS - 1;
    await shipper.drain();
    expect(log.filter((line) => line.includes("retention: held"))).toHaveLength(
      1,
    );
    // The hold is a zero-progress path on a one-second tick, so the line is
    // rate limited rather than written per drain (#3676).
    clock += 1;
    await shipper.drain();
    expect(log.filter((line) => line.includes("retention: held"))).toHaveLength(
      2,
    );
    proven = true;
    await shipper.drain();
    expect(wal.stats().unshipped).toBe(0);
    expect(bodies.map((body) => body.event_id_idem)).toEqual([
      prompt.event_id_idem,
    ]);
  });

  it("releases expired withheld events after a restart without transmitting their bodies", async () => {
    const paths = scratchPaths();
    const initial = new Wal(paths.wal);
    const events = minimalSession();
    const prompt = events[1]!;
    initial.append(events, [bodyFor(prompt, "retained")]);
    const wal = new Wal(paths.wal);
    const bodies: TachoBody[] = [];
    const log: string[] = [];
    const shipper = new Shipper({
      wal,
      client: {
        ingest: async (
          batch: TachoEvent[],
          _health: unknown,
          body: TachoBody[],
        ) => {
          bodies.push(...body);
          return okResponse(batch);
        },
      } as unknown as ControlClient,
      quarantineDir: paths.quarantine,
      health: () => ({ version: "1" }),
      onControl: () => undefined,
      retentionInForce: () => ({
        mandate: { mode: "digest_only", classes: [] },
        proven: false,
      }),
      now: () => Date.parse(prompt.ts) + MAX_BODY_AUTHORITY_WAIT_MS,
      log: (line) => log.push(line),
    });
    await shipper.drain();
    expect(wal.stats().unshipped).toBe(0);
    expect(bodies).toHaveLength(0);
    expect(wal.bodiesFor([prompt])).toHaveLength(1);
    expect(
      log.some((line) => line.includes("releasing 1 event(s) body-missing")),
    ).toBe(true);
  });

  it("still ships a queued body the mandate does cover", async () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const events = minimalSession();
    const prompt = events[1] as TachoEvent;
    wal.append(events, [bodyFor(prompt, "the prompt")]);
    const sent: TachoBody[] = [];
    const s = new Shipper({
      wal,
      client: {
        ingest: async (
          batch: TachoEvent[],
          _health: unknown,
          bodies?: readonly TachoBody[],
        ) => {
          sent.push(...(bodies ?? []));
          return okResponse(batch);
        },
      } as unknown as ControlClient,
      quarantineDir: paths.quarantine,
      health: () => ({ version: "1" }),
      onControl: () => undefined,
      retentionInForce: () => ({
        mandate: {
          mode: "content_exact",
          classes: ["model_call", "tool_call"],
        },
        proven: true,
      }),
      log: () => undefined,
      now: () => 0,
    });
    await s.drain();
    expect(sent.some((b) => b.event_id_idem === prompt.event_id_idem)).toBe(
      true,
    );
  });

  it("surfaces the bodies the control plane refused", async () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const events = minimalSession();
    const prompt = events[1] as TachoEvent;
    wal.append(events, [bodyFor(prompt, "the prompt")]);
    const refused: unknown[] = [];
    const s = new Shipper({
      wal,
      client: {
        ingest: async (batch: TachoEvent[]) => ({
          ...okResponse(batch),
          body_rejections: [
            { event_id_idem: prompt.event_id_idem, reason: "digest_mismatch" },
          ],
        }),
      } as unknown as ControlClient,
      quarantineDir: paths.quarantine,
      health: () => ({ version: "1" }),
      onControl: () => undefined,
      onBodyRejection: (rejections) => refused.push(...rejections),
      retentionInForce: () => ({
        mandate: { mode: "content_exact", classes: ["model_call"] },
        proven: true,
      }),
      log: () => undefined,
      now: () => 0,
    });
    await s.drain();
    expect(refused).toEqual([
      { event_id_idem: prompt.event_id_idem, reason: "digest_mismatch" },
    ]);
    // The events were accepted: the WAL moved on.
    expect(wal.stats().unshipped).toBe(0);
  });
});

describe("request handler", () => {
  it("routes, authorizes, and reports failures without a live socket", async () => {
    const calls: string[] = [];
    const handler = createRequestHandler(
      {
        localToken: "tok",
        enrollmentId: TEST_ENROLLMENT,
        handleHook: async (envelope) => {
          calls.push(`hook:${JSON.stringify(envelope)}`);
          if ((envelope.payload as { boom?: boolean }).boom)
            throw new Error("boom");
          return { ok: true };
        },
        handleOtlp: async (signal) => {
          calls.push(`otlp:${signal}`);
        },
        health: () => ({ ok: true }),
        status: () => ({ status: 1 }),
        sessions: () => [{ session_id: "s" }],
        exportSession: (key, format) =>
          key === "s" ? `${format}-export` : undefined,
      },
      (line) => calls.push(`log:${line}`),
    );
    const { EventEmitter } = await import("node:events");
    async function call(
      method: string,
      url: string,
      body?: string,
      headers: Record<string, string> = { authorization: "Bearer tok" },
    ) {
      const req =
        new EventEmitter() as never as import("node:http").IncomingMessage;
      Object.assign(req, { method, url, headers, destroy: () => undefined });
      let status = 0;
      let text = "";
      const res = {
        writeHead: (code: number) => {
          status = code;
        },
        end: (chunk: string) => {
          text = chunk;
        },
      } as never as import("node:http").ServerResponse;
      handler(req, res);
      if (body !== undefined) req.emit("data", Buffer.from(body));
      req.emit("end");
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { status, text };
    }
    expect(await call("GET", "/health", undefined, {})).toMatchObject({
      status: 401,
    });
    expect(
      await call("GET", "/health", undefined, { authorization: "Bearer nope" }),
    ).toMatchObject({ status: 401 });
    expect(await call("GET", "/health")).toMatchObject({
      status: 200,
      text: '{"ok":true}',
    });
    expect(await call("GET", "/status")).toMatchObject({ status: 200 });
    expect(await call("GET", "/sessions")).toMatchObject({ status: 200 });
    expect(await call("GET", "/sessions/s/export?format=otlp")).toMatchObject({
      status: 200,
      text: "otlp-export",
    });
    expect(await call("GET", "/sessions/x/export")).toMatchObject({
      status: 404,
    });
    expect(await call("DELETE", "/health")).toMatchObject({ status: 405 });
    expect(await call("POST", "/hook", "{not json")).toMatchObject({
      status: 400,
    });
    expect(await call("POST", "/hook", '{"a":1}')).toMatchObject({
      status: 200,
      text: '{"ok":true}',
    });
    expect(
      await call(
        "POST",
        `/hook/${TEST_ENROLLMENT}`,
        '{"payload":{"a":1},"env":{}}',
        { authorization: "Bearer tok", "x-tacho-envelope": "1" },
      ),
    ).toMatchObject({ status: 200 });
    expect(calls.at(-1)).toBe('hook:{"payload":{"a":1},"env":{}}');
    expect(
      await call("POST", "/hook/tch_zzzzzzzzzzzzzzzzzzzzzz", "{}"),
    ).toMatchObject({ status: 403 });
    expect(await call("POST", "/v1/metrics", "{}")).toMatchObject({
      status: 200,
    });
    expect(calls).toContain("otlp:metrics");
    expect(await call("POST", "/elsewhere", "{}")).toMatchObject({
      status: 404,
    });
    // A daemon booted without the credential seam (ADR-143) issues no run
    // tokens, and says so as a 404 rather than a refusal a harness would
    // read as "the key is wrong".
    expect(
      await call("POST", "/credential/issue", '{"harness":"claude-code"}'),
    ).toMatchObject({
      status: 404,
      text: '{"error":"this daemon issues no run tokens"}',
    });
    expect(await call("POST", "/hook", '{"boom":true}')).toMatchObject({
      status: 500,
    });
    expect(
      calls.some((c) => c.startsWith("log:request POST /hook failed: boom")),
    ).toBe(true);
  });

  it("hands /credential/issue to the issuer and returns its status verbatim", async () => {
    const seen: unknown[] = [];
    const handler = createRequestHandler(
      {
        localToken: "tok",
        enrollmentId: TEST_ENROLLMENT,
        handleHook: async () => ({ ok: true }),
        handleOtlp: async () => undefined,
        health: () => ({ ok: true }),
        status: () => ({}),
        sessions: () => [],
        exportSession: () => undefined,
        issueRunToken: (input) => {
          seen.push(input);
          return {
            status: 403,
            body: { error: "no custody", code: "credential_unavailable" },
          };
        },
      },
      () => undefined,
    );
    const { EventEmitter } = await import("node:events");
    const req =
      new EventEmitter() as never as import("node:http").IncomingMessage;
    Object.assign(req, {
      method: "POST",
      url: "/credential/issue",
      headers: { authorization: "Bearer tok" },
      destroy: () => undefined,
    });
    let status = 0;
    let text = "";
    const res = {
      writeHead: (code: number) => {
        status = code;
      },
      end: (chunk: string) => {
        text = chunk;
      },
    } as never as import("node:http").ServerResponse;
    handler(req, res);
    req.emit("data", Buffer.from('{"harness":"codex","placement":"static"}'));
    req.emit("end");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(seen).toEqual([{ harness: "codex", placement: "static" }]);
    expect(status).toBe(403);
    expect(JSON.parse(text)).toEqual({
      error: "no custody",
      code: "credential_unavailable",
    });
  });
});

/**
 * `/contained/run` (ADR-152) streams NDJSON: one line per chunk of the
 * agent's output, then one line with the result or the launcher's error.
 * Served over a real loopback listener, because the route writes, ends and
 * listens for `close` on the response in ways a hand-built double would only
 * imitate.
 */
describe("the contained-run route", () => {
  function api(runContained?: CollectorApi["runContained"]): CollectorApi {
    return {
      localToken: "tok",
      enrollmentId: TEST_ENROLLMENT,
      handleHook: async () => ({}),
      handleOtlp: async () => undefined,
      health: () => ({}),
      status: () => ({}),
      sessions: () => [],
      exportSession: () => undefined,
      ...(runContained !== undefined ? { runContained } : {}),
    };
  }

  async function serve(collector: CollectorApi, log = vi.fn()) {
    const server = createServer(createRequestHandler(collector, log));
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("no test listener");
    const close = () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    return { url: `http://127.0.0.1:${address.port}`, close, log };
  }

  const REQUEST = {
    workspace: "/work/repo",
    harness: "claude-code",
    args: [],
    image: "img",
  };

  async function post(url: string, body: unknown, token = "tok") {
    const response = await fetch(`${url}/contained/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return {
      status: response.status,
      type: response.headers.get("content-type"),
      lines: text
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as unknown),
    };
  }

  it("answers 404 on a daemon built without a contained runner", async () => {
    const { url, close } = await serve(api());
    try {
      const response = await fetch(`${url}/contained/run`, {
        method: "POST",
        headers: { authorization: "Bearer tok" },
        body: JSON.stringify(REQUEST),
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: "Contained execution is unavailable",
      });
    } finally {
      await close();
    }
  });

  it("streams the agent's output and then the result", async () => {
    const run = vi.fn<NonNullable<CollectorApi["runContained"]>>(
      async (_input, output) => {
        output("stdout", "working\n");
        output("stderr", "warn\n");
        return {
          sessionId: "contained-x",
          exitCode: 3,
          measurement: {} as never,
        };
      },
    );
    const { url, close } = await serve(api(run));
    try {
      const answer = await post(url, REQUEST);
      expect(answer.status).toBe(200);
      expect(answer.type).toBe("application/x-ndjson");
      expect(answer.lines).toEqual([
        { stream: "stdout", text: "working\n" },
        { stream: "stderr", text: "warn\n" },
        { result: { sessionId: "contained-x", exitCode: 3, measurement: {} } },
      ]);
      expect(run.mock.calls[0]?.[0]).toEqual(REQUEST);
      expect(run.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
    } finally {
      await close();
    }
  });

  it("ends with the launcher's own error, cut to 1000 characters, and logs it whole", async () => {
    const long = `Contained execution requires an unprivileged Linux runner with Docker ${"x".repeat(1500)}`;
    const { url, close, log } = await serve(
      api(async (_input, output) => {
        output("stdout", "partial\n");
        throw new Error(long);
      }),
    );
    try {
      const answer = await post(url, REQUEST);
      // The stream has already started, so the status stays 200 and the
      // failure is the last line.
      expect(answer.status).toBe(200);
      expect(answer.lines).toEqual([
        { stream: "stdout", text: "partial\n" },
        { error: long.slice(0, 1000) },
      ]);
      expect(log).toHaveBeenCalledWith(`Contained execution failed: ${long}`);
    } finally {
      await close();
    }
  });

  it("reports a thrown non-Error as text", async () => {
    const { url, close } = await serve(
      api(async () => {
        throw "docker exited 125";
      }),
    );
    try {
      expect((await post(url, REQUEST)).lines).toEqual([
        { error: "docker exited 125" },
      ]);
    } finally {
      await close();
    }
  });

  it("refuses a caller without the local token before any run", async () => {
    const run = vi.fn<NonNullable<CollectorApi["runContained"]>>();
    const { url, close } = await serve(api(run));
    try {
      expect((await post(url, REQUEST, "nope")).status).toBe(401);
      expect(run).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it("aborts the run when the caller disconnects", async () => {
    let signal: AbortSignal | undefined;
    const { url, close } = await serve(
      api(
        (_input, output, given) =>
          new Promise((_resolve, reject) => {
            signal = given;
            output("stdout", "started\n");
            given?.addEventListener("abort", () =>
              reject(new Error("Contained run cancelled")),
            );
          }),
      ),
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const call = request(`${url}/contained/run`, {
          method: "POST",
          headers: { authorization: "Bearer tok" },
        });
        call.on("response", (response) => {
          response.once("data", () => {
            call.destroy();
            resolve();
          });
        });
        call.on("error", () => undefined);
        call.on("close", () => resolve());
        call.end(JSON.stringify(REQUEST));
        setTimeout(() => reject(new Error("no first line")), 5000).unref();
      });
      await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    } finally {
      await close();
    }
  });
});
