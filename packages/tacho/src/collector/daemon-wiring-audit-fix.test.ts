/**
 * The daemon's side of the collector audit fixes: a redelivered command is
 * applied once and answered the same way again; a pending terminal carries
 * this session's state and not the host's tombstones; a `cd` inside one
 * repository keeps the session's baseline; a message whose session sealed
 * first is acknowledged `expired`; a bundle signed for another host does not
 * verify; a signed suspension outranks an unsigned `active`; OTel records
 * for a session whose terminal is not yet written are not sealed past it;
 * and the hook handler matches rules with the host's home and honours the
 * harness's read-only claim.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaudeCodeContext } from "../claude-code/context";
import { digestText } from "../claude-code/context";
import type { TachoEvent } from "../envelope";
import type { FetchLike } from "../host/control-client";
import { writeSensitiveFileAtomic } from "../host/fs";
import { writeHostFile } from "../host/host-file";
import type { Exec } from "../host/service";
import { mergeTachoSettings } from "../host/settings-writer";
import {
  bundleSigner,
  scratchPaths,
  TEST_ENROLLMENT,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import type {
  CommandAcknowledgement,
  ControlEnvelope,
  DeliveredCommand,
  PolicyBundle,
} from "../wire";
import { type DaemonHandle, type DaemonTimers, startDaemon } from "./daemon";
import { handleHookEvent, type PolicyView } from "./hook-handler";
import { applyCommands, HandledCommands, type InboxDeps } from "./inbox";
import {
  EXPIRED_ON_SEAL_DETAIL,
  sessionMapKey,
  SessionRegistry,
} from "./registry";

const SESSION = "11111111-2222-3333-4444-555555555555";
const CWD = "/repo";
const BASELINE_SHA = "a".repeat(40);
const LATER_SHA = "b".repeat(40);

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

/** A git that answers canned stdout for any directory. */
function fakeGit(answers: () => Record<string, string>): Exec {
  return (cmd, args) => {
    if (cmd !== "git") return { status: 127, stdout: "", stderr: "" };
    for (const [key, value] of Object.entries(answers()))
      if (args.join(" ").includes(key))
        return { status: 0, stdout: value, stderr: "" };
    return { status: 1, stdout: "", stderr: "no answer" };
  };
}

function repoAnswers(head: string): Record<string, string> {
  return {
    "rev-parse HEAD": `${head}\n`,
    "rev-parse --abbrev-ref HEAD": "main\n",
    "rev-parse --show-toplevel": `${CWD}\n`,
    "status --porcelain=v1 -z": "",
    "status --porcelain": "",
    "diff --name-status -z": "",
    "diff --numstat": "",
  };
}

/** A control plane that hands out what the test queues and keeps the acks. */
function fakePlane(etag: string) {
  const queue: DeliveredCommand[] = [];
  const acks: CommandAcknowledgement[] = [];
  let bundle: PolicyBundle | undefined;
  // Once set, every request (or every request to the named endpoints) is
  // refused the way the API refuses the key a revoke retired: 403 with the
  // reason `host_revoked`.
  let revoked: readonly string[] | "all" | undefined;
  const requests: string[] = [];
  const control = (): ControlEnvelope => ({
    host_status: "active",
    deny_generation: { org: 1, workspace: 1 },
    bundle_etag: etag,
    commands: queue.splice(0),
  });
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
    requests.push(url);
    if (
      revoked === "all" ||
      (revoked !== undefined && revoked.some((path) => url.endsWith(path)))
    ) {
      return {
        ok: false,
        status: 403,
        text: async () =>
          JSON.stringify({
            error: {
              code: "forbidden",
              reason: "host_revoked",
              message: "Forbidden: Tacho host enrollment revoked",
            },
            requestId: "req_revoked",
          }),
      };
    }
    if (url.endsWith("/events")) {
      const events = body["events"] as TachoEvent[];
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
            bundle === undefined
              ? { not_modified: true, etag, bundle: null }
              : { not_modified: false, etag: bundle.etag, bundle },
          ),
      };
    }
    if (url.endsWith("/commands")) {
      const sent = body["acknowledgements"] as CommandAcknowledgement[];
      acks.push(...sent);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ acknowledged: sent.length, control: control() }),
      };
    }
    return { ok: false, status: 404, text: async () => "nope" };
  };
  return {
    fetch,
    acks,
    requests,
    queue: (delivered: DeliveredCommand) => queue.push(delivered),
    offerBundle: (next: PolicyBundle) => {
      bundle = next;
    },
    revoke: (only?: readonly string[]) => {
      revoked = only ?? "all";
    },
  };
}

function hook(name: string, extra: Record<string, unknown> = {}) {
  return {
    payload: { session_id: SESSION, hook_event_name: name, ...extra },
    env: {},
  };
}

describe("the daemon's audit wiring", () => {
  const handles: DaemonHandle[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const handle of handles.splice(0)) await handle.stop();
  });

  async function boot(
    options: {
      bundle?: Partial<Omit<PolicyBundle, "signature">>;
      /** Sign with a key the host file does not hold. */
      foreignKey?: boolean;
      git?: () => Record<string, string>;
      paths?: ReturnType<typeof scratchPaths>;
      log?: string[];
      timers?: Partial<DaemonTimers>;
    } = {},
  ) {
    const paths = options.paths ?? scratchPaths();
    const signer = bundleSigner();
    const bundle = (options.foreignKey === true ? bundleSigner() : signer).sign(
      unsignedBundle(options.bundle),
    );
    // The host file's own status stays `active`, whatever the bundle says.
    const host = testHostFile(signer, bundle, { host_status: "active" });
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
    const plane = fakePlane(bundle.etag);
    const handle = await startDaemon({
      paths,
      fetch: plane.fetch,
      exec: fakeGit(options.git ?? (() => repoAnswers(BASELINE_SHA))),
      now: () => 1_000,
      log: (line) => options.log?.push(line),
      listen: false,
      transcriptRoots: [`${paths.root}/no-transcripts`],
      timers: {
        detectorMs: 0,
        sweepMs: 0,
        checkpointMs: 0,
        commandsPollMs: 0,
        ...options.timers,
      },
    });
    handles.push(handle);
    return { handle, plane, signer, paths };
  }

  it("injects a redelivered steer once and acknowledges each delivery the same way", async () => {
    const { handle, plane } = await boot();
    await handle.api.handleHook(hook("SessionStart"));
    const record = handle.registry.get(SESSION)!;
    const steer = command({
      id: "cmd_steer",
      command: "steer",
      session_uuid: record.recorder.sessionUuid,
      payload: { text: "Stop after this file." },
    });
    plane.queue(steer);
    await handle.tick();
    // The acknowledgement was lost; the control plane sends the row again.
    plane.queue({ ...steer });
    await handle.tick();
    expect(record.control.messages.map((m) => m.id)).toEqual(["cmd_steer"]);
    const response = await handle.api.handleHook(
      hook("UserPromptSubmit", { prompt: "go on" }),
    );
    expect(response).toMatchObject({
      hookSpecificOutput: { additionalContext: "Stop after this file." },
    });
    await handle.tick();
    expect(
      plane.acks
        .filter((a) => a.command_id === "cmd_steer")
        .map((a) => a.status),
    ).toEqual(["received", "received", "applied"]);
  });

  it("keeps a steer queued and unacknowledged when its delivery frame fails to reach the WAL", async () => {
    const { handle, plane } = await boot();
    await handle.api.handleHook(hook("SessionStart"));
    const record = handle.registry.get(SESSION)!;
    plane.queue(
      command({
        id: "cmd_lost",
        command: "steer",
        session_uuid: record.recorder.sessionUuid,
        payload: { text: "Stop after this file." },
      }),
    );
    await handle.tick();
    expect(record.control.messages.map((m) => m.id)).toEqual(["cmd_lost"]);

    const append = handle.wal.append.bind(handle.wal);
    handle.wal.append = () => {
      throw new Error("ENOSPC: no space left on device");
    };
    await expect(
      handle.api.handleHook(hook("UserPromptSubmit", { prompt: "go on" })),
    ).rejects.toThrow(/ENOSPC/);
    handle.wal.append = append;

    // The failed write took the delivery frame back, so the steer waits for
    // the next boundary and the plane hears nothing claiming it applied.
    expect(record.control.messages.map((m) => m.id)).toEqual(["cmd_lost"]);
    await handle.tick();
    expect(
      plane.acks
        .filter((a) => a.command_id === "cmd_lost")
        .map((a) => a.status),
    ).toEqual(["received"]);

    const response = await handle.api.handleHook(
      hook("UserPromptSubmit", { prompt: "go on" }),
    );
    expect(response).toMatchObject({
      hookSpecificOutput: { additionalContext: "Stop after this file." },
    });
    await handle.tick();
    const applied = plane.acks.find(
      (a) => a.command_id === "cmd_lost" && a.status === "applied",
    );
    expect(applied?.applied_at_seq).toBeDefined();
    const frame = handle.wal
      .read(record.recorder.sessionUuid)
      .find((event) => event.seq === applied?.applied_at_seq);
    expect(frame?.attrs?.["command.id"]).toBe("cmd_lost");
  });

  it("acknowledges a message whose session sealed before a boundary as expired", async () => {
    const { handle, plane } = await boot();
    await handle.api.handleHook(hook("SessionStart"));
    const uuid = handle.registry.get(SESSION)!.recorder.sessionUuid;
    plane.queue(
      command({
        id: "cmd_late",
        command: "message",
        session_uuid: uuid,
        payload: { text: "Too late." },
      }),
    );
    await handle.tick();
    await handle.api.handleHook(hook("SessionEnd"));
    expect(handle.registry.get(SESSION)?.sealed).toBe(true);
    await handle.tick();
    expect(plane.acks.filter((a) => a.command_id === "cmd_late")).toEqual([
      { command_id: "cmd_late", status: "received", session_uuid: uuid },
      {
        command_id: "cmd_late",
        status: "expired",
        session_uuid: uuid,
        detail: EXPIRED_ON_SEAL_DETAIL,
      },
    ]);
  });

  it("sends no expired ack for a steer whose SessionEnd write failed", async () => {
    const { handle, plane } = await boot();
    await handle.api.handleHook(hook("SessionStart"));
    const record = handle.registry.get(SESSION)!;
    const uuid = record.recorder.sessionUuid;
    plane.queue(
      command({
        id: "cmd_kept",
        command: "steer",
        session_uuid: uuid,
        payload: { text: "Stop after this file." },
      }),
    );
    await handle.tick();
    expect(record.control.messages.map((m) => m.id)).toEqual(["cmd_kept"]);

    // The seal queues `expired` for the steer before the terminal frame is
    // written. The write fails, so the seal did not happen.
    const append = handle.wal.append.bind(handle.wal);
    handle.wal.append = () => {
      throw new Error("ENOSPC: no space left on device");
    };
    await expect(handle.api.handleHook(hook("SessionEnd"))).rejects.toThrow(
      /ENOSPC/,
    );
    handle.wal.append = append;

    expect(record.sealed).toBe(false);
    expect(record.control.messages.map((m) => m.id)).toEqual(["cmd_kept"]);
    await handle.tick();
    expect(
      plane.acks
        .filter((a) => a.command_id === "cmd_kept")
        .map((a) => a.status),
    ).toEqual(["received"]);

    // A boundary still delivers it, and the plane hears one outcome.
    const response = await handle.api.handleHook(
      hook("UserPromptSubmit", { prompt: "go on" }),
    );
    expect(response).toMatchObject({
      hookSpecificOutput: { additionalContext: "Stop after this file." },
    });
    await handle.tick();
    expect(
      plane.acks
        .filter((a) => a.command_id === "cmd_kept")
        .map((a) => a.status),
    ).toEqual(["received", "applied"]);
  });

  it("keeps the baseline across a cd inside the same repository", async () => {
    let head = BASELINE_SHA;
    const { handle } = await boot({ git: () => repoAnswers(head) });
    await handle.api.handleHook(hook("SessionStart", { cwd: CWD }));
    await handle.tick();
    expect(handle.registry.get(SESSION)?.baselineCommit).toBe(BASELINE_SHA);
    // The session commits, then moves into a subdirectory of the same tree.
    head = LATER_SHA;
    await handle.api.handleHook(
      hook("UserPromptSubmit", { cwd: `${CWD}/packages/app`, prompt: "go" }),
    );
    await handle.tick();
    const record = handle.registry.get(SESSION)!;
    expect(record.cwd).toBe(`${CWD}/packages/app`);
    expect(record.baselineCommit).toBe(BASELINE_SHA);
    expect(record.baselines).toEqual({ [CWD]: BASELINE_SHA });
  });

  it("leaves the host's tombstones out of a pending terminal", async () => {
    const paths = scratchPaths();
    const forgotten = sessionMapKey("forgotten-session");
    writeSensitiveFileAtomic(
      paths.daemonState,
      JSON.stringify({
        schema: "tacho.daemon-state.v1",
        sessions: [],
        tombstones: [
          {
            key: forgotten,
            sessionUuid: "00000000-0000-4000-8000-000000000042",
            cursor: { seq: 3, prevHash: digestText("chain head") },
            turnSeq: 1,
            forgottenAt: "1970-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    const { handle } = await boot({ paths });
    await handle.api.handleHook(hook("SessionStart", { cwd: CWD }));
    await handle.api.handleHook(hook("SessionEnd", { cwd: CWD }));
    const append = handle.wal.append.bind(handle.wal);
    vi.spyOn(handle.wal, "append").mockImplementation((events, bodies) => {
      if (events.some((event) => event.kind === "agent_stop"))
        throw Object.assign(new Error("event disk full"), { code: "ENOSPC" });
      append(events, bodies);
    });
    await handle.tick();
    expect(handle.registry.get(SESSION)?.pendingTerminal).toBe(true);
    const pending = JSON.parse(
      readFileSync(paths.pendingEnds, "utf8"),
    ) as Array<[string, { terminal?: { state: { tombstones?: unknown[] } } }]>;
    expect(pending).toHaveLength(1);
    expect(pending[0]?.[1].terminal?.state.tombstones ?? []).toEqual([]);
    expect(handle.registry.state().tombstones?.map((t) => t.key)).toEqual([
      forgotten,
    ]);
  });

  it("seals no OTel record past a terminal that is not yet written", async () => {
    const log: string[] = [];
    const { handle } = await boot({ log });
    await handle.api.handleHook(hook("SessionStart", { cwd: CWD }));
    await handle.api.handleHook(hook("SessionEnd", { cwd: CWD }));
    const uuid = handle.registry.get(SESSION)!.recorder.sessionUuid;
    const append = handle.wal.append.bind(handle.wal);
    let failuresLeft = 1;
    const fault = vi
      .spyOn(handle.wal, "append")
      .mockImplementation((events, bodies) => {
        if (
          failuresLeft > 0 &&
          events.some((event) => event.kind === "agent_stop")
        ) {
          failuresLeft -= 1;
          throw Object.assign(new Error("event disk full"), {
            code: "ENOSPC",
          });
        }
        append(events, bodies);
      });
    await handle.tick();
    expect(handle.registry.get(SESSION)?.pendingTerminal).toBe(true);
    const cursor = handle.registry.get(SESSION)!.recorder.chainCursor.seq;
    const logs = readFileSync(
      join(
        __dirname,
        "..",
        "..",
        "fixtures",
        "claude-code",
        "otlp",
        "03-v1_logs.json",
      ),
      "utf8",
    ).replaceAll("340ed354-6344-4727-9f8b-1e40b5e12aa7", SESSION);
    await handle.api.handleOtlp("logs", JSON.parse(logs));
    expect(handle.registry.get(SESSION)!.recorder.chainCursor.seq).toBe(cursor);
    expect(log.some((line) => line.includes("dropped"))).toBe(true);
    await handle.tick();
    fault.mockRestore();
    expect(handle.registry.get(SESSION)?.sealed).toBe(true);
    const chain = handle.wal.read(uuid);
    expect(chain.map((event) => event.seq)).toEqual(chain.map((_, i) => i));
    expect(chain.at(-1)?.kind).toBe("agent_stop");
    expect(chain.some((event) => event.source === "otel_log")).toBe(false);
  });

  it("does not verify a bundle signed for another host", async () => {
    const log: string[] = [];
    const { handle, plane, signer } = await boot({ log });
    expect(handle.api.status()).toMatchObject({ bundle_verified: true });
    plane.offerBundle(
      signer.sign(
        unsignedBundle({
          etag: "etag-other-host",
          version: 4,
          host_enrollment_id: "tch_0123456789abcdefghjkmp",
        }),
      ),
    );
    expect(await handle.refreshBundle()).toBe(false);
    expect(handle.host().bundle.etag).toBe("etag-3");
    expect(
      log.some((line) =>
        line.includes("bundle is for host tch_0123456789abcdefghjkmp"),
      ),
    ).toBe(true);
  });

  it("does not trust a cached bundle signed for another host", async () => {
    const { handle } = await boot({
      bundle: { host_enrollment_id: "tch_0123456789abcdefghjkmp" },
    });
    expect(handle.api.status()).toMatchObject({ bundle_verified: false });
  });

  it("holds a signed suspension over an unsigned active host status", async () => {
    const { handle } = await boot({ bundle: { host_status: "suspended" } });
    const response = await handle.api.handleHook(
      hook("PreToolUse", {
        tool_name: "Read",
        tool_input: { file_path: "/repo/README.md" },
        tool_use_id: "toolu_1",
      }),
    );
    expect(response).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining("suspended"),
      },
    });
  });

  it("marks the host revoked, stops shipping and refuses tools once the control plane answers host_revoked", async () => {
    // A revoke retires the host's key, so no control envelope can carry the
    // revoked status. The refusal is the only word the host gets (#3944).
    // A bundle refresh on every tick, so the test sees it stop too.
    const { handle, plane, paths } = await boot({
      timers: { bundleRefreshMs: 0 },
    });
    await handle.api.handleHook(hook("SessionStart"));
    plane.revoke();
    const before = plane.requests.length;
    await handle.tick();
    expect(handle.shipper.hostRevoked).toBe(true);
    expect(handle.host().host_status).toBe("revoked");
    expect(
      (
        JSON.parse(readFileSync(paths.hostFile, "utf8")) as Record<
          string,
          unknown
        >
      )["host_status"],
    ).toBe("revoked");
    expect(handle.api.status()).toMatchObject({
      host_status: "revoked",
      last_error: expect.stringContaining("revoked this host's enrollment"),
    });
    // One refused bundle refresh and one refused ingest, and then nothing
    // more goes to the control plane: no refresh, no ingest, no command poll.
    await handle.tick();
    await handle.tick();
    expect(plane.requests.slice(before)).toEqual([
      expect.stringMatching(/\/bundle$/),
      expect.stringMatching(/\/events$/),
    ]);
    const response = await handle.api.handleHook(
      hook("PreToolUse", {
        tool_name: "Read",
        tool_input: { file_path: "/repo/README.md" },
        tool_use_id: "toolu_revoked",
      }),
    );
    expect(response).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining("revoked"),
      },
    });
  });

  it("stops shipping but keeps serving live sessions when this machine started the revoke", async () => {
    // `tacho reassign`, `unenroll` and a harness add revoke first and mark
    // host.json `revoked_at`, then replace or remove this daemon. Until then
    // the harnesses still call through it, and a harness-only reassign keeps
    // their sessions (ADR-179), so the old key's refusal must not refuse
    // their tools and model calls.
    const log: string[] = [];
    const { handle, plane, paths } = await boot({ log });
    await handle.api.handleHook(hook("SessionStart"));
    writeHostFile(paths.hostFile, {
      ...handle.host(),
      revoked_at: "2026-09-25T20:00:00.000Z",
    });
    plane.revoke();
    await handle.tick();
    expect(handle.shipper.hostRevoked).toBe(true);
    // The status the hooks and the model proxy read is unchanged, in memory
    // and on disk.
    expect(handle.host().host_status).toBe("active");
    expect(
      (
        JSON.parse(readFileSync(paths.hostFile, "utf8")) as Record<
          string,
          unknown
        >
      )["host_status"],
    ).toBe("active");
    expect(log.some((line) => line.includes("revoked from this machine"))).toBe(
      true,
    );
    const response = await handle.api.handleHook(
      hook("PreToolUse", {
        tool_name: "Read",
        tool_input: { file_path: "/repo/README.md" },
        tool_use_id: "toolu_local_revoke",
      }),
    );
    expect(response).not.toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
  });

  it("learns the revocation from a refused command poll too, and stops shipping", async () => {
    // A host with nothing to ship still polls for commands, so it hears the
    // refusal there instead of waiting for its next ingest.
    const { handle, plane } = await boot();
    plane.revoke(["/commands"]);
    await handle.tick();
    expect(handle.shipper.hostRevoked).toBe(true);
    expect(handle.host().host_status).toBe("revoked");
    const sent = plane.requests.length;
    await handle.api.handleHook(hook("SessionStart"));
    await handle.tick();
    expect(plane.requests).toHaveLength(sent);
  });

  it("reads the host status from host.json alone when the bundle does not verify", async () => {
    const { handle } = await boot({
      bundle: { host_status: "suspended", mode: "observe" },
      foreignKey: true,
    });
    await handle.api.handleHook(
      hook("PreToolUse", {
        tool_name: "Read",
        tool_input: { file_path: "/repo/README.md" },
        tool_use_id: "toolu_1",
      }),
    );
    const decision = handle.registry
      .get(SESSION)!
      .recorder.sealedEvents.find((event) => event.kind === "policy_decision");
    expect(
      (decision?.body as { policy_reason_code?: string }).policy_reason_code,
    ).toBe("bundle_unverified");
  });
});

describe("command redelivery in the inbox", () => {
  function setup() {
    const now = () => Date.parse("2026-09-10T10:00:00.000Z");
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
    const deps: InboxDeps = {
      registry,
      hostRecorder: () => host.recorder,
      kill: (pid, signal) => {
        kills.push(`${pid}:${signal}`);
        return true;
      },
      refreshBundle: async () => undefined,
      onHostSuspended: () => undefined,
      now,
      handled: new HandledCommands(),
    };
    return { agent, kills, deps };
  }

  it("signals a redelivered kill once and repeats its acknowledgement", async () => {
    const { agent, kills, deps } = setup();
    const kill = command({
      id: "cmd_kill",
      command: "kill",
      session_uuid: agent.recorder.sessionUuid,
    });
    const first = await applyCommands([kill], deps);
    const second = await applyCommands([kill], deps);
    expect(kills).toEqual(["4242:SIGKILL"]);
    expect(second.acknowledgements).toEqual(first.acknowledgements);
    expect(second.events).toEqual([]);
    expect(second.applied).toEqual([]);
  });

  it("applies a command listed twice in one delivery once", async () => {
    const { agent, deps } = setup();
    const steer = command({
      id: "cmd_twice",
      command: "steer",
      session_uuid: agent.recorder.sessionUuid,
      payload: { text: "Once." },
    });
    const result = await applyCommands([steer, { ...steer }], deps);
    expect(agent.control.messages.map((m) => m.id)).toEqual(["cmd_twice"]);
    expect(result.acknowledgements.map((a) => a.status)).toEqual([
      "received",
      "received",
    ]);
  });

  it("forgets the oldest command past its bound", () => {
    const handled = new HandledCommands(2);
    for (const id of ["a", "b", "c"])
      handled.remember({ command_id: id, status: "applied" });
    expect(handled.get("a")).toBeUndefined();
    expect(handled.get("c")).toEqual({ command_id: "c", status: "applied" });
  });
});

describe("hook handler rule inputs", () => {
  function harness(permissions: PolicyBundle["permissions"]) {
    const signer = bundleSigner();
    const bundle = signer.sign(unsignedBundle({ permissions }));
    const now = () => Date.parse("2026-09-10T10:00:00.000Z");
    const registry = new SessionRegistry({
      context: CONTEXT,
      scope: TEST_ENROLLMENT,
      now,
    });
    const view: PolicyView = {
      bundle,
      verified: true,
      hostStatus: "active",
      denyGeneration: bundle.deny_generation,
      controlReachable: true,
    };
    return { registry, policy: () => view, now };
  }

  function preToolUse(extra: Record<string, unknown>) {
    return {
      session_id: SESSION,
      hook_event_name: "PreToolUse",
      tool_use_id: "toolu_1",
      ...extra,
    };
  }

  it("matches a home-relative rule with the host's home when none is given", async () => {
    const deps = harness({
      allow: ["Read"],
      deny: ["Read(~/secrets/**)"],
      ask: [],
    });
    const outcome = await handleHookEvent(
      preToolUse({
        tool_name: "Read",
        tool_input: { file_path: join(homedir(), "secrets", "key.pem") },
      }),
      {},
      deps,
    );
    expect(outcome.evaluation).toMatchObject({
      decision: "deny",
      rule: "Read(~/secrets/**)",
    });
  });

  it("passes the harness's read-only claim to the evaluator", async () => {
    const deps = harness({ allow: [], deny: [], ask: [] });
    const claimed = await handleHookEvent(
      preToolUse({ tool_name: "mcp__stella__lookup", tool_read_only: true }),
      {},
      deps,
    );
    expect(claimed.evaluation?.read_only).toBe(true);
    const unclaimed = await handleHookEvent(
      preToolUse({ tool_name: "mcp__stella__lookup", tool_use_id: "toolu_2" }),
      {},
      deps,
    );
    expect(unclaimed.evaluation?.read_only).toBe(false);
  });
});
