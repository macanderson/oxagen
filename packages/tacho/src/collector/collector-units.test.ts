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
import { minimalSession } from "../test-helpers";
import type { DeliveredCommand } from "../wire";
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
        command({ id: "hp", command: "pause" }),
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
      result.acknowledgements.map((a) => [a.command_id, a.outcome]),
    );
    expect(acks).toEqual({
      p: "applied",
      m: "delivered",
      m0: "failed",
      r: "applied",
      k: "applied",
      c: "applied",
      rb: "failed",
      x: "expired",
      nf: "failed",
      hrb: "applied",
      hm: "delivered",
      hp: "applied",
      hrv: "applied",
      bad: "failed",
    });
    expect(record.control.paused).toBe("operator pause");
    expect(record.control.cancelled).toBe("operator cancel");
    expect(record.control.messages.map((m) => m.text)).toEqual([
      "wrap up",
      "all hands",
    ]);
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
    const state = registry.state();
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
  it("chains hooks_removed and hook_health on transitions, and unobserved transcripts after the grace", () => {
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
    expect(detector.tick()).toEqual([]);
    expect(detector.hooksHealthy).toBe(true);
    settings = { hooks: {} };
    const removed = detector.tick();
    expect(removed.map((e) => e.kind)).toEqual(["oxagen:hooks_removed"]);
    expect(
      (removed[0]?.body as { incident_evidence: { missing: string[] } })
        .incident_evidence.missing.length,
    ).toBeGreaterThan(30);
    expect(detector.tick()).toEqual([]);
    settings = mergeTachoSettings(
      {},
      {
        enrollmentId: TEST_ENROLLMENT,
        hookCommand: "x",
        port: 1,
        localToken: "t",
      },
    ).settings;
    expect(detector.tick().map((e) => e.kind)).toEqual(["oxagen:hook_health"]);
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
    expect(unreadable.tick().map((e) => e.kind)).toEqual([
      "oxagen:hooks_removed",
    ]);
    expect(unreadable.tick()).toEqual([]);
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
      listTranscripts([paths.claudeProjects])
        .map((t) => t.sessionId)
        .sort(),
    ).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ]);
    expect(detector.tick()).toEqual([]); // first sighting
    clock += 5_000;
    stamp(unknown, clock);
    expect(detector.tick()).toEqual([]); // advanced, but inside the grace
    clock += 6_000;
    stamp(unknown, clock);
    const incidents = detector.tick();
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
    expect(detector.tick()).toEqual([]); // reported once
    // An old idle transcript from before boot is not an incident.
    const stale = join(project, "33333333-3333-4333-8333-333333333333.jsonl");
    writeFileSync(stale, "{}\n");
    stamp(stale, clock - 60_000);
    processes = [];
    expect(detector.tick()).toEqual([]);
    expect(
      verifyChain(host.recorder.sealedEvents, { expectGenesis: true })
        .violations,
    ).toEqual([]);
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
