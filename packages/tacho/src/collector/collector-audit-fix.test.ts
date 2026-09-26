/**
 * Regression cases for the collector audit: the listener survives a request
 * target `new URL` refuses and keeps export ids inside the WAL directory; the
 * command inbox leaves ended sessions and the daemon's own chain alone, seals
 * nothing across the bundle refresh it awaits, and reports which commands
 * took effect; the control client reads a missing rate-limit header as no
 * hint; and the OTLP export names the model call's provider.
 */
import { request } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { ClaudeCodeContext } from "../claude-code/context";
import {
  createControlClient,
  type RateLimitHint,
} from "../host/control-client";
import { TEST_ENROLLMENT } from "../host/test-support";
import { sealAll, unsealed } from "../test-helpers";
import type { DeliveredCommand } from "../wire";
import { exportOtlpJson } from "./exporters";
import { applyCommands, type InboxDeps } from "./inbox";
import { SessionRegistry } from "./registry";
import {
  type CollectorApi,
  type CollectorServer,
  createCollectorServer,
} from "./server";

const TOKEN = "local-token-0123456789abcdef";

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

describe("collector listener", () => {
  let server: CollectorServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  async function start(exported: string[] = []): Promise<number> {
    const api: CollectorApi = {
      localToken: TOKEN,
      enrollmentId: TEST_ENROLLMENT,
      handleHook: async () => ({}),
      handleOtlp: async () => undefined,
      health: () => ({ ok: true }),
      status: () => ({}),
      sessions: () => [],
      exportSession: (key) => {
        exported.push(key);
        return key === "sess-1" ? "exported" : undefined;
      },
    };
    server = createCollectorServer(api);
    const { port } = await server.listen({ port: 0, host: "127.0.0.1" });
    if (port === undefined) throw new Error("no test port");
    return port;
  }

  function raw(port: number, text: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = connect(port, "127.0.0.1");
      let reply = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        reply += chunk;
      });
      socket.on("end", () => resolve(reply));
      socket.on("error", reject);
      socket.write(text);
    });
  }

  function get(port: number, path: string): Promise<{ status: number }> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path,
          method: "GET",
          headers: { authorization: `Bearer ${TOKEN}` },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  it("answers 400 to a request target the URL parser refuses and keeps serving", async () => {
    const port = await start();
    const reply = await raw(
      port,
      "GET http://x:99999/ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
    );
    expect(reply.startsWith("HTTP/1.1 400")).toBe(true);
    expect(reply).toContain("invalid request target");
    expect((await get(port, "/health")).status).toBe(200);
  });

  it("refuses an export id that decodes to a path", async () => {
    const exported: string[] = [];
    const port = await start(exported);
    for (const id of [
      "..%2F..%2Fetc%2Fpasswd",
      "a%2Fb",
      "a%5Cb",
      "%2E%2E%5Cx",
      ".hidden",
      "%E0%A4%A",
    ]) {
      expect((await get(port, `/sessions/${id}/export`)).status).toBe(400);
    }
    expect(exported).toEqual([]);
    expect((await get(port, "/sessions/sess-1/export")).status).toBe(200);
    expect(
      (
        await get(
          port,
          "/sessions/340ed354-6344-4727-9f8b-1e40b5e12aa7/export?format=otlp",
        )
      ).status,
    ).toBe(404);
    expect(exported).toEqual([
      "sess-1",
      "340ed354-6344-4727-9f8b-1e40b5e12aa7",
    ]);
  });
});

describe("command inbox", () => {
  function setup() {
    let clock = Date.parse("2026-09-10T10:00:00.000Z");
    const now = () => (clock += 1000);
    const registry = new SessionRegistry({
      context: CONTEXT,
      scope: TEST_ENROLLMENT,
      now,
    });
    const host = registry.ensure("tachod-boot", { pid: process.pid }).record;
    host.recorder.sealCollectorEvent("agent_start", {
      session_start_source: "daemon",
    });
    const agent = registry.ensure("sess-1", { pid: 4242 }).record;
    agent.recorder.sealCollectorEvent("agent_start", {
      session_start_source: "startup",
    });
    const kills: string[] = [];
    let refreshes = 0;
    const deps: InboxDeps = {
      registry,
      hostRecorder: () => host.recorder,
      kill: (pid, signal) => {
        kills.push(`${pid}:${signal}`);
        return true;
      },
      refreshBundle: async () => {
        refreshes += 1;
      },
      onHostSuspended: () => undefined,
      now,
    };
    return { registry, host, agent, kills, deps, refreshes: () => refreshes };
  }

  it("refuses a command for an ended session and signals nothing", async () => {
    const { registry, agent, kills, deps } = setup();
    registry.seal(agent);
    const before = agent.recorder.sealedEvents.length;
    const result = await applyCommands(
      [
        command({
          id: "k",
          command: "kill",
          session_uuid: agent.recorder.sessionUuid,
        }),
        command({
          id: "p",
          command: "pause",
          session_uuid: agent.recorder.sessionUuid,
        }),
      ],
      deps,
    );
    expect(kills).toEqual([]);
    expect(result.events).toEqual([]);
    expect(agent.recorder.sealedEvents.length).toBe(before);
    expect(result.acknowledgements).toEqual([
      { command_id: "k", status: "failed", detail: "session has ended" },
      { command_id: "p", status: "failed", detail: "session has ended" },
    ]);
    expect(result.applied).toEqual([]);
  });

  // #2953: a host-level command that reached no agent session acknowledged
  // `applied` against a frame on the daemon's own chain, which claimed a steer
  // was applied when no agent read it.
  it("fails a host-level command that reaches no agent session and seals nothing", async () => {
    const { registry, host, agent, deps } = setup();
    registry.seal(agent);
    const before = host.recorder.sealedEvents.length;
    const result = await applyCommands(
      [
        command({
          id: "hs",
          command: "steer",
          payload: { text: "Skip the mobile repo." },
        }),
        command({ id: "hp", command: "pause" }),
      ],
      deps,
    );
    expect(result.acknowledgements).toEqual([
      {
        command_id: "hs",
        status: "failed",
        detail: "no live agent session on this host",
      },
      {
        command_id: "hp",
        status: "failed",
        detail: "no live agent session on this host",
      },
    ]);
    expect(result.events).toEqual([]);
    expect(result.applied).toEqual([]);
    expect(host.recorder.sealedEvents.length).toBe(before);
    expect(host.control.messages).toEqual([]);
  });

  it("still acknowledges a host-level steer an agent session queued", async () => {
    const { agent, deps } = setup();
    const result = await applyCommands(
      [
        command({
          id: "hs",
          command: "steer",
          payload: { text: "Skip the mobile repo." },
        }),
      ],
      deps,
    );
    expect(result.acknowledgements.map((a) => a.status)).toEqual([
      "received",
    ]);
    expect(agent.control.messages.map((m) => m.id)).toEqual(["hs"]);
  });

  it("never signals the daemon's own pid", async () => {
    const { registry, host, agent, kills, deps } = setup();
    const hostLevel = await applyCommands(
      [
        command({ id: "hc", command: "cancel" }),
        command({ id: "hk", command: "kill" }),
      ],
      deps,
    );
    // The fan-out reaches the agent session and skips the daemon's chain.
    expect(kills).toEqual(["4242:SIGTERM", "4242:SIGKILL"]);
    expect(host.control.cancelled).toBeNull();
    expect(agent.control.cancelled).toBe("operator kill");
    expect(hostLevel.acknowledgements.map((a) => a.status)).toEqual([
      "applied",
      "applied",
    ]);
    // A command aimed at the daemon's chain itself is refused.
    const direct = await applyCommands(
      [
        command({
          id: "dk",
          command: "kill",
          session_uuid: host.recorder.sessionUuid,
        }),
      ],
      deps,
    );
    expect(direct.acknowledgements).toEqual([
      { command_id: "dk", status: "failed", detail: "not an agent session" },
    ]);
    // An agent record that somehow carries the daemon's pid is not signalled.
    const odd = registry.ensure("sess-odd", { pid: process.pid }).record;
    odd.recorder.sealCollectorEvent("agent_start", {
      session_start_source: "startup",
    });
    const guarded = await applyCommands(
      [
        command({
          id: "ok",
          command: "kill",
          session_uuid: odd.recorder.sessionUuid,
        }),
      ],
      deps,
    );
    expect(kills).toEqual(["4242:SIGTERM", "4242:SIGKILL"]);
    expect(guarded.acknowledgements[0]?.status).toBe("failed");
    expect(
      guarded.events
        .filter((e) => e.kind === "oxagen:kill_attempted")
        .map((e) => (e.body as { kill_outcome: string }).kill_outcome),
    ).toEqual(["failed"]);
  });

  it("returns only the commands that took effect", async () => {
    const { registry, agent, deps } = setup();
    const noPid = registry.ensure("sess-no-pid").record;
    noPid.recorder.sealCollectorEvent("agent_start", {
      session_start_source: "startup",
    });
    const result = await applyCommands(
      [
        command({
          id: "expired",
          command: "pause",
          session_uuid: agent.recorder.sessionUuid,
          expires_at: "2020-01-01T00:00:00.000Z",
        }),
        command({
          id: "elsewhere",
          command: "cancel",
          session_uuid: "00000000-0000-4000-8000-000000000001",
        }),
        command({
          id: "empty",
          command: "steer",
          session_uuid: agent.recorder.sessionUuid,
          delivery_mode: "interrupt",
        }),
        command({
          id: "paused",
          command: "pause",
          session_uuid: agent.recorder.sessionUuid,
        }),
        // No pid to signal, so the ack is `failed`, but the cancel is on the
        // registry and the model calls are still the caller's to cut.
        command({
          id: "no-pid",
          command: "cancel",
          session_uuid: noPid.recorder.sessionUuid,
        }),
      ],
      deps,
    );
    expect(
      Object.fromEntries(
        result.acknowledgements.map((a) => [a.command_id, a.status]),
      ),
    ).toEqual({
      expired: "expired",
      elsewhere: "failed",
      empty: "failed",
      paused: "applied",
      "no-pid": "failed",
    });
    expect(result.applied.map((c) => c.id)).toEqual(["paused", "no-pid"]);
  });

  it("refreshes the bundle before sealing anything in the batch", async () => {
    const { agent, host, deps } = setup();
    const agentBefore = agent.recorder.sealedEvents.length;
    const hostBefore = host.recorder.sealedEvents.length;
    let sealedDuringRefresh: number | undefined;
    let concurrentSeq: number | undefined;
    const result = await applyCommands(
      [
        command({
          id: "p",
          command: "pause",
          session_uuid: agent.recorder.sessionUuid,
        }),
        command({ id: "rb", command: "refresh_bundle" }),
        command({ id: "rb2", command: "refresh_bundle" }),
      ],
      {
        ...deps,
        refreshBundle: async () => {
          await deps.refreshBundle();
          sealedDuringRefresh =
            agent.recorder.sealedEvents.length -
            agentBefore +
            (host.recorder.sealedEvents.length - hostBefore);
          // A hook sealing on the same chain while the refresh is in flight.
          concurrentSeq = agent.recorder.sealCollectorEvent(
            "oxagen:command_applied",
            { policy_decision: "allow", policy_source: "human" },
          ).seq;
        },
      },
    );
    expect(sealedDuringRefresh).toBe(0);
    const pause = result.events.find(
      (e) => e.session_uuid === agent.recorder.sessionUuid,
    );
    // Written after the concurrent frame, so the WAL keeps the chain in order.
    expect(pause?.seq).toBe((concurrentSeq ?? -1) + 1);
    expect(result.applied.map((c) => c.id)).toEqual(["p", "rb", "rb2"]);
  });

  it("fetches once for several refresh commands and not for an expired one", async () => {
    const { deps, refreshes } = setup();
    await applyCommands(
      [
        command({ id: "a", command: "refresh_bundle" }),
        command({ id: "b", command: "refresh_bundle" }),
      ],
      deps,
    );
    expect(refreshes()).toBe(1);
    const expired = await applyCommands(
      [
        command({
          id: "c",
          command: "refresh_bundle",
          expires_at: "2020-01-01T00:00:00.000Z",
        }),
      ],
      deps,
    );
    expect(refreshes()).toBe(1);
    expect(expired.acknowledgements[0]?.status).toBe("expired");
  });
});

describe("control client rate-limit headers", () => {
  async function hintFor(
    headers: Record<string, string>,
  ): Promise<RateLimitHint[]> {
    const hints: RateLimitHint[] = [];
    const client = createControlClient({
      endpoints: { ingest: "i", bundle: "b", commands: "c" },
      apiKey: "key",
      hostEnrollmentId: TEST_ENROLLMENT,
      now: () => 1_000_000,
      onRateLimit: (hint) => hints.push(hint),
      fetch: async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ not_modified: true, etag: "e", bundle: null }),
        headers: {
          get: (name: string) => headers[name.toLowerCase()] ?? null,
        },
      }),
    });
    await client.bundle("e");
    return hints;
  }

  it("reads a missing or non-numeric header as no hint", async () => {
    expect(await hintFor({})).toEqual([]);
    expect(await hintFor({ "x-ratelimit-remaining": "" })).toEqual([]);
    expect(await hintFor({ "x-ratelimit-remaining": "many" })).toEqual([]);
    expect(await hintFor({ "x-ratelimit-reset": "1788000000" })).toEqual([
      { resetAtMs: 1_788_000_000_000 },
    ]);
  });

  it("still reads a real zero", async () => {
    expect(
      await hintFor({
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "1788000000",
      }),
    ).toEqual([{ remaining: 0, resetAtMs: 1_788_000_000_000 }]);
  });
});

describe("OTLP export", () => {
  function systemOf(body: Record<string, unknown>): string | undefined {
    const events = sealAll([
      unsealed("agent_start", { session_start_source: "startup" }),
      unsealed("llm_call", body as never),
    ]);
    const otlp = JSON.parse(exportOtlpJson(events)) as {
      resourceSpans: Array<{
        scopeSpans: Array<{
          spans: Array<{
            name: string;
            attributes: Array<{ key: string; value: { stringValue?: string } }>;
          }>;
        }>;
      }>;
    };
    const chat = otlp.resourceSpans[0]?.scopeSpans[0]?.spans.find((s) =>
      s.name.startsWith("chat "),
    );
    return chat?.attributes.find((a) => a.key === "gen_ai.system")?.value
      .stringValue;
  }

  it("names the provider of the model call", () => {
    expect(systemOf({ provider: "openai", model: "gpt-5" })).toBe("openai");
    expect(systemOf({ model: "gpt-5-codex" })).toBe("openai");
    expect(systemOf({ model: "claude-sonnet-4-5" })).toBe("anthropic");
    expect(systemOf({ model: "some-local-model" })).toBeUndefined();
  });
});
