/**
 * The daemon end to end: real listeners on a scratch socket and an
 * ephemeral port, a fake control plane behind the injected fetch, the
 * recorded hook fixtures posted the way Claude Code posts them, and
 * `tacho-hook` run against the socket. Covers acceptance criteria 2, 4, 6,
 * 9, and the restart path.
 */
import { readdirSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyChain } from "../chain";
import { runTachoHook } from "../claude-code/hook-client";
import type { TachoEvent } from "../envelope";
import type { FetchLike } from "../host/control-client";
import { writeSensitiveFileAtomic } from "../host/fs";
import { readHostFile, writeHostFile } from "../host/host-file";
import { mergeTachoSettings } from "../host/settings-writer";
import {
  bundleSigner,
  scratchPaths,
  TEST_ENROLLMENT,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import type { ControlEnvelope, DeliveredCommand } from "../wire";
import { type DaemonHandle, startDaemon } from "./daemon";

const FIXTURES = join(
  __dirname,
  "..",
  "..",
  "fixtures",
  "claude-code",
  "hooks",
);

interface Fixture {
  name: string;
  env: Record<string, string>;
  stdin: Record<string, unknown>;
}

function fixtures(): Fixture[] {
  return readdirSync(FIXTURES)
    .filter((n) => n.endsWith(".json"))
    .sort()
    .map((name) => ({
      name,
      ...(JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as Omit<
        Fixture,
        "name"
      >),
    }));
}

/** A fake control plane: accepts every batch, hands back what the test queues. */
function fakeControlPlane(bundleEtag: string) {
  const ingested: TachoEvent[] = [];
  const commandQueue: DeliveredCommand[] = [];
  const acks: unknown[] = [];
  let hostStatus: ControlEnvelope["host_status"] = "active";
  let denyGeneration = { org: 1, workspace: 1 };
  let bundle: unknown = null;
  let refuseNext: number | undefined;
  let down = false;
  const calls: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push(url);
    if (down) throw new Error("ECONNREFUSED");
    const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
    const control = (): ControlEnvelope => ({
      host_status: hostStatus,
      deny_generation: denyGeneration,
      bundle_etag: bundleEtag,
      commands: commandQueue.splice(0),
    });
    if (url.endsWith("/events")) {
      if (refuseNext !== undefined) {
        const status = refuseNext;
        refuseNext = undefined;
        return { ok: false, status, text: async () => "refused" };
      }
      const events = body["events"] as TachoEvent[];
      ingested.push(...events);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            accepted: events.length,
            event_ids: events.map((e) => e.event_id_idem),
            chain_breaks: [],
            control: control(),
          }),
      };
    }
    if (url.endsWith("/bundle")) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify(
            bundle === null
              ? {
                  not_modified: true,
                  etag: body["etag"] ?? bundleEtag,
                  bundle: null,
                }
              : { not_modified: false, etag: bundleEtag, bundle },
          ),
      };
    }
    if (url.endsWith("/commands")) {
      acks.push(...(body["acknowledgements"] as unknown[]));
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            acknowledged: (body["acknowledgements"] as unknown[]).length,
            control: control(),
          }),
      };
    }
    return { ok: false, status: 404, text: async () => "nope" };
  };
  return {
    fetch,
    ingested,
    acks,
    calls,
    queue: (command: DeliveredCommand) => commandQueue.push(command),
    setHostStatus: (status: ControlEnvelope["host_status"]) => {
      hostStatus = status;
    },
    setDenyGeneration: (gen: { org: number; workspace: number }) => {
      denyGeneration = gen;
    },
    setBundle: (next: unknown) => {
      bundle = next;
    },
    refuseNextIngest: (status: number) => {
      refuseNext = status;
    },
    setDown: (value: boolean) => {
      down = value;
    },
  };
}

function postHttp(
  port: number,
  token: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

function getHttp(port: number, token: string, path: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("tachod", () => {
  const handles: DaemonHandle[] = [];
  afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.stop();
  });

  async function boot(
    plane: ReturnType<typeof fakeControlPlane>,
    paths = scratchPaths(),
    overrides: Partial<Parameters<typeof startDaemon>[0]> = {},
  ) {
    const signer = bundleSigner();
    const bundle = signer.sign(
      unsignedBundle({
        permissions: {
          allow: ["Read", "Bash(echo *)"],
          deny: ["Write(**/probe.txt)"],
          ask: [],
        },
      }),
    );
    const host = readHostFile(paths.hostFile) ?? testHostFile(signer, bundle);
    if (readHostFile(paths.hostFile) === undefined)
      writeHostFile(paths.hostFile, host);
    writeSensitiveFileAtomic(
      paths.claudeSettings,
      JSON.stringify(
        mergeTachoSettings(
          {},
          {
            enrollmentId: TEST_ENROLLMENT,
            hookCommand: "x",
            port: 1,
            localToken: host.local_token,
          },
        ).settings,
      ),
    );
    const log: string[] = [];
    const handle = await startDaemon({
      paths,
      fetch: plane.fetch,
      exec: () => ({ status: 0, stdout: "", stderr: "" }),
      log: (line) => log.push(line),
      port: 0,
      transcriptRoots: [join(paths.root, "no-transcripts")],
      timers: { detectorMs: 0, sweepMs: 0, checkpointMs: 0, commandsPollMs: 0 },
      ...overrides,
    });
    handles.push(handle);
    return { handle, paths, host, log, signer };
  }

  it("records a full session over http hooks and the socket, ships it, and the chains verify", async () => {
    const plane = fakeControlPlane("etag-3");
    const { handle, paths, host } = await boot(plane);
    const port = handle.port as number;
    for (const fixture of fixtures()) {
      const isCommand = [
        "SessionStart",
        "UserPromptSubmit",
        "PreToolUse",
        "PermissionRequest",
        "Stop",
      ].includes(String(fixture.stdin["hook_event_name"]));
      if (isCommand) {
        const result = await runTachoHook({
          paths,
          env: fixture.env,
          stdin: JSON.stringify(fixture.stdin),
        });
        expect(result.path).toBe("daemon");
        expect(result.exitCode).toBe(0);
        if (fixture.name === "09-PreToolUse.json") {
          expect(JSON.parse(result.stdout)).toMatchObject({
            hookSpecificOutput: { permissionDecision: "deny" },
          });
        }
      } else {
        const res = await postHttp(
          port,
          host.local_token,
          `/hook/${TEST_ENROLLMENT}`,
          fixture.stdin,
        );
        expect(res.status).toBe(200);
        expect(JSON.parse(res.body)).toEqual({});
      }
    }
    // Unauthorized and foreign-enrollment posts are refused.
    expect(
      (await postHttp(port, "wrong", `/hook/${TEST_ENROLLMENT}`, {})).status,
    ).toBe(401);
    expect(
      (
        await postHttp(
          port,
          host.local_token,
          "/hook/tch_zzzzzzzzzzzzzzzzzzzzzz",
          {},
        )
      ).status,
    ).toBe(403);
    expect((await postHttp(port, host.local_token, "/nope", {})).status).toBe(
      404,
    );
    // OTLP is accepted and attributed by session id.
    const otlpDir = join(
      __dirname,
      "..",
      "..",
      "fixtures",
      "claude-code",
      "otlp",
    );
    for (const name of readdirSync(otlpDir).sort()) {
      const signal = name.includes("logs")
        ? "logs"
        : name.includes("metrics")
          ? "metrics"
          : "traces";
      const res = await postHttp(
        port,
        host.local_token,
        `/v1/${signal}`,
        JSON.parse(readFileSync(join(otlpDir, name), "utf8")),
      );
      expect(res.status).toBe(200);
    }
    expect(
      (await postHttp(port, host.local_token, "/v1/traces", {})).status,
    ).toBe(200);

    await handle.tick();
    expect(plane.ingested.length).toBeGreaterThan(20);
    const bySession = new Map<string, TachoEvent[]>();
    for (const event of plane.ingested)
      bySession.set(event.session_uuid, [
        ...(bySession.get(event.session_uuid) ?? []),
        event,
      ]);
    expect(bySession.size).toBe(3); // parent, subagent child, and the daemon's own chain
    for (const events of bySession.values()) {
      expect(verifyChain(events, { expectGenesis: true }).violations).toEqual(
        [],
      );
    }
    expect(
      plane.ingested.some(
        (e) =>
          e.kind === "checkpoint" &&
          (e.body as { checkpoint_device_signature?: string })
            .checkpoint_device_signature !== undefined,
      ),
    ).toBe(true);
    expect(plane.ingested.some((e) => e.kind === "llm_call")).toBe(true);
    const status = JSON.parse(
      (await getHttp(port, host.local_token, "/status")).body,
    ) as {
      sessions: Array<{ sealed: boolean; session_id: string }>;
      hooks: { complete: boolean };
    };
    expect(
      status.sessions.find((s) => !s.session_id.startsWith("tachod-"))?.sealed,
    ).toBe(true);
    expect(status.hooks.complete).toBe(true);
    const health = JSON.parse(
      (await getHttp(port, host.local_token, "/health")).body,
    ) as { ok: boolean; spool_depth: number };
    expect(health.ok).toBe(true);
    expect(health.spool_depth).toBe(0);
    const listing = JSON.parse(
      (await getHttp(port, host.local_token, "/sessions")).body,
    ) as { sessions: Array<{ session_id: string }> };
    const sessionId = listing.sessions.find(
      (s) => !s.session_id.startsWith("tachod-"),
    )?.session_id as string;
    const exported = await getHttp(
      port,
      host.local_token,
      `/sessions/${sessionId}/export?format=trace`,
    );
    expect(exported.status).toBe(200);
    expect(exported.body).toContain("session_start");
    expect(
      (await getHttp(port, host.local_token, "/sessions/nope/export")).status,
    ).toBe(404);
  });

  it("applies pause, message, cancel, and revoke commands from the ingest response", async () => {
    const plane = fakeControlPlane("etag-3");
    const killed: Array<[number, string]> = [];
    const { handle, paths } = await boot(plane, scratchPaths(), {
      kill: (pid, signal) => {
        killed.push([pid, signal]);
        return true;
      },
    });
    const [start, , prompt, read] = fixtures() as [
      Fixture,
      Fixture,
      Fixture,
      Fixture,
    ];
    await runTachoHook({
      paths,
      env: start.env,
      stdin: JSON.stringify(start.stdin),
    });
    const sessionUuid = handle.registry.get(String(start.stdin["session_id"]))
      ?.recorder.sessionUuid as string;
    plane.queue({
      id: "cmd_pause",
      command: "pause",
      session_uuid: sessionUuid,
      payload: { reason: "budget review" },
      issued_at: "2026-09-10T10:00:00.000Z",
      expires_at: null,
    });
    plane.queue({
      id: "cmd_msg",
      command: "message",
      session_uuid: sessionUuid,
      payload: { text: "Finish the current file only." },
      issued_at: "2026-09-10T10:00:00.000Z",
      expires_at: null,
    });
    plane.queue({
      id: "cmd_old",
      command: "resume",
      session_uuid: sessionUuid,
      payload: {},
      issued_at: "2026-09-10T10:00:00.000Z",
      expires_at: "2020-01-01T00:00:00.000Z",
    });
    plane.queue({
      id: "cmd_lost",
      command: "pause",
      session_uuid: "00000000-0000-4000-8000-000000000009",
      payload: {},
      issued_at: "2026-09-10T10:00:00.000Z",
      expires_at: null,
    });
    await handle.tick();
    const blocked = await runTachoHook({
      paths,
      env: prompt.env,
      stdin: JSON.stringify(prompt.stdin),
    });
    expect(JSON.parse(blocked.stdout)).toMatchObject({
      decision: "block",
      reason: expect.stringContaining("budget review"),
    });
    plane.queue({
      id: "cmd_resume",
      command: "resume",
      session_uuid: sessionUuid,
      payload: {},
      issued_at: "2026-09-10T10:00:00.000Z",
      expires_at: null,
    });
    await handle.tick();
    const resumed = await runTachoHook({
      paths,
      env: prompt.env,
      stdin: JSON.stringify(prompt.stdin),
    });
    expect(JSON.parse(resumed.stdout)).toMatchObject({
      hookSpecificOutput: {
        additionalContext: "Finish the current file only.",
      },
    });
    await handle.tick();
    const ackIds = (
      plane.acks as Array<{ command_id: string; outcome: string }>
    ).map((a) => `${a.command_id}:${a.outcome}`);
    expect(ackIds).toEqual(
      expect.arrayContaining([
        "cmd_pause:applied",
        "cmd_msg:delivered",
        "cmd_msg:applied",
        "cmd_old:expired",
        "cmd_lost:failed",
        "cmd_resume:applied",
      ]),
    );
    // cancel: the tool boundary denies and a kill is attempted at the recorded pid.
    plane.queue({
      id: "cmd_cancel",
      command: "cancel",
      session_uuid: sessionUuid,
      payload: { reason: "runaway" },
      issued_at: "2026-09-10T10:00:00.000Z",
      expires_at: null,
    });
    await handle.tick();
    const denied = await runTachoHook({
      paths,
      env: read.env,
      stdin: JSON.stringify(read.stdin),
    });
    expect(JSON.parse(denied.stdout)).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining("runaway"),
      },
    });
    await handle.tick();
    const kill = plane.ingested.find((e) => e.kind === "oxagen:kill_attempted");
    expect(kill?.body).toMatchObject({
      kill_signal: "SIGTERM",
      kill_outcome: "sent",
    });
    expect(killed).toEqual([[59942, "SIGTERM"]]);
    // revoke at host level: status suspended, sessions refused, persisted to host.json.
    plane.queue({
      id: "cmd_revoke",
      command: "revoke",
      session_uuid: null,
      payload: { reason: "offboarded" },
      issued_at: "2026-09-10T10:00:00.000Z",
      expires_at: null,
    });
    await handle.tick();
    expect(handle.host().host_status).toBe("suspended");
    expect(readHostFile(paths.hostFile)?.host_status).toBe("suspended");
    const refused = await runTachoHook({
      paths,
      env: start.env,
      stdin: JSON.stringify(start.stdin),
    });
    expect(JSON.parse(refused.stdout)).toMatchObject({ continue: false });
  });

  it("keeps enforcing and spools while the daemon is down, then replays with a telemetry gap", async () => {
    const plane = fakeControlPlane("etag-3");
    const { handle, paths } = await boot(plane);
    const all = fixtures();
    const start = all[0] as Fixture;
    const write = all[8] as Fixture;
    const read = all[3] as Fixture;
    const post = all[9] as Fixture;
    await runTachoHook({
      paths,
      env: start.env,
      stdin: JSON.stringify(start.stdin),
    });
    await handle.stop();
    handles.splice(handles.indexOf(handle), 1);
    // Daemon down: the hook decides from the cached bundle and spools.
    const denied = await runTachoHook({
      paths,
      env: write.env,
      stdin: JSON.stringify(write.stdin),
      connectTimeoutMs: 50,
    });
    expect(denied.path).toBe("local");
    expect(JSON.parse(denied.stdout)).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason:
          "Denied by Oxagen policy rule Write(**/probe.txt).",
      },
    });
    const allowed = await runTachoHook({
      paths,
      env: read.env,
      stdin: JSON.stringify(read.stdin),
      connectTimeoutMs: 50,
    });
    expect(allowed.path).toBe("local");
    expect(JSON.parse(allowed.stdout)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });
    expect(
      readdirSync(paths.spool).filter((n) => n.endsWith(".json")),
    ).toHaveLength(2);
    // Restart: the chain continues from the persisted cursor, spool replays first.
    const { handle: again } = await boot(plane, paths);
    const port = again.port as number;
    const token = readHostFile(paths.hostFile)?.local_token as string;
    await postHttp(port, token, `/hook/${TEST_ENROLLMENT}`, post.stdin);
    await again.tick();
    expect(
      readdirSync(paths.spool).filter((n) => n.endsWith(".json")),
    ).toHaveLength(0);
    const sessionUuid = again.registry.get(String(start.stdin["session_id"]))
      ?.recorder.sessionUuid as string;
    const chain = plane.ingested.filter((e) => e.session_uuid === sessionUuid);
    expect(verifyChain(chain, { expectGenesis: true }).ok).toBe(true);
    const kinds = chain.map((e) => e.kind);
    expect(kinds.slice(0, 1)).toEqual(["agent_start"]);
    expect(kinds).toEqual(
      expect.arrayContaining([
        "policy_decision",
        "token_denied",
        "tool_requested",
        "telemetry_gap",
        "tool_call",
      ]),
    );
    const replayed = chain.filter((e) => e.attrs?.["hook.replayed"] === "1");
    expect(replayed.length).toBeGreaterThanOrEqual(4);
    const gap = chain.find((e) => e.kind === "telemetry_gap");
    expect(gap?.body).toMatchObject({
      gap_cause: "daemon_down",
      incident_kind: "telemetry_gap",
    });
  });

  it("refreshes a changed bundle, tracks deny generations, bisects a refused batch, and survives an outage", async () => {
    const plane = fakeControlPlane("etag-4");
    const { handle, paths, signer, log } = await boot(plane);
    const next = signer.sign(
      unsignedBundle({
        version: 4,
        etag: "etag-4",
        mode: "observe",
        context: { system: null },
      }),
    );
    plane.setBundle(next);
    plane.setDenyGeneration({ org: 2, workspace: 1 });
    await handle.tick();
    expect(handle.host().bundle.version).toBe(4);
    expect(handle.host().deny_generation).toEqual({ org: 2, workspace: 1 });
    expect(readHostFile(paths.hostFile)?.bundle.etag).toBe("etag-4");
    // A bundle from the wrong key is refused.
    const rogue = bundleSigner().sign(
      unsignedBundle({ version: 9, etag: "etag-9" }),
    );
    plane.setBundle(rogue);
    expect(await handle.refreshBundle()).toBe(false);
    expect(handle.host().bundle.version).toBe(4);
    expect(log.some((l) => l.includes("does not verify"))).toBe(true);
    // A refused batch bisects to the offending event and quarantines it.
    const start = fixtures()[0] as Fixture;
    await runTachoHook({
      paths,
      env: start.env,
      stdin: JSON.stringify(start.stdin),
    });
    plane.refuseNextIngest(400);
    await handle.tick();
    await handle.tick();
    expect(
      readdirSync(paths.quarantine).length + plane.ingested.length,
    ).toBeGreaterThan(0);
    // An outage backs off and reports unreachable; recovery ships the backlog.
    plane.setDown(true);
    const prompt = fixtures()[2] as Fixture;
    await runTachoHook({
      paths,
      env: prompt.env,
      stdin: JSON.stringify(prompt.stdin),
    });
    await handle.tick();
    expect(handle.shipper.reachable).toBe(false);
    expect(handle.shipper.lastError).toContain("unreachable");
    plane.setDown(false);
    expect(handle.shipper.ready()).toBe(false);
  });
});
