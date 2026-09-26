/**
 * The registry's session lifecycle: a resumed session reopens its sealed
 * chain (and a forgotten one continues from its tombstone), a clean exit
 * after a later hook still closes as completed, a pid that answers is not
 * enough to keep a quiet chain open, a baseline survives a `cd` inside its
 * repository, and a queued message whose session sealed is acknowledged as
 * expired rather than left `received`.
 */
import { describe, expect, it } from "vitest";
import { verifyChain } from "../chain";
import type { ClaudeCodeContext } from "../claude-code/context";
import type { TachoEvent } from "../envelope";
import type { ExecAsync } from "../host/service";
import {
  bundleSigner,
  TEST_ENROLLMENT,
  unsignedBundle,
} from "../host/test-support";
import { readGitRoot } from "./git-facts";
import { handleHookEvent, type PolicyView } from "./hook-handler";
import {
  EXPIRED_ON_SEAL_DETAIL,
  MAX_SESSION_BASELINES,
  type RegistryState,
  rememberBaseline,
  rememberForRoot,
  SEALED_STATE_RETAIN_MS,
  SessionRegistry,
  STALE_PID_SESSION_MS,
  TOMBSTONE_RETAIN_MS,
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

const DAY_MS = 24 * 60 * 60_000;

function harness() {
  let clock = Date.parse("2026-09-15T10:00:00.000Z");
  const now = () => clock;
  const advance = (ms: number) => {
    clock += ms;
  };
  const registry = new SessionRegistry({
    context: CONTEXT,
    scope: TEST_ENROLLMENT,
    now,
  });
  const bundle = bundleSigner().sign(unsignedBundle());
  const view: PolicyView = {
    bundle,
    verified: true,
    hostStatus: "active",
    denyGeneration: bundle.deny_generation,
    controlReachable: true,
  };
  const chain: TachoEvent[] = [];
  const hook = async (
    target: SessionRegistry,
    hookEventName: string,
    extra: Record<string, unknown> = {},
  ): Promise<TachoEvent[]> => {
    advance(1_000);
    const outcome = await handleHookEvent(
      {
        session_id: "sess-1",
        hook_event_name: hookEventName,
        cwd: "/repo",
        ...extra,
      },
      { CLAUDE_PID: "4242" },
      { registry: target, policy: () => view, now },
    );
    chain.push(...outcome.events);
    return outcome.events;
  };
  return { registry, now, advance, hook, chain };
}

const kinds = (events: readonly TachoEvent[]) => events.map((e) => e.kind);

describe("a resumed session", () => {
  it("reopens its sealed chain and continues it at the cursor", async () => {
    const { registry, hook, chain } = harness();
    await hook(registry, "SessionStart", { source: "startup" });
    await hook(registry, "UserPromptSubmit", { prompt: "one" });
    await hook(registry, "Stop");
    await hook(registry, "SessionEnd", { reason: "prompt_input_exit" });
    const record = registry.get("sess-1");
    expect(record?.sealed).toBe(true);
    expect(registry.live()).toEqual([]);

    // `claude --resume` keeps the session id.
    const resumed = await hook(registry, "SessionStart", { source: "resume" });
    expect(record?.sealed).toBe(false);
    expect(registry.live()).toEqual([record]);
    expect(resumed[0]?.kind).toBe("agent_start");
    expect(resumed[0]?.body).toMatchObject({
      resume_of_session_id: "sess-1",
    });

    // The recorder reopened too: a crash after the resume still closes the
    // chain with a terminal frame.
    await hook(registry, "UserPromptSubmit", { prompt: "two" });
    const closed = registry.sweep(() => false, 60_000);
    expect(kinds(closed)).toEqual(["agent_stop"]);
    expect(closed[0]?.body).toMatchObject({ session_outcome: "crashed" });
    chain.push(...closed);
    expect(verifyChain(chain).ok).toBe(true);
    expect(kinds(chain).filter((k) => k === "agent_stop")).toHaveLength(2);
  });

  it("stays closed to a caller that is not a hook, and while its terminal is pending", () => {
    const { registry } = harness();
    const { record } = registry.ensure("sess-1", { ambient: false });
    record.recorder.sealCollectorEvent("agent_start", {});
    registry.seal(record);
    registry.ensure("sess-1", { ambient: true });
    expect(record.sealed).toBe(true);

    record.pendingTerminal = true;
    registry.ensure("sess-1", { lastHookEvent: "SessionStart" });
    expect(record.sealed).toBe(true);
  });

  it("continues a forgotten chain from its tombstone, across a restart", async () => {
    const { registry, advance, hook, chain } = harness();
    await hook(registry, "SessionStart", { source: "startup" });
    await hook(registry, "UserPromptSubmit", { prompt: "one" });
    await hook(registry, "Stop");
    await hook(registry, "SessionEnd", { reason: "other" });
    const old = registry.get("sess-1");
    const cursor = { ...old?.recorder.chainCursor };
    advance(8 * DAY_MS);
    expect(registry.forgetSealed(7 * DAY_MS)).toEqual(["sess-1"]);
    expect(registry.get("sess-1")).toBeUndefined();

    const state = JSON.parse(JSON.stringify(registry.state())) as RegistryState;
    expect(state.tombstones).toHaveLength(1);
    const restored = new SessionRegistry({
      context: CONTEXT,
      scope: TEST_ENROLLMENT,
      now: () => Date.parse("2026-09-24T10:00:00.000Z"),
    });
    restored.restore(state);

    const resumed = await hook(restored, "SessionStart", { source: "resume" });
    expect(resumed[0]?.session_uuid).toBe(old?.recorder.sessionUuid);
    expect(resumed[0]?.seq).toBe(cursor.seq);
    expect(resumed[0]?.prev_hash).toBe(cursor.prevHash);
    expect(resumed[0]?.body).toMatchObject({ resume_of_session_id: "sess-1" });
    const prompt = await hook(restored, "UserPromptSubmit", { prompt: "two" });
    // The turn count continues too, so the resumed turn is not a second turn 1.
    expect(prompt[0]?.turn?.turn_seq).toBe(2);
    expect(verifyChain(chain).ok).toBe(true);
    // The tombstone is spent once the session is held again.
    expect(restored.state().tombstones).toBeUndefined();
  });

  it("drops a tombstone past its retention, and one that does not parse", () => {
    const { registry, advance } = harness();
    const { record } = registry.ensure("sess-1", { ambient: false });
    record.recorder.sealCollectorEvent("agent_start", {});
    registry.seal(record);
    advance(8 * DAY_MS);
    registry.forgetSealed(7 * DAY_MS);
    const state = registry.state();
    expect(state.tombstones).toHaveLength(1);

    const restored = new SessionRegistry({
      context: CONTEXT,
      scope: TEST_ENROLLMENT,
      now: () => Date.now(),
    });
    const bad = JSON.parse(JSON.stringify(state)) as RegistryState;
    const tombstone = bad.tombstones?.[0];
    if (tombstone === undefined) throw new Error("no tombstone");
    tombstone.cursor.prevHash = "sha256:nope";
    restored.restore(bad);
    expect(restored.state().tombstones).toBeUndefined();
    // A chain that could not continue opens its own from genesis.
    expect(
      restored.ensure("sess-1", { ambient: false }).record.recorder.chainCursor
        .seq,
    ).toBe(0);

    advance(TOMBSTONE_RETAIN_MS + 1);
    registry.forgetSealed(7 * DAY_MS);
    expect(registry.state().tombstones).toBeUndefined();
  });
});

describe("the sweep outcome", () => {
  it("closes as completed when the process exits with no turn open, whatever hook came last", async () => {
    const { registry, hook } = harness();
    await hook(registry, "SessionStart", { source: "startup" });
    await hook(registry, "UserPromptSubmit", { prompt: "one" });
    await hook(registry, "Stop");
    await hook(registry, "Notification", {
      notification_type: "idle_prompt",
      message: "waiting",
    });
    expect(registry.get("sess-1")?.lastHookEvent).toBe("Notification");
    const closed = registry.sweep(() => false, 60_000);
    expect(closed[0]?.body).toMatchObject({
      session_outcome: "completed",
      unobserved_tail: false,
    });
  });

  it("closes as crashed when the process exits mid-turn", async () => {
    const { registry, hook } = harness();
    await hook(registry, "SessionStart", { source: "startup" });
    await hook(registry, "UserPromptSubmit", { prompt: "one" });
    await hook(registry, "Notification", {
      notification_type: "permission_prompt",
      message: "allow?",
    });
    const closed = registry.sweep(() => false, 60_000);
    expect(closed[0]?.body).toMatchObject({ session_outcome: "crashed" });
  });
});

describe("a quiet session with a pid", () => {
  it("is closed after the stale window even though its pid answers, and a later hook reopens it", async () => {
    const { registry, advance, hook } = harness();
    await hook(registry, "SessionStart", { source: "startup" });
    const host = registry.ensure("tachod-boot", { pid: process.pid }).record;
    host.recorder.sealCollectorEvent("agent_start", {});
    const record = registry.get("sess-1");

    advance(STALE_PID_SESSION_MS - 60_000);
    expect(registry.sweep(() => true, 60_000)).toEqual([]);
    advance(2 * 60_000);
    const closed = registry.sweep(() => true, 60_000);
    expect(kinds(closed)).toEqual(["agent_stop"]);
    expect(closed[0]?.body).toMatchObject({ session_outcome: "crashed" });
    expect(record?.sealed).toBe(true);
    expect(record?.closedIdle).toBe(true);
    // The daemon's own chain has this process's pid, and stays open.
    expect(host.sealed).toBe(false);

    // The guess was wrong: the session was only idle.
    await hook(registry, "UserPromptSubmit", { prompt: "back" });
    expect(record?.sealed).toBe(false);
    expect(record?.closedIdle).toBeUndefined();
  });

  it("records the reopen as the chain's restart, so the control plane reopens the run (ADR-172)", async () => {
    const { registry, advance, hook, chain } = harness();
    await hook(registry, "SessionStart", { source: "startup" });
    advance(STALE_PID_SESSION_MS + 60_000);
    const closed = registry.sweep(() => true, 60_000);
    chain.push(...closed);
    const stop = closed[0];

    const back = await hook(registry, "UserPromptSubmit", { prompt: "back" });
    expect(kinds(back)).toEqual(["agent_start", "turn_start"]);
    expect(back[0]).toMatchObject({
      source: "collector",
      seq: (stop?.seq ?? 0) + 1,
      body: {
        session_start_source: "reopen",
        resume_of_session_id: "sess-1",
        resume_last_seq_seen: stop?.seq,
      },
    });
    expect(verifyChain(chain).ok).toBe(true);

    // Open again, the chain seals no second restart for the next hook.
    const next = await hook(registry, "Stop");
    expect(kinds(next)).not.toContain("agent_start");
  });

  it("leaves the restart of a resumed session to its own SessionStart", async () => {
    const { registry, hook } = harness();
    await hook(registry, "SessionStart", { source: "startup" });
    await hook(registry, "SessionEnd", { reason: "prompt_input_exit" });

    const resumed = await hook(registry, "SessionStart", { source: "resume" });
    expect(kinds(resumed).filter((k) => k === "agent_start")).toHaveLength(1);
    expect(resumed[0]).toMatchObject({
      source: "hook",
      body: { session_start_source: "resume" },
    });
  });

  it("is not reopened by a stray hook once SessionEnd closed it", () => {
    const { registry } = harness();
    const { record } = registry.ensure("sess-1", { ambient: false });
    record.recorder.sealCollectorEvent("agent_start", {});
    registry.seal(record);
    registry.ensure("sess-1", { lastHookEvent: "PostToolUse" });
    expect(record.sealed).toBe(true);
  });
});

describe("a hook replayed after a daemon restart", () => {
  it("dates the session's activity at the replay's receipt, so the sweep ends it there", async () => {
    const { registry, now, advance, hook } = harness();
    await hook(registry, "SessionStart", { source: "startup" });
    await hook(registry, "UserPromptSubmit", { prompt: "one" });
    const record = registry.get("sess-1");
    const lastActivity = record?.lastSeenAt;

    // The daemon is down for half an hour. `tacho-hook` spools a
    // notification at the start of the outage, and the restarted daemon
    // replays it.
    const receivedAt = new Date(now() + 1_000).toISOString();
    advance(30 * 60_000);
    const bundle = bundleSigner().sign(unsignedBundle());
    await handleHookEvent(
      {
        session_id: "sess-1",
        hook_event_name: "Notification",
        notification_type: "idle_prompt",
        message: "waiting",
        cwd: "/repo",
      },
      { CLAUDE_PID: "4242" },
      {
        registry,
        policy: () => ({
          bundle,
          verified: true,
          hostStatus: "active",
          denyGeneration: bundle.deny_generation,
          controlReachable: true,
        }),
        now,
      },
      { receivedAt },
    );
    expect(record?.lastSeenAt).toBe(receivedAt);
    expect(Date.parse(receivedAt)).toBeGreaterThan(Date.parse(lastActivity!));

    // The harness process is gone. The sweep ends the session at its last
    // activity, not at the restart.
    const closed = registry.sweep(() => false, 60_000);
    expect(closed[0]?.ts).toBe(receivedAt);
  });
});

describe("session baselines", () => {
  it("keeps the baseline across a cd inside one repository and holds one per repository", () => {
    const { registry } = harness();
    const { record } = registry.ensure("sess-1", { cwd: "/repo" });
    expect(rememberBaseline(record, "/repo", "aaa")).toBe("aaa");

    // The session committed, then moved into a package of the same repository.
    registry.ensure("sess-1", { cwd: "/repo/packages/foo" });
    expect(record.baselineCommit).toBeUndefined();
    expect(rememberBaseline(record, "/repo", "bbb")).toBe("aaa");
    expect(record.baselineCommit).toBe("aaa");

    // Another repository has its own, and a move back finds the first again.
    registry.ensure("sess-1", { cwd: "/other" });
    expect(rememberBaseline(record, "/other", "ccc")).toBe("ccc");
    registry.ensure("sess-1", { cwd: "/repo" });
    expect(rememberBaseline(record, "/repo", "ddd")).toBe("aaa");
    expect(record.baselines).toEqual({ "/other": "ccc", "/repo": "aaa" });

    const state = JSON.parse(JSON.stringify(registry.state())) as RegistryState;
    const restored = new SessionRegistry({
      context: CONTEXT,
      scope: TEST_ENROLLMENT,
      now: () => Date.now(),
    });
    restored.restore(state);
    expect(restored.get("sess-1")?.baselines).toEqual(record.baselines);
  });

  it("persists what attributes a worktree's changes to the session", () => {
    const { registry } = harness();
    const { record } = registry.ensure("sess-1", { cwd: "/repo" });
    record.gitFirstReadAt = 1_790_000_000_000;
    record.preexistingPaths = rememberForRoot(undefined, "/repo", {
      paths: { "notes.txt": ["ab".repeat(16), 8, 1_789_999_000_000] },
      complete: true,
    });
    record.sessionCommits = rememberForRoot(undefined, "/repo", [
      "c".repeat(40),
    ]);
    const state = JSON.parse(JSON.stringify(registry.state())) as RegistryState;
    const restored = new SessionRegistry({
      context: CONTEXT,
      scope: TEST_ENROLLMENT,
      now: () => Date.now(),
    });
    restored.restore(state);
    const back = restored.get("sess-1");
    expect(back?.gitFirstReadAt).toBe(record.gitFirstReadAt);
    expect(back?.preexistingPaths).toEqual(record.preexistingPaths);
    expect(back?.sessionCommits).toEqual(record.sessionCommits);
  });

  it("drops a malformed attribution record from an older or edited state file", () => {
    const { registry } = harness();
    registry.ensure("sess-1", { cwd: "/repo" });
    const state = JSON.parse(JSON.stringify(registry.state())) as RegistryState;
    Object.assign(state.sessions[0] as object, {
      gitFirstReadAt: "yesterday",
      preexistingPaths: ["not", "a", "map"],
      sessionCommits: null,
    });
    const restored = new SessionRegistry({
      context: CONTEXT,
      scope: TEST_ENROLLMENT,
      now: () => Date.now(),
    });
    restored.restore(state);
    const back = restored.get("sess-1");
    expect(back?.gitFirstReadAt).toBeUndefined();
    expect(back?.preexistingPaths).toBeUndefined();
    expect(back?.sessionCommits).toBeUndefined();
  });

  it("bounds the per-root records like the baselines", () => {
    let map: Record<string, number> | undefined;
    for (let i = 0; i < MAX_SESSION_BASELINES + 3; i += 1)
      map = rememberForRoot(map, `/r${i}`, i);
    // Read again, so it is the most recent and survives the bound.
    map = rememberForRoot(map, "/r3", 3);
    const roots = Object.keys(map ?? {});
    expect(roots).toHaveLength(MAX_SESSION_BASELINES);
    expect(roots.at(-1)).toBe("/r3");
    expect(roots).not.toContain("/r0");
  });

  it("adopts a baseline set before the map existed, and bounds the map", () => {
    const record: {
      baselineCommit?: string;
      baselines?: Record<string, string>;
    } = { baselineCommit: "legacy" };
    expect(rememberBaseline(record, "/repo", "head")).toBe("legacy");
    for (let i = 0; i < MAX_SESSION_BASELINES + 4; i += 1)
      rememberBaseline(record, `/r${i}`, `sha${i}`);
    const roots = Object.keys(record.baselines ?? {});
    expect(roots).toHaveLength(MAX_SESSION_BASELINES);
    // The least recently read went first.
    expect(roots).not.toContain("/repo");
    expect(roots.at(-1)).toBe(`/r${MAX_SESSION_BASELINES + 3}`);
  });

  it("follows the root a read resolves, and holds none where there is no commit", () => {
    const record: Parameters<typeof rememberBaseline>[0] = {};
    expect(rememberBaseline(record, "/repo", "aaa")).toBe("aaa");
    expect(record.baselineRoot).toBe("/repo");
    // A worktree with no commit yet has no baseline to measure from, and the
    // first repository's must not stand in for one.
    expect(rememberBaseline(record, "/worktrees/new", undefined)).toBe(
      undefined,
    );
    expect(record.baselineCommit).toBeUndefined();
    expect(record.baselineRoot).toBeUndefined();
    expect(rememberBaseline(record, "/repo", "bbb")).toBe("aaa");
    expect(record.baselineRoot).toBe("/repo");

    // A baseline bound to its root before the map existed stays with that
    // root when the work moves to another.
    const older: Parameters<typeof rememberBaseline>[0] = {
      baselineCommit: "old",
      baselineRoot: "/a",
    };
    expect(rememberBaseline(older, "/b", "head")).toBe("head");
    expect(rememberBaseline(older, "/a", "later")).toBe("old");
  });

  it("resolves the repository root a subdirectory is in", async () => {
    const exec: ExecAsync = async (_command, args) => {
      const joined = args.join(" ");
      if (joined.endsWith("rev-parse --show-toplevel"))
        return { status: 0, stdout: "/repo\n", stderr: "" };
      return { status: 1, stdout: "", stderr: "" };
    };
    expect(await readGitRoot(exec, "/repo/packages/foo")).toBe("/repo");
  });
});

describe("messages queued on a session that seals", () => {
  const queued = (id: string) => ({
    id,
    text: "wrap up",
    command: "message" as const,
    requestedMode: null,
    deliveryMode: null,
    degradedReason: null,
    expiresAt: null,
  });

  it("are acknowledged as expired on SessionEnd and on the sweep", async () => {
    const { registry, hook } = harness();
    await hook(registry, "SessionStart", { source: "startup" });
    const record = registry.get("sess-1");
    if (record === undefined) throw new Error("no record");
    record.control.messages.push(queued("cmd_1"));
    await hook(registry, "SessionEnd", { reason: "other" });
    expect(record.control.messages).toEqual([]);
    expect(registry.takeExpiredOnSeal()).toEqual([
      {
        command_id: "cmd_1",
        status: "expired",
        session_uuid: record.recorder.sessionUuid,
        detail: EXPIRED_ON_SEAL_DETAIL,
      },
    ]);
    expect(registry.takeExpiredOnSeal()).toEqual([]);

    const other = registry.ensure("sess-2", { pid: 7 }).record;
    other.recorder.sealCollectorEvent("agent_start", {});
    other.control.messages.push(queued("cmd_2"));
    registry.sweep(() => false, 60_000);
    expect(registry.takeExpiredOnSeal().map((ack) => ack.command_id)).toEqual([
      "cmd_2",
    ]);
  });

  it("drop a resume's continuation, so a reopened chain is not told it was just resumed", async () => {
    const { registry, hook } = harness();
    await hook(registry, "SessionStart", { source: "startup" });
    const record = registry.get("sess-1");
    if (record === undefined) throw new Error("no record");
    record.control.resumeOwed = "cmd_resume";
    await hook(registry, "SessionEnd", { reason: "other" });
    expect(record.control.resumeOwed).toBeUndefined();
    // The resume was acknowledged when it applied: nothing more is owed.
    expect(registry.takeExpiredOnSeal()).toEqual([]);
    await hook(registry, "SessionStart", { source: "resume" });
    expect(record.sealed).toBe(false);
    expect(record.control.resumeOwed).toBeUndefined();
  });
});

describe("a long-running registry", () => {
  /** What one released sealed session may cost in `daemon.json`. */
  const RELEASED_SESSION_BYTES = 2_048;

  it("keeps a sealed session's call ledgers for an hour, then holds a bounded state for it", async () => {
    const { registry, hook, now } = harness();
    await hook(registry, "SessionStart", { source: "startup" });
    await hook(registry, "UserPromptSubmit", { prompt: "one" });
    await hook(registry, "Stop");
    await hook(registry, "SessionEnd", { reason: "prompt_input_exit" });
    const template = registry.state().sessions[0]!;
    // Ledgers well short of their capacity, so the test stays light. A
    // released session holds none, whatever size they reached.
    const llmCalls = {
      keys: Array.from({ length: 512 }, (_, i): [string, string[], boolean] => [
        `request:req_${String(i).padStart(24, "0")}`,
        ["proxy", "otel"],
        true,
      ]),
    };
    const toolCalls = {
      calls: Array.from(
        { length: 128 },
        (_, i): [string, string[], boolean] => [
          `toolu_${String(i).padStart(24, "0")}`,
          ["hook", "otel"],
          true,
        ],
      ),
    };
    const ledgerBytes = JSON.stringify({ llmCalls, toolCalls }).length;
    const subagent = {
      state: { ...template.recorder, children: {} },
      type: "general-purpose",
      open: false,
    };
    const session = (i: number, sealedAgoMs: number, sealed = true) => ({
      ...template,
      harnessSessionId: `sess-${i}`,
      recorder: {
        ...template.recorder,
        sessionUuid: `11111111-0000-4000-8000-${String(i).padStart(12, "0")}`,
        llmCalls,
        toolCalls,
        children: { [`agent-a${i}`]: subagent, [`agent-b${i}`]: subagent },
      },
      toolUseIds: { [`derived-${i}`]: `stella_${i}` },
      sealed,
      lastSeenAt: new Date(now() - sealedAgoMs).toISOString(),
    });
    // A week of sessions: 280 sealed more than an hour ago, 20 sealed in
    // the last ten minutes, and one still running.
    const sessions = [
      ...Array.from({ length: 280 }, (_, i) =>
        session(i, (i + 3) * 30 * 60_000),
      ),
      ...Array.from({ length: 20 }, (_, i) => session(280 + i, 10 * 60_000)),
      session(300, 60_000, false),
    ];
    const long = new SessionRegistry({
      context: CONTEXT,
      scope: TEST_ENROLLMENT,
      now,
    });
    long.restore({ schema: "tacho.daemon-state.v1", sessions });
    const before = JSON.stringify(long.state()).length;
    expect(before).toBeGreaterThan(300 * ledgerBytes);

    expect(long.releaseSealedState()).toBe(280);
    // Released once: the next pass changes nothing and dirties nothing.
    expect(long.releaseSealedState()).toBe(0);
    // The 21 recent or running sessions keep everything. Each of the 280
    // released ones holds its chain position, context, and totals, and
    // nothing that grows with the calls it made or the subagents it ran.
    const state = long.state();
    const recentBytes = JSON.stringify(
      state.sessions.filter((s) => Number(s.harnessSessionId.slice(5)) >= 280),
    ).length;
    const releasedBytes = JSON.stringify(
      state.sessions.filter((s) => Number(s.harnessSessionId.slice(5)) < 280),
    ).length;
    expect(recentBytes).toBeGreaterThan(21 * ledgerBytes);
    expect(releasedBytes).toBeLessThan(280 * RELEASED_SESSION_BYTES);
    expect(JSON.stringify(state).length).toBeLessThan(
      recentBytes + releasedBytes + 1_024,
    );
    const kept = (id: string) =>
      state.sessions.find((s) => s.harnessSessionId === id);
    expect(kept("sess-300")?.recorder.llmCalls?.keys).toHaveLength(512);
    expect(kept("sess-290")?.recorder.toolCalls?.calls).toHaveLength(128);
    expect(kept("sess-0")?.recorder.llmCalls?.keys).toEqual([]);
    expect(kept("sess-0")?.recorder.toolCalls?.calls).toEqual([]);
    expect(kept("sess-0")?.recorder.children).toEqual({});
    expect(kept("sess-0")?.toolUseIds).toBeUndefined();
  });

  it("releases a resumed session again once it seals and goes quiet", async () => {
    const { registry, hook, advance } = harness();
    await hook(registry, "SessionStart", { source: "startup" });
    await hook(registry, "SessionEnd", { reason: "prompt_input_exit" });
    advance(SEALED_STATE_RETAIN_MS + 1_000);
    expect(registry.releaseSealedState()).toBe(1);
    await hook(registry, "SessionStart", { source: "resume" });
    await hook(registry, "SessionEnd", { reason: "prompt_input_exit" });
    expect(registry.releaseSealedState()).toBe(0);
    advance(SEALED_STATE_RETAIN_MS + 1_000);
    expect(registry.releaseSealedState()).toBe(1);
  });
});
