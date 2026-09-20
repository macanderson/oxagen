/**
 * Per-agent health: the registry's roster (which agents a host has run,
 * across `forgetSealed` and a daemon restart), custom agents labelled
 * `runtime: "custom"`, Stella's pid arriving as `TACHO_HARNESS_PID`, and a
 * session whose process exits after `Stop` closing as completed.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ClaudeCodeContext } from "../claude-code/context";
import { writeHostFile } from "../host/host-file";
import {
  bundleSigner,
  scratchPaths,
  TEST_ENROLLMENT,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import { type DaemonHandle, startDaemon } from "./daemon";
import { handleHookEvent, pidFromEnv, type PolicyView } from "./hook-handler";
import {
  contextForHarness,
  isInternalSession,
  type RegistryState,
  type SessionRecord,
  SessionRegistry,
} from "./registry";

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

function clockAt(iso: string) {
  let clock = Date.parse(iso);
  return {
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

function start(record: SessionRecord): void {
  record.recorder.sealCollectorEvent("agent_start", {
    session_start_source: "startup",
  });
}

describe("agent roster", () => {
  it("counts sessions per agent, keeps entries past forgetSealed, and survives persistence", () => {
    const clock = clockAt("2026-09-15T10:00:00.000Z");
    const registry = new SessionRegistry({
      context: CONTEXT,
      scope: TEST_ENROLLMENT,
      now: clock.now,
    });
    registry.ensure("tachod-01J000", { pid: 1 });
    registry.ensure("claude-1", { harness: "claude-code" });
    registry.ensure("codex-1", { harness: "codex" });
    clock.advance(1_000);
    registry.ensure("stella-10", { harness: "stella", pid: 10 });
    registry.ensure("rev-1", { customAgent: "reviewer" });
    registry.ensure("rev-2", { customAgent: "reviewer", harness: "stella" });
    // A later sighting updates last_seen, never the count.
    clock.advance(1_000);
    registry.ensure("rev-1", { lastHookEvent: "Stop" });
    registry.touch("codex-1");
    registry.touch("unknown");
    registry.seal("rev-2");

    const agents = registry.agents();
    expect(agents.map((a) => a.key)).toEqual([
      "claude-code:claude-code",
      "codex:codex",
      "stella:stella",
      "custom:reviewer",
    ]);
    expect(agents.find((a) => a.key === "custom:reviewer")).toEqual({
      key: "custom:reviewer",
      runtime: "custom",
      harness: "reviewer",
      label: "reviewer",
      first_seen_at: "2026-09-15T10:00:01.000Z",
      last_seen_at: "2026-09-15T10:00:02.000Z",
      sessions_total: 2,
      sessions_live: 1,
    });
    expect(agents.find((a) => a.key === "codex:codex")).toMatchObject({
      label: "Codex",
      sessions_total: 1,
      sessions_live: 1,
      last_seen_at: "2026-09-15T10:00:02.000Z",
    });
    expect(agents.find((a) => a.key === "stella:stella")?.label).toBe("Stella");
    expect(isInternalSession("tachod-01J000")).toBe(true);
    expect(registry.get("rev-1")?.lastHookEvent).toBe("Stop");
    expect(registry.agentOf({})).toMatchObject({
      key: "claude-code:claude-code",
      label: "Claude Code",
    });

    // Sealed sessions age out; the agents they belonged to stay counted.
    registry.seal("rev-1");
    clock.advance(8 * 24 * 60 * 60_000);
    expect(registry.forgetSealed(7 * 24 * 60 * 60_000).sort()).toEqual([
      "rev-1",
      "rev-2",
    ]);
    const reviewer = registry.agents().find((a) => a.key === "custom:reviewer");
    expect(reviewer).toMatchObject({ sessions_total: 2, sessions_live: 0 });

    const state = JSON.parse(JSON.stringify(registry.state())) as RegistryState;
    const restored = new SessionRegistry({
      context: CONTEXT,
      scope: TEST_ENROLLMENT,
      now: clock.now,
    });
    restored.restore(state);
    expect(restored.agents()).toEqual(registry.agents());
    expect(restored.get("stella-10")?.harness).toBe("stella");
    // A state file from before the roster loads with an empty roster.
    const legacy = new SessionRegistry({
      context: CONTEXT,
      scope: TEST_ENROLLMENT,
      now: clock.now,
    });
    legacy.restore({ schema: state.schema, sessions: state.sessions });
    expect(legacy.agents()).toEqual([]);
  });

  it("keeps two agents that share one harness session id on separate chains", () => {
    const clock = clockAt("2026-09-15T10:00:00.000Z");
    const registry = new SessionRegistry({
      context: CONTEXT,
      scope: TEST_ENROLLMENT,
      now: clock.now,
    });
    const first = registry.ensure("sess-1", { customAgent: "reviewer" });
    start(first.record);
    registry.seal(first.record);
    clock.advance(1_000);
    const second = registry.ensure("sess-1", { customAgent: "builder" });
    expect(second.created).toBe(true);
    expect(second.record.sealed).toBe(false);
    expect(second.record.recorder.sessionUuid).not.toBe(
      first.record.recorder.sessionUuid,
    );
    // The id reported over the wire stays the raw one the harness gave.
    expect(second.record.harnessSessionId).toBe("sess-1");
    // The first agent coming back still lands on its own record.
    expect(registry.ensure("sess-1", { customAgent: "reviewer" }).record).toBe(
      first.record,
    );
    // A caller that names no agent (OTel) takes the live chain.
    expect(registry.get("sess-1")).toBe(second.record);
    expect(
      registry
        .agents()
        .map((a) => a.key)
        .sort(),
    ).toEqual(["custom:builder", "custom:reviewer"]);
    // A harness and a custom agent sharing an id are two agents too.
    expect(registry.ensure("sess-1", { harness: "stella" }).created).toBe(true);
    const restored = new SessionRegistry({
      context: CONTEXT,
      scope: TEST_ENROLLMENT,
      now: clock.now,
    });
    restored.restore(
      JSON.parse(JSON.stringify(registry.state())) as RegistryState,
    );
    expect(restored.list()).toHaveLength(3);
  });

  it("gives an adopted ambient session the identity of the agent that claims it", () => {
    const clock = clockAt("2026-09-15T10:00:00.000Z");
    const registry = new SessionRegistry({
      context: CONTEXT,
      scope: TEST_ENROLLMENT,
      now: clock.now,
    });
    // OTel saw the session before any hook named its owner.
    const ambient = registry.ensure("sess-amb", { ambient: true, pid: 77 });
    const unknown = ambient.record.recorder.sealCollectorEvent("agent_start", {
      session_start_source: "startup",
    });
    expect(unknown.agent).toMatchObject({
      runtime: "proxy",
      harness: "unknown",
    });
    const uuid = ambient.record.recorder.sessionUuid;
    clock.advance(1_000);
    const claimed = registry.ensure("sess-amb", { harness: "stella" });
    // One chain, not a fork.
    expect(claimed.created).toBe(false);
    expect(claimed.record).toBe(ambient.record);
    expect(claimed.record.recorder.sessionUuid).toBe(uuid);
    // ...and every view of it now says Stella: the facts, the events the
    // recorder seals from here, and the roster.
    expect(claimed.record.harness).toBe("stella");
    expect(registry.agentOf(claimed.record).key).toBe("stella:stella");
    const event = claimed.record.recorder.sealCollectorEvent(
      "oxagen:notification",
      { notification_type: "init" },
    );
    expect(event.agent as { harness: string; runtime: string }).toMatchObject({
      harness: "stella",
      runtime: "stella",
    });
    expect(registry.agents().map((a) => [a.key, a.sessions_total])).toEqual([
      ["stella:stella", 1],
    ]);
    // Persistence keeps it Stella's rather than filing it as unclaimed again.
    const restored = new SessionRegistry({
      context: CONTEXT,
      scope: TEST_ENROLLMENT,
      now: clock.now,
    });
    restored.restore(
      JSON.parse(JSON.stringify(registry.state())) as RegistryState,
    );
    expect(restored.ensure("sess-amb", { harness: "stella" }).created).toBe(
      false,
    );
    expect(restored.get("sess-amb")?.harness).toBe("stella");

    // A custom agent cannot adopt: its chain uuid is seeded from its name as
    // well as the id, so it opens its own record instead of renaming a chain
    // that is already running.
    const other = new SessionRegistry({
      context: CONTEXT,
      scope: TEST_ENROLLMENT,
      now: clock.now,
    });
    const loose = other.ensure("sess-amb", { ambient: true });
    start(loose.record);
    const custom = other.ensure("sess-amb", { customAgent: "reviewer" });
    expect(custom.created).toBe(true);
    expect(custom.record).not.toBe(loose.record);
    expect(custom.record.recorder.sessionUuid).not.toBe(
      loose.record.recorder.sessionUuid,
    );
  });

  it("closes a session whose process exited after Stop as completed, and anything else as crashed", () => {
    const clock = clockAt("2026-09-15T10:00:00.000Z");
    const registry = new SessionRegistry({
      context: CONTEXT,
      scope: TEST_ENROLLMENT,
      now: clock.now,
    });
    const done = registry.ensure("stella-1", {
      harness: "stella",
      pid: 1001,
      lastHookEvent: "Stop",
    }).record;
    const mid = registry.ensure("stella-2", {
      harness: "stella",
      pid: 1002,
      lastHookEvent: "PostToolUse",
    }).record;
    const idle = registry.ensure("stella-3", {
      harness: "stella",
      lastHookEvent: "Stop",
    }).record;
    for (const record of [done, mid, idle]) start(record);
    clock.advance(10 * 60_000);
    const sealed = registry.sweep(() => false, 5 * 60_000);
    expect(
      sealed.map((e) => [
        e.session_id,
        (e.body as { session_outcome: string }).session_outcome,
      ]),
    ).toEqual([
      ["stella-1", "completed"],
      ["stella-2", "crashed"],
      // Idle with no pid: nothing says the process ended cleanly.
      ["stella-3", "crashed"],
    ]);
    expect(
      sealed[0]?.agent as { runtime: string; harness: string },
    ).toMatchObject({ runtime: "stella", harness: "stella" });
  });
});

describe("custom agents and harness pids in the hook handler", () => {
  function deps() {
    const signer = bundleSigner();
    const bundle = signer.sign(unsignedBundle());
    const clock = clockAt("2026-09-15T10:00:00.000Z");
    const registry = new SessionRegistry({
      context: CONTEXT,
      scope: TEST_ENROLLMENT,
      now: () => {
        clock.advance(1_000);
        return clock.now();
      },
    });
    const view: PolicyView = {
      bundle,
      verified: true,
      hostStatus: "active",
      denyGeneration: bundle.deny_generation,
      controlReachable: true,
    };
    return { registry, policy: () => view, now: clock.now };
  }

  it("labels a custom agent's session custom, over any harness, and refuses a bad name", async () => {
    const d = deps();
    const outcome = await handleHookEvent(
      { session_id: "rev-1", hook_event_name: "SessionStart", cwd: "/repo" },
      {},
      d,
      undefined,
      "stella",
      "reviewer",
    );
    expect(outcome.events[0]?.agent).toMatchObject({
      runtime: "custom",
      harness: "reviewer",
    });
    expect(d.registry.get("rev-1")).toMatchObject({
      customAgent: "reviewer",
      lastHookEvent: "SessionStart",
    });
    const restored = new SessionRegistry({
      context: CONTEXT,
      scope: TEST_ENROLLMENT,
      now: d.now,
    });
    restored.restore(d.registry.state());
    const later = await handleHookEvent(
      { session_id: "rev-1", hook_event_name: "UserPromptSubmit", prompt: "x" },
      {},
      { ...d, registry: restored },
      undefined,
      undefined,
      "reviewer",
    );
    expect(later.events[0]?.agent).toMatchObject({ runtime: "custom" });
    expect(restored.get("rev-1")?.lastHookEvent).toBe("UserPromptSubmit");
    await expect(
      handleHookEvent(
        { session_id: "x", hook_event_name: "SessionStart" },
        {},
        d,
        undefined,
        undefined,
        "Not A Slug",
      ),
    ).rejects.toThrow(/invalid custom agent name/);
    // A poster with the local token cannot claim a built-in name either.
    await expect(
      handleHookEvent(
        { session_id: "x", hook_event_name: "SessionStart" },
        {},
        d,
        undefined,
        undefined,
        "stella",
      ),
    ).rejects.toThrow(/"stella" is a built-in harness or runtime name/);
    expect(d.registry.get("x")).toBeUndefined();
    expect(contextForHarness(CONTEXT, undefined, "bot").agent).toMatchObject({
      runtime: "custom",
      harness: "bot",
    });
  });

  it("takes the harness pid from CLAUDE_PID, then TACHO_HARNESS_PID", async () => {
    expect(pidFromEnv({ CLAUDE_PID: "12", TACHO_HARNESS_PID: "34" })).toBe(12);
    expect(pidFromEnv({ TACHO_HARNESS_PID: "34" })).toBe(34);
    expect(pidFromEnv({ CLAUDE_PID: "x", TACHO_HARNESS_PID: "y" })).toBe(
      undefined,
    );
    const d = deps();
    await handleHookEvent(
      { session_id: "stella-34", hook_event_name: "SessionStart", cwd: "/" },
      { TACHO_HARNESS_PID: "34" },
      d,
      undefined,
      "stella",
    );
    expect(d.registry.get("stella-34")).toMatchObject({
      pid: 34,
      harness: "stella",
    });
  });
});

describe("tachod agent status", () => {
  const handles: DaemonHandle[] = [];
  afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.stop();
  });

  async function boot(paths: ReturnType<typeof scratchPaths>) {
    const handle = await startDaemon({
      paths,
      // The control plane is unreachable: shipping and polling log and retry.
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
      exec: () => ({ status: 0, stdout: "", stderr: "" }),
      log: () => undefined,
      listen: false,
      transcriptRoots: [],
      timers: { detectorMs: 0, sweepMs: 0, checkpointMs: 0 },
    });
    handles.push(handle);
    return handle;
  }

  it("reports every agent and each session's runtime, harness and last hook event, across a restart", async () => {
    const paths = scratchPaths();
    const signer = bundleSigner();
    writeHostFile(
      paths.hostFile,
      testHostFile(signer, signer.sign(unsignedBundle())),
    );
    const first = await boot(paths);
    await first.api.handleHook({
      payload: {
        session_id: "rev-1",
        hook_event_name: "SessionStart",
        cwd: "/repo",
      },
      env: {},
      agent: "reviewer",
    });
    // A pid no process holds: the sweep sees Stella gone after its Stop.
    const gonePid = "2147000000";
    for (const hook_event_name of ["SessionStart", "Stop"]) {
      await first.api.handleHook({
        payload: { session_id: "stella-1", hook_event_name, cwd: "/repo" },
        env: { TACHO_HARNESS_PID: gonePid },
        harness: "stella",
      });
    }
    const status = first.api.status() as {
      agents: Array<Record<string, unknown>>;
      sessions: Array<Record<string, unknown>>;
      last_ingest_at: unknown;
      spool_depth: unknown;
    };
    expect(status.agents).toEqual([
      expect.objectContaining({
        key: "custom:reviewer",
        runtime: "custom",
        harness: "reviewer",
        label: "reviewer",
        sessions_total: 1,
        sessions_live: 1,
      }),
      expect.objectContaining({
        key: "stella:stella",
        label: "Stella",
        sessions_total: 1,
        sessions_live: 1,
      }),
    ]);
    expect(status.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          session_id: "rev-1",
          runtime: "custom",
          harness: "reviewer",
          last_hook_event: "SessionStart",
        }),
        expect.objectContaining({
          session_id: "stella-1",
          runtime: "stella",
          harness: "stella",
          last_hook_event: "Stop",
          pid: Number(gonePid),
        }),
      ]),
    );
    // The daemon's own chain is listed as a session, never as an agent.
    expect(
      status.sessions.find((s) =>
        String(s["session_id"]).startsWith("tachod-"),
      ),
    ).toMatchObject({ last_hook_event: null });
    expect(status).toHaveProperty("last_ingest_at");
    expect(status).toHaveProperty("spool_depth");
    expect(first.api.sessions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ session_id: "rev-1", harness: "reviewer" }),
      ]),
    );
    const uuid = first.registry.get("rev-1")?.recorder.sessionUuid as string;
    expect(first.wal.read(uuid)[0]?.agent).toMatchObject({
      runtime: "custom",
      harness: "reviewer",
    });

    await first.stop();
    const second = await boot(paths);
    await second.tick();
    const after = second.api.status() as {
      agents: Array<Record<string, unknown>>;
    };
    expect(after.agents.map((a) => [a["key"], a["sessions_total"]])).toEqual([
      ["custom:reviewer", 1],
      ["stella:stella", 1],
    ]);
    // Stella exited after Stop: the sweep sealed its chain as completed.
    expect(after.agents[1]?.["sessions_live"]).toBe(0);
    const stellaUuid = second.registry.get("stella-1")?.recorder
      .sessionUuid as string;
    const stop = second.wal
      .read(stellaUuid)
      .filter((e) => e.kind === "agent_stop")
      .at(-1);
    expect((stop?.body as { session_outcome: string }).session_outcome).toBe(
      "completed",
    );
  });
});

describe("session baselineCommit", () => {
  it("survives state and restore so a restart keeps the reconciliation ref", () => {
    const clock = clockAt("2026-09-15T10:00:00.000Z");
    const registry = new SessionRegistry({
      context: CONTEXT,
      scope: TEST_ENROLLMENT,
      now: clock.now,
    });
    const { record } = registry.ensure("sess-1", {
      cwd: "/repo-a",
      baselineCommit: "abc123",
    });
    expect(record.baselineCommit).toBe("abc123");
    const state = JSON.parse(JSON.stringify(registry.state())) as RegistryState;
    expect(state.sessions[0]?.baselineCommit).toBe("abc123");
    const restored = new SessionRegistry({
      context: CONTEXT,
      scope: TEST_ENROLLMENT,
      now: clock.now,
    });
    restored.restore(state);
    expect(restored.get("sess-1")?.baselineCommit).toBe("abc123");
    expect(restored.get("sess-1")?.cwd).toBe("/repo-a");
  });

  it("clears the baseline when the session moves to another worktree", () => {
    const clock = clockAt("2026-09-15T10:00:00.000Z");
    const registry = new SessionRegistry({
      context: CONTEXT,
      scope: TEST_ENROLLMENT,
      now: clock.now,
    });
    const { record } = registry.ensure("sess-1", {
      cwd: "/repo-a",
      baselineCommit: "aaa111",
    });
    expect(record.baselineCommit).toBe("aaa111");
    registry.ensure("sess-1", { cwd: "/repo-b" });
    expect(record.cwd).toBe("/repo-b");
    expect(record.baselineCommit).toBeUndefined();
    // Same worktree again leaves a newly set baseline alone.
    record.baselineCommit = "bbb222";
    registry.ensure("sess-1", { cwd: "/repo-b" });
    expect(record.baselineCommit).toBe("bbb222");
  });
});
