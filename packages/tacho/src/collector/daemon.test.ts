/**
 * The daemon end to end: real listeners on a scratch socket and an
 * ephemeral port, a fake control plane behind the injected fetch, the
 * recorded hook fixtures posted the way Claude Code posts them, and
 * `tacho-hook` run against the socket. Covers acceptance criteria 2, 4, 6,
 * 9, and the restart path.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import {
  type ControlEnvelope,
  type DeliveredCommand,
  TACHO_BUNDLE_FEATURES,
} from "../wire";
import { type DaemonHandle, startDaemon } from "./daemon";

// The command test's session reports pid 59942, which is not running here, so
// the first sweep would seal it and the inbox then refuses commands for it.
// Treat the pids a test adds as alive.
const alive = vi.hoisted(() => new Set<number>());
vi.mock("../host/process-scan", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../host/process-scan")>();
  return {
    ...original,
    isProcessAlive: (pid: number) =>
      alive.has(pid) || original.isProcessAlive(pid),
  };
});

/**
 * The connect budget a hook gets when the test needs it to REACH the daemon.
 *
 * `runTachoHook` defaults to 50ms (hook-client.ts), which is a production
 * figure: a hook must never block the agent waiting on a socket, so it gives
 * up fast and decides locally from the cached bundle. A test that asserts the
 * daemon path is therefore racing that budget, and on a loaded CI runner the
 * unix-socket connect loses — the hook falls back, `path` is "local", and the
 * assertion fails on the machine's scheduling rather than on the code. The
 * nightly full run caught exactly that on 2026-09-17.
 *
 * The two cases below that assert the FALLBACK keep the 50ms default on
 * purpose (the daemon is stopped there); this constant is for the opposite
 * intent, and being a named constant is what keeps the two legible apart.
 */
const DAEMON_CONNECT_MS = 5_000;

/**
 * The deadline every test that spends the budget above runs under.
 *
 * Vitest's own default is 5,000ms and its clock starts before the daemon
 * boots, so a connect budget of the same size can never expire inside it. The
 * runner stops the test first, `runTachoHook` never returns, and the reason it
 * would have carried is thrown away with it, so CI shows the bare timeout that
 * #3203 was written to replace. The deadline has to clear the budget and the
 * boot ahead of it. Stating it here keeps the two figures in one place, and
 * the test below spends a whole budget, so it fails if they ever cross again.
 */
const DAEMON_TEST_TIMEOUT_MS = 30_000;

/**
 * Assert the hook reached the daemon, and say WHY when it did not.
 *
 * `runTachoHook` turns every failure — connect timeout, response timeout, a
 * non-200 from the daemon — into the same `path: "local"` with the cause put
 * in `stderr` and exit code 0, because a hook must never fail the agent. That
 * is right for production and hostile to a test: a bare
 * `expect(result.path).toBe("daemon")` reports `expected 'local' to be
 * 'daemon'` and throws the reason away, which is all the 2026-09-17 nightly
 * left behind. Carrying stderr into the assertion message costs nothing and
 * makes the next occurrence self-describing.
 */
function expectReachedDaemon(result: { path: string; stderr: string }): void {
  expect(
    result.path,
    `hook fell back to the local path instead of reaching the daemon: ${result.stderr.trim() || "(no stderr)"}`,
  ).toBe("daemon");
}

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
  /** Bodies the host shipped next to its events, across every batch. */
  const ingestedBodies: Array<{ event_id_idem: string; bytes_base64: string }> =
    [];
  const commandQueue: DeliveredCommand[] = [];
  const acks: unknown[] = [];
  let hostStatus: ControlEnvelope["host_status"] = "active";
  let denyGeneration = { org: 1, workspace: 1 };
  let bundle: unknown = null;
  let refuseNext: number | undefined;
  /** While set, every command poll is refused with this status and body. */
  let refuseCommands:
    | { status: number; body: string; headers?: Record<string, string> }
    | undefined;
  let down = false;
  const calls: string[] = [];
  /** Every daemon health report the plane received, newest last. */
  const reported: unknown[] = [];
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
      if (body["daemon"] !== undefined) reported.push(body["daemon"]);
      const events = body["events"] as TachoEvent[];
      ingested.push(...events);
      ingestedBodies.push(
        ...((body["bodies"] ?? []) as Array<{
          event_id_idem: string;
          bytes_base64: string;
        }>),
      );
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
      if (refuseCommands !== undefined) {
        return {
          ok: false,
          status: refuseCommands.status,
          text: async () => refuseCommands?.body ?? "",
          headers: {
            get: (name: string) =>
              refuseCommands?.headers?.[name.toLowerCase()] ?? null,
          },
        };
      }
      if (body["daemon"] !== undefined) reported.push(body["daemon"]);
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
    ingestedBodies,
    acks,
    calls,
    reported,
    queue: (
      command: Omit<
        DeliveredCommand,
        "requested_mode" | "delivery_mode" | "degraded_reason" | "reason"
      > &
        Partial<DeliveredCommand>,
    ) =>
      commandQueue.push({
        requested_mode: null,
        delivery_mode: null,
        degraded_reason: null,
        reason: null,
        ...command,
      }),
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
    refuseCommandsWith: (
      refusal:
        | { status: number; body: string; headers?: Record<string, string> }
        | undefined,
    ) => {
      refuseCommands = refusal;
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

/**
 * The prompt text sitting in this host's WAL body files. Under a mandate that
 * retains nothing, no body is written at all, so an operator who looks at the
 * directory sees what the control plane sees.
 */
function walBodyTexts(walDir: string): string[] {
  if (!existsSync(walDir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(walDir)) {
    if (!name.endsWith(".bodies.jsonl")) continue;
    for (const line of readFileSync(join(walDir, name), "utf8").split("\n")) {
      if (line.trim() === "") continue;
      const body = JSON.parse(line) as { bytes_base64: string };
      out.push(Buffer.from(body.bytes_base64, "base64").toString());
    }
  }
  return out;
}

describe("tachod", () => {
  const handles: DaemonHandle[] = [];
  afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.stop();
    alive.clear();
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

  it("answers a hook while a gateway forward is still in flight", async () => {
    // The regression this guards: every gateway call used to sit on the same
    // serial queue as PreToolUse hooks, OTel ingestion and spool draining, and
    // the queued task wrapped the whole remote fetch with its 30-second
    // timeout. One connected app's slow tool call therefore stalled every
    // wrapped agent on the machine past its 5-10 second decision budget. Put
    // the line back on `serial.run` and this test hangs until the test timeout.
    const plane = fakeControlPlane("etag-3");
    let releaseForward: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      releaseForward = resolve;
    });
    const { handle, host } = await boot(plane, scratchPaths(), {
      fetch: async (url, init) => {
        if (url.includes("/mcp")) {
          await held;
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }),
          };
        }
        return plane.fetch(url, init);
      },
    });
    const port = handle.port as number;

    const forward = postHttp(port, host.local_token, "/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    let forwardDone = false;
    void forward.then(() => {
      forwardDone = true;
    });

    // The hook has to come back on its own while the forward is parked.
    const hook = await postHttp(port, host.local_token, "/hook", {
      session_id: "sess-concurrent",
      hook_event_name: "SessionStart",
      cwd: "/tmp",
    });
    expect(hook.status).toBe(200);
    expect(forwardDone).toBe(false);

    releaseForward?.();
    expect((await forward).status).toBe(200);
  });

  it("seals the spool replay of a hook whose live write failed", async () => {
    // The hook-id ledger drops a replay whose id the session already holds.
    // It used to remember the id before the frames reached the WAL, so a
    // failed write left the id behind. The client saw a 500, spooled the
    // hook under the same id, and the daemon dropped that replay as a
    // repeat. The hook never reached the record.
    //
    // The same failure also lost the session's genesis. The session was
    // created inside the failed call, after every chain was marked, so the
    // rollback never reached it: the retry sealed a resume at seq 1 on a
    // chain whose seq 0 nothing held.
    const plane = fakeControlPlane("etag-3");
    const { handle, host } = await boot(plane);
    const port = handle.port as number;
    const start = fixtures().find(
      (f) => f.stdin["hook_event_name"] === "SessionStart",
    ) as Fixture;
    const envelope = {
      payload: start.stdin,
      env: start.env,
      hook_id: "hook_write_failed",
    };
    const asEnvelope = { "x-tacho-envelope": "1" };

    const append = handle.wal.append.bind(handle.wal);
    handle.wal.append = () => {
      throw new Error("ENOSPC: no space left on device");
    };
    const live = await postHttp(
      port,
      host.local_token,
      "/hook",
      envelope,
      asEnvelope,
    );
    expect(live.status).toBe(500);
    handle.wal.append = append;

    const replay = await postHttp(
      port,
      host.local_token,
      "/hook",
      envelope,
      asEnvelope,
    );
    expect(replay.status).toBe(200);
    await handle.tick();
    const started = plane.ingested.filter(
      (e) =>
        e.kind === "agent_start" &&
        (e.body as { session_start_source?: string }).session_start_source ===
          "startup",
    );
    expect(started).toHaveLength(1);
    const [genesis] = started as [TachoEvent];
    expect(genesis.seq).toBe(0);
    expect(
      (genesis.body as { resume_of_session_id?: string }).resume_of_session_id,
    ).toBeUndefined();
    const chain = plane.ingested.filter(
      (e) => e.session_uuid === genesis.session_uuid,
    );
    expect(verifyChain(chain, { expectGenesis: true }).violations).toEqual([]);
  });

  it(
    "reports the reason when the connect budget runs out instead of being stopped by the runner",
    async () => {
      // The pair this pins: a hook that spends the whole connect budget must
      // still return inside the test's own deadline, or the fallback and the
      // reason it carries never reach an assertion. Under Vitest's default
      // 5,000ms deadline this test is killed mid-hook and reports a bare
      // timeout, which is the failure #3203 set out to make self-describing.
      //
      // A connect that stays pending cannot be staged against a real socket:
      // one with a listener connects at once and one without is refused at
      // once. So the post here answers the way `postUnix` answers a connect
      // still pending when its timer fires, and spends the same budget doing
      // it.
      const plane = fakeControlPlane("etag-3");
      const { paths } = await boot(plane);
      const start = fixtures()[0] as Fixture;
      const startedAt = Date.now();
      const result = await runTachoHook({
        paths,
        env: start.env,
        stdin: JSON.stringify(start.stdin),
        connectTimeoutMs: DAEMON_CONNECT_MS,
        post: async (options) => {
          await new Promise((resolve) =>
            setTimeout(resolve, options.connectTimeoutMs),
          );
          throw new Error("connect timeout");
        },
      });

      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(DAEMON_CONNECT_MS);
      expect(result.path).toBe("local");
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("connect timeout");
      // And the helper every other case here goes through says why, rather
      // than reporting only that "local" is not "daemon".
      expect(() => expectReachedDaemon(result)).toThrow(/connect timeout/);
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

  it(
    "records a full session over http hooks and the socket, ships it, and the chains verify",
    async () => {
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
            connectTimeoutMs: DAEMON_CONNECT_MS,
          });
          expectReachedDaemon(result);
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
      // The final Git read seals after shipping. Its terminal frames ship next tick.
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
        status.sessions.find((s) => !s.session_id.startsWith("tachod-"))
          ?.sealed,
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
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

  it("sends pending command acknowledgements when a queued body cannot be read", async () => {
    const plane = fakeControlPlane("etag-3");
    const { handle } = await boot(plane);
    await handle.api.handleHook({
      payload: {
        session_id: "body-failure",
        hook_event_name: "SessionStart",
        cwd: "/repo",
      },
      env: {},
    });
    const sessionUuid =
      handle.registry.get("body-failure")!.recorder.sessionUuid;
    plane.queue({
      id: "pause-before-body-failure",
      command: "pause",
      session_uuid: sessionUuid,
      payload: {},
      issued_at: "2026-09-10T10:00:00.000Z",
      expires_at: null,
    });
    await handle.shipper.drain();
    expect(plane.acks).toEqual([]);
    const read = vi
      .spyOn(handle.wal, "bodiesFor")
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("body read failed"), { code: "EIO" });
      });
    await expect(handle.tick()).resolves.toBeUndefined();
    expect(handle.shipper.lastError).toBe("body read failed");
    expect(plane.acks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command_id: "pause-before-body-failure",
          status: "applied",
        }),
      ]),
    );
    read.mockRestore();
  });

  it(
    "applies pause, message, cancel, and revoke commands from the ingest response",
    async () => {
      alive.add(59942);
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
        connectTimeoutMs: DAEMON_CONNECT_MS,
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
        connectTimeoutMs: DAEMON_CONNECT_MS,
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
        connectTimeoutMs: DAEMON_CONNECT_MS,
      });
      expect(JSON.parse(resumed.stdout)).toMatchObject({
        hookSpecificOutput: {
          additionalContext: "Finish the current file only.",
        },
      });
      await handle.tick();
      const ackIds = (
        plane.acks as Array<{ command_id: string; status: string }>
      ).map((a) => `${a.command_id}:${a.status}`);
      expect(ackIds).toEqual(
        expect.arrayContaining([
          "cmd_pause:applied",
          "cmd_msg:received",
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
        connectTimeoutMs: DAEMON_CONNECT_MS,
      });
      expect(JSON.parse(denied.stdout)).toMatchObject({
        hookSpecificOutput: {
          permissionDecision: "deny",
          permissionDecisionReason: expect.stringContaining("runaway"),
        },
      });
      await handle.tick();
      const kill = plane.ingested.find(
        (e) => e.kind === "oxagen:kill_attempted",
      );
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
        connectTimeoutMs: DAEMON_CONNECT_MS,
      });
      expect(JSON.parse(refused.stdout)).toMatchObject({ continue: false });
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

  it(
    "keeps enforcing and spools while the daemon is down, then replays with a telemetry gap",
    async () => {
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
        connectTimeoutMs: DAEMON_CONNECT_MS,
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
      const chain = plane.ingested.filter(
        (e) => e.session_uuid === sessionUuid,
      );
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
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

  it(
    "refreshes a changed bundle, tracks deny generations, bisects a refused batch, and survives an outage",
    async () => {
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
      // Every poll tells the plane which bundle fields this build can parse, so
      // a gated field reaches a host that upgraded in place. `host.json`'s
      // `wrapper_version` cannot answer that: `enroll` writes it once.
      expect(plane.reported.at(-1)).toMatchObject({
        bundle_features: [...TACHO_BUNDLE_FEATURES],
      });
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
        connectTimeoutMs: DAEMON_CONNECT_MS,
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
        connectTimeoutMs: DAEMON_CONNECT_MS,
      });
      await handle.tick();
      expect(handle.shipper.reachable).toBe(false);
      expect(handle.shipper.lastError).toContain("unreachable");
      plane.setDown(false);
      expect(handle.shipper.ready()).toBe(false);
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

  it.each([
    ["content_exact", ["model_call"], 1],
    ["content_exact", ["tool_call"], 0],
    ["content_exact", [], 0],
    ["digest_only", [], 0],
  ] as const)(
    "ships a prompt body under %s retention for classes %j",
    async (mode, classes, expected) => {
      // The mandate decides, and it decides on the machine. Under
      // `digest_only` the bytes never reach the disk, so an operator who
      // looks at the directory sees what the control plane sees.
      const plane = fakeControlPlane("etag-3");
      const paths = scratchPaths();
      const signer = bundleSigner();
      const bundle = signer.sign(
        unsignedBundle({ retention: { mode, classes: [...classes] } }),
      );
      writeHostFile(paths.hostFile, testHostFile(signer, bundle));
      const { handle } = await boot(plane, paths);

      const result = await runTachoHook({
        paths,
        env: {},
        stdin: JSON.stringify({
          session_id: "11111111-1111-4111-8111-11111111aaaa",
          hook_event_name: "UserPromptSubmit",
          cwd: "/home/dev/proj",
          transcript_path: "/t.jsonl",
          prompt: "deploy the fix",
        }),
        connectTimeoutMs: DAEMON_CONNECT_MS,
      });
      expect(result.exitCode).toBe(0);
      expect(result.path).toBe("daemon");
      // `stop` drains, so whatever the mandate kept has been shipped by now.
      await handle.stop();

      const prompts = plane.ingestedBodies.filter(
        (body) =>
          Buffer.from(body.bytes_base64, "base64").toString() ===
          "deploy the fix",
      );
      expect(prompts).toHaveLength(expected);
      // Under a mandate that does not retain the class, the bytes never reach
      // the disk either: the WAL holds no body for the frame.
      expect(
        walBodyTexts(paths.wal).filter((t) => t === "deploy the fix"),
      ).toHaveLength(expected);
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

  it(
    "does not take a freshness window from a future-dated host file",
    async () => {
      // `bundle_fetched_at` is unsigned and sits in a file on the operator's
      // machine, while the signature covers the bundle alone, so nothing reads
      // it for freshness. Clamping it to startup was not enough: a restart is
      // free, so dating the field forward and restarting would take a fresh
      // window every time and keep an expired grant in force for ever. Both
      // readers fall back to the bundle's signed `issued_at` instead, so the
      // mandate here has outlived its own signed window and is lapsed however
      // the file is dated.
      const plane = fakeControlPlane("etag-fresh");
      const paths = scratchPaths();
      const signer = bundleSigner();
      const bundle = signer.sign(
        unsignedBundle({
          retention: { mode: "content_exact", classes: ["model_call"] },
        }),
      );
      const window =
        Date.parse(bundle.expires_at) - Date.parse(bundle.issued_at);
      // Start the clock past the bundle's own signed window, which is the
      // state a restart-loop tries to paper over.
      const clock = Date.parse(bundle.issued_at) + window + 1;
      writeHostFile(
        paths.hostFile,
        testHostFile(signer, bundle, {
          // A century out, so no elapsed time could ever overtake it.
          bundle_fetched_at: "2126-09-10T00:00:00.000Z",
        }),
      );
      const { handle } = await boot(plane, paths, { now: () => clock });
      const result = await runTachoHook({
        paths,
        env: {},
        stdin: JSON.stringify({
          session_id: "11111111-1111-4111-8111-11111111cccc",
          hook_event_name: "UserPromptSubmit",
          cwd: "/home/dev/proj",
          transcript_path: "/t.jsonl",
          prompt: "deploy the fix",
        }),
        connectTimeoutMs: DAEMON_CONNECT_MS,
      });
      expect(result.exitCode).toBe(0);
      await handle.stop();

      expect(plane.ingestedBodies).toEqual([]);
      expect(walBodyTexts(paths.wal)).toEqual([]);
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

  it(
    "does not renew the mandate on a bundle that fails to verify",
    async () => {
      // A response carrying a changed bundle is a confirmation only once that
      // bundle verifies. Renewing first would let a control plane extend the
      // very mandate its response was sent to replace, and keep extending it
      // for as long as it kept answering that way.
      const plane = fakeControlPlane("etag-old");
      const paths = scratchPaths();
      const signer = bundleSigner();
      const bundle = signer.sign(
        unsignedBundle({
          retention: { mode: "content_exact", classes: ["model_call"] },
        }),
      );
      const window =
        Date.parse(bundle.expires_at) - Date.parse(bundle.issued_at);
      let clock = Date.parse("2026-09-11T00:00:00.000Z");
      writeHostFile(paths.hostFile, testHostFile(signer, bundle));
      const { handle } = await boot(plane, paths, { now: () => clock });

      // A changed bundle carrying someone else's signature.
      plane.setBundle({
        ...signer.sign(unsignedBundle({ version: 99 })),
        retention: {
          mode: "content_exact",
          classes: ["model_call", "tool_call"],
        },
      });
      // Just inside the window, where a renewal would still have something to
      // extend, then just outside the original one.
      clock += window - 1;
      await handle.refreshBundle();
      clock += 2;

      const result = await runTachoHook({
        paths,
        env: {},
        stdin: JSON.stringify({
          session_id: "11111111-1111-4111-8111-11111111dddd",
          hook_event_name: "UserPromptSubmit",
          cwd: "/home/dev/proj",
          transcript_path: "/t.jsonl",
          prompt: "deploy the fix",
        }),
        connectTimeoutMs: DAEMON_CONNECT_MS,
      });
      expect(result.exitCode).toBe(0);
      await handle.stop();

      expect(plane.ingestedBodies).toEqual([]);
      expect(walBodyTexts(paths.wal)).toEqual([]);
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

  it(
    "retains nothing when the cached mandate does not verify",
    async () => {
      // `host.json` is a file on the operator's machine. Without checking the
      // signature, editing `digest_only` to `content_exact` in it would send
      // prompt bodies until the first refresh replaced the bundle, which is
      // the one thing signing the mandate is there to prevent.
      const plane = fakeControlPlane("etag-3");
      const paths = scratchPaths();
      const signer = bundleSigner();
      const signed = signer.sign(
        unsignedBundle({ retention: { mode: "content_exact", classes: [] } }),
      );
      // A bundle that claims the broadest retention, with the signature of one
      // that claimed none.
      const tampered = {
        ...signed,
        retention: { mode: "content_exact" as const, classes: ["model_call"] },
      };
      writeHostFile(paths.hostFile, testHostFile(signer, tampered));
      const { handle } = await boot(plane, paths);

      const result = await runTachoHook({
        paths,
        env: {},
        stdin: JSON.stringify({
          session_id: "11111111-1111-4111-8111-11111111bbbb",
          hook_event_name: "UserPromptSubmit",
          cwd: "/home/dev/proj",
          transcript_path: "/t.jsonl",
          prompt: "deploy the fix",
        }),
        connectTimeoutMs: DAEMON_CONNECT_MS,
      });
      expect(result.exitCode).toBe(0);
      await handle.stop();

      expect(plane.ingestedBodies).toEqual([]);
      expect(walBodyTexts(paths.wal)).toEqual([]);
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

  it(
    "writes no body once a signed mandate has lapsed, refreshing before it drains",
    async () => {
      // The regression this guards: a correctly signed bundle kept granting
      // `content_exact` after its window closed, and the tick drained before
      // it refreshed, so a body could leave the machine under a mandate the
      // control plane had not confirmed. The tick now refreshes first, and a
      // lapsed mandate authorises nothing further to be written.
      //
      // What this does not cover, because main's design has no place to put
      // it: a body already in the WAL when the mandate lapses still ships on
      // the next drain. Bodies live beside their events there and leave with
      // the session file at compaction, so purging them mid-session would be
      // a new `Wal` affordance rather than a smaller one.
      //
      // The fixture's signed window runs 2026-09-10 to 2027-09-10. The clock
      // starts on real time because the tick's hourly compaction reads file
      // mtimes, and a fake clock months ahead would sweep the session first.
      const plane = fakeControlPlane("etag-3");
      const paths = scratchPaths();
      const signer = bundleSigner();
      const bundle = signer.sign(
        unsignedBundle({
          retention: { mode: "content_exact", classes: ["model_call"] },
        }),
      );
      writeHostFile(paths.hostFile, testHostFile(signer, bundle));
      plane.setDown(true);
      let clock = Date.now();
      const { handle } = await boot(plane, paths, { now: () => clock });
      const prompt = (sessionId: string) =>
        runTachoHook({
          paths,
          env: {},
          stdin: JSON.stringify({
            session_id: sessionId,
            hook_event_name: "UserPromptSubmit",
            cwd: "/home/dev/proj",
            transcript_path: "/t.jsonl",
            prompt: "deploy the fix",
          }),
          connectTimeoutMs: DAEMON_CONNECT_MS,
        });

      expect(
        (await prompt("11111111-1111-4111-8111-11111111cccc")).exitCode,
      ).toBe(0);
      await handle.tick();
      expect(walBodyTexts(paths.wal)).toEqual(["deploy the fix"]);

      // Past the signed window, with no confirmation from the control plane
      // in between: the mandate has lapsed and authorises nothing.
      clock = Date.parse("2027-10-01T00:00:00.000Z");
      await prompt("11111111-1111-4111-8111-11111111dddd");
      await handle.tick();
      expect(walBodyTexts(paths.wal)).toEqual(["deploy the fix"]);

      await handle.stop();
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

  it("backs off the command poll instead of retrying it every tick", async () => {
    // The regression this guards: `sendAcks` had no gate of its own. Its only
    // skip condition is "a recent ingest already carried a control envelope",
    // and an outage makes ingest stale too, so every tick — one per second in
    // the real daemon — re-attempted the poll. A control plane answering 503
    // therefore got 60 requests a minute from every enrolled host, forever,
    // and the host wrote 1770 identical failures into 2000 lines of log. The
    // daemon must get quieter when the control plane is down, not louder.
    const plane = fakeControlPlane("etag-backoff");
    let clock = 1_000_000;
    const { handle, log } = await boot(plane, scratchPaths(), {
      now: () => clock,
    });
    const pollCount = () =>
      plane.calls.filter((u) => u.endsWith("/commands")).length;

    plane.setDown(true);
    await handle.tick();
    const afterFirstFailure = pollCount();
    expect(afterFirstFailure).toBeGreaterThan(0);

    // Four more ticks a tenth of a second apart: the daemon is inside its
    // backoff window and must not touch the control plane again.
    for (let i = 0; i < 4; i += 1) {
      clock += 100;
      await handle.tick();
    }
    expect(pollCount()).toBe(afterFirstFailure);

    // Past the first backoff (2s), exactly one more attempt is allowed.
    clock += 2_500;
    await handle.tick();
    expect(pollCount()).toBe(afterFirstFailure + 1);
    clock += 100;
    await handle.tick();
    expect(pollCount()).toBe(afterFirstFailure + 1);

    // The log names the streak and the wait, so a reader can tell one failure
    // from the eight hundredth and see that the daemon is holding off.
    const failures = log.filter((l) => l.includes("command poll failed"));
    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatch(/1 in a row, retrying in 2s/);
    expect(failures[1]).toMatch(/2 in a row, retrying in 4s/);

    // Recovery resets the window: the next failure waits the minimum again.
    plane.setDown(false);
    clock += 5_000;
    await handle.tick();
    expect(log.some((l) => l.includes("command poll recovered"))).toBe(true);

    plane.setDown(true);
    clock += 100;
    await handle.tick();
    const afterRecovery = log.filter((l) => l.includes("command poll failed"));
    expect(afterRecovery[afterRecovery.length - 1]).toMatch(
      /1 in a row, retrying in 2s/,
    );
  });

  it("waits commandsPollMs between successful polls while ingest is idle", async () => {
    // The regression this guards: the poll's only gate was "an ingest landed
    // in the last commandsPollMs", and a successful poll did not count. A host
    // with nothing to ship therefore polled on every one-second tick, spent
    // the 30/min `tacho-host` budget in 30 s, and took 429s until the window
    // turned over. The live log showed it as a 429 streak ~30 s after every
    // "command poll recovered", once a minute (2026-09-23).
    const plane = fakeControlPlane("etag-idle");
    let clock = 1_000_000;
    const { handle } = await boot(plane, scratchPaths(), {
      now: () => clock,
      timers: {
        detectorMs: 0,
        sweepMs: 0,
        checkpointMs: 0,
        commandsPollMs: 30_000,
      },
    });
    const pollCount = () =>
      plane.calls.filter((u) => u.endsWith("/commands")).length;

    // Startup can ship a control envelope through ingestion. Let that
    // envelope's quiet window expire before measuring idle command polls.
    await handle.tick();
    clock += 30_000;
    await handle.tick();
    const first = pollCount();
    expect(first).toBeGreaterThanOrEqual(1);

    // A minute of one-second ticks with nothing to ship: one poll every 30 s,
    // not sixty.
    for (let i = 0; i < 60; i += 1) {
      clock += 1_000;
      await handle.tick();
    }
    expect(pollCount()).toBe(first + 2);
  });

  it.each([429, 503])(
    "obeys %s Retry-After on the command poll",
    async (status) => {
      const plane = fakeControlPlane("etag-429");
      let clock = 1_000_000;
      const { handle, log } = await boot(plane, scratchPaths(), {
        now: () => clock,
      });
      const pollCount = () =>
        plane.calls.filter((u) => u.endsWith("/commands")).length;

      plane.refuseCommandsWith({
        status,
        body: '{"error":"rate_limited"}',
        headers: { "retry-after": "20" },
      });
      await handle.tick();
      const afterRefusal = pollCount();

      // The guessed backoff would have retried at 2 s; the server said 20.
      clock += 19_000;
      await handle.tick();
      expect(pollCount()).toBe(afterRefusal);
      expect(
        log.filter((l) => l.includes("command poll failed")).at(-1),
      ).toMatch(/retrying in 20s/);

      clock += 1_500;
      await handle.tick();
      expect(pollCount()).toBe(afterRefusal + 1);
    },
  );

  it("does not grow the guessed backoff while the server names the wait", async () => {
    // A wait the server names is its answer, not a failure of our guess.
    // Doubling on it would leave the next unhinted outage starting at 4 s.
    const plane = fakeControlPlane("etag-429-then-503");
    let clock = 1_000_000;
    const { handle, log } = await boot(plane, scratchPaths(), {
      now: () => clock,
    });
    const lastFailure = () =>
      log.filter((l) => l.includes("command poll failed")).at(-1);

    plane.refuseCommandsWith({
      status: 429,
      body: '{"error":"rate_limited"}',
      headers: { "retry-after": "20" },
    });
    await handle.tick();
    expect(lastFailure()).toMatch(/retrying in 20s/);

    plane.refuseCommandsWith({ status: 503, body: "unavailable" });
    clock += 21_000;
    await handle.tick();
    expect(lastFailure()).toMatch(/2 in a row, retrying in 2s/);
  });

  it("parks the command poll for 15 minutes on a wire mismatch and keeps shipping events", async () => {
    // The regression this guards: on 2026-09-18 a daemon sending
    // `tacho.commands.v1` polled a control plane that requires v2. Every poll
    // was a 400, the backoff treated it as an outage and settled at one
    // attempt a minute, and 3,683 refusals in 2.5 h tripped the per-host
    // limiter so that event ingest was throttled with it. A refused schema
    // is not an outage: nothing but an upgrade changes the answer.
    const plane = fakeControlPlane("etag-mismatch");
    let clock = 2_000_000;
    const { handle, log, host } = await boot(plane, scratchPaths(), {
      now: () => clock,
    });
    const pollCount = () =>
      plane.calls.filter((u) => u.endsWith("/commands")).length;
    const ingestCount = () =>
      plane.calls.filter((u) => u.endsWith("/events")).length;

    plane.refuseCommandsWith({
      status: 400,
      body: '{"error":"schema: expected tacho.commands.v2"}',
    });
    await handle.tick();
    const afterRefusal = pollCount();
    expect(afterRefusal).toBeGreaterThan(0);

    // Inside the 15 minute floor nothing polls, not even past the 60 s the
    // ordinary backoff would have allowed.
    clock += 60_000 * 14;
    await handle.tick();
    expect(pollCount()).toBe(afterRefusal);
    clock += 60_000 * 1 + 1_000;
    await handle.tick();
    expect(pollCount()).toBe(afterRefusal + 1);

    // The one line says which status, which tachod, what the server said,
    // and what fixes it. Two refusals produced one line.
    const refused = log.filter((l) => l.includes("command poll refused"));
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain("400");
    expect(refused[0]).toContain(host.wrapper_version);
    expect(refused[0]).toContain("expected tacho.commands.v2");
    expect(refused[0]).toContain("upgraded");
    expect(log.filter((l) => l.includes("command poll failed"))).toHaveLength(
      0,
    );

    // Ingest is a separate path with its own budget: a hook that lands while
    // the poll is parked still ships on the next tick.
    const port = handle.port as number;
    const fixture = fixtures().find(
      (f) => f.stdin["hook_event_name"] === "PostToolUse",
    );
    expect(fixture).toBeDefined();
    const before = ingestCount();
    const res = await postHttp(
      port,
      host.local_token,
      `/hook/${TEST_ENROLLMENT}`,
      fixture?.stdin,
    );
    expect(res.status).toBe(200);
    clock += 1_000;
    await handle.tick();
    expect(ingestCount()).toBeGreaterThan(before);
    expect(plane.ingested.length).toBeGreaterThan(0);

    // A control plane that accepts the poll again clears the floor and the
    // once-only line, so a later mismatch is reported afresh.
    plane.refuseCommandsWith(undefined);
    clock += 60_000 * 15 + 1_000;
    await handle.tick();
    expect(log.some((l) => l.includes("command poll recovered"))).toBe(true);
    plane.refuseCommandsWith({ status: 422, body: "unprocessable" });
    clock += 1_000;
    await handle.tick();
    expect(log.filter((l) => l.includes("command poll refused"))).toHaveLength(
      2,
    );
  });
});
