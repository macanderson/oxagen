/**
 * Unit coverage for the collector pieces the daemon composes: the command
 * inbox, the detector, the exporters, the shipper's failure handling, the
 * registry's sweep and persistence, and the listener's request handling.
 */
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyChain } from "../chain";
import type { ClaudeCodeContext } from "../claude-code/context";
import {
  ControlError,
  ControlUnreachable,
  type ControlClient,
} from "../host/control-client";
import { mergeTachoSettings } from "../host/settings-writer";
import { scratchPaths, TEST_ENROLLMENT } from "../host/test-support";
import { Wal } from "../host/wal";
import type { TachoEvent } from "../envelope";
import type { FrameBody } from "../evidence/frame-body";
import { minimalSession } from "../test-helpers";
import {
  TACHO_MAX_BATCH,
  TACHO_MAX_BATCH_BODY_BYTES,
  TACHO_MAX_BODY_BYTES,
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
import { createRequestHandler } from "./server";
import { Shipper } from "./spool";

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
      k: "applied",
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
      enrollmentId: TEST_ENROLLMENT,
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
      enrollmentId: TEST_ENROLLMENT,
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
      enrollmentId: TEST_ENROLLMENT,
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

  it("drains past a request the route refuses as too large, rather than wedging", async () => {
    // The ingest route caps a request at 1 MiB and answers 413. A retry
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

  it("keeps a body cap that a single request can actually carry", () => {
    // These three numbers are only correct with respect to each other. A
    // body cap above what the route accepts does not yield a rejected body,
    // it yields a request nobody can ship.
    const ROUTE_LIMIT = 1_048_576;
    const base64 = (bytes: number) => Math.ceil(bytes / 3) * 4;
    expect(base64(TACHO_MAX_BODY_BYTES)).toBeLessThan(ROUTE_LIMIT);
    expect(base64(TACHO_MAX_BATCH_BODY_BYTES)).toBeLessThan(ROUTE_LIMIT);
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
    for (let i = 0; i < 60; i += 1) wal.append(minimalSession());
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
    for (let i = 0; i < 3; i += 1) wal.append(minimalSession());
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
    const last = events[events.length - 1] as TachoEvent;
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

  it("cuts a batch where its bodies would pass the byte budget", async () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const events = minimalSession();
    // Three bodies of 2 MiB against a 4 MiB budget: the third must wait for
    // the next batch, and the event it belongs to waits with it.
    const half = "x".repeat(TACHO_MAX_BATCH_BODY_BYTES / 2);
    wal.append(events, [
      bodyFor(events[0] as TachoEvent, half),
      bodyFor(events[1] as TachoEvent, half),
      bodyFor(events[2] as TachoEvent, half),
    ]);
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
    const result = await s.drain();
    expect(result.shipped).toBe(events.length);
    expect(sent).toHaveLength(2);
    expect(sent[0]?.events.map((e) => e.seq)).toEqual([0, 1]);
    expect(sent[0]?.bodies).toHaveLength(2);
    expect(sent[1]?.events[0]?.seq).toBe(2);
    expect(sent[1]?.bodies).toHaveLength(1);
    expect(wal.stats().unshipped).toBe(0);
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
    expect(await call("POST", "/hook", '{"boom":true}')).toMatchObject({
      status: 500,
    });
    expect(
      calls.some((c) => c.startsWith("log:request POST /hook failed: boom")),
    ).toBe(true);
  });
});
