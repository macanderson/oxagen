/**
 * The hook-id replay ledger: a hook whose live request timed out on the
 * client's own side, after the daemon already processed it, used to be
 * recorded a second time when the client's spool fallback replayed the same
 * payload. `hookId` names one hook invocation across both paths, and a
 * session's ledger drops a replay whose id it already recorded. A client
 * that sends no id is keyed on the harness's tool-call id where it has one.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ClaudeCodeContext } from "../claude-code/context";
import {
  bundleSigner,
  TEST_ENROLLMENT,
  unsignedBundle,
} from "../host/test-support";
import type { PolicyBundle } from "../wire";
import {
  handleHookEvent,
  type HookReplay,
  hookLedgerKey,
  type PolicyView,
} from "./hook-handler";
import {
  forgetHookId,
  HOOK_ID_LEDGER_CEILING,
  pruneHookIds,
  rememberHookId,
  SessionRegistry,
  type SessionRecord,
  sawHookId,
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

interface Fixture {
  env: Record<string, string>;
  stdin: Record<string, unknown>;
}

function fixture(name: string): Fixture {
  const path = join(
    __dirname,
    "..",
    "..",
    "fixtures",
    "claude-code",
    "hooks",
    name,
  );
  return JSON.parse(readFileSync(path, "utf8")) as Fixture;
}

function firstFixtureNamed(prefix: string): Fixture {
  const dir = join(__dirname, "..", "..", "fixtures", "claude-code", "hooks");
  const name = readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .sort()
    .find((n) => n.startsWith(prefix));
  if (name === undefined) throw new Error(`no fixture starting with ${prefix}`);
  return fixture(name);
}

function harness() {
  const signer = bundleSigner();
  const bundle = signer.sign(unsignedBundle());
  let clock = Date.parse("2026-09-23T10:00:00.000Z");
  const now = () => (clock += 1000);
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
  const deps = { registry, policy: () => view, now };
  return { registry, deps };
}

describe("the hook-id replay ledger", () => {
  it("drops a replay carrying an id this session already recorded", async () => {
    const { deps } = harness();
    const start = firstFixtureNamed("01");
    const live = await handleHookEvent(
      start.stdin,
      start.env,
      deps,
      undefined,
      undefined,
      undefined,
      "hook_abc",
    );
    expect(live.events.length).toBeGreaterThan(0);

    // The client's live request had already reached the daemon; only its
    // own wait for an answer timed out. Its spool fallback replays the
    // identical payload under the same hook_id.
    const replay = await handleHookEvent(
      start.stdin,
      start.env,
      deps,
      undefined,
      undefined,
      undefined,
      "hook_abc",
    );
    expect(replay.events).toEqual([]);
    expect(replay.response).toEqual({});
  });

  it("seals the replay of a hook whose live route threw", async () => {
    const { deps } = harness();
    const start = firstFixtureNamed("01");
    const failing = {
      ...deps,
      policy: (): PolicyView => {
        throw new Error("bundle read failed");
      },
    };
    await expect(
      handleHookEvent(
        start.stdin,
        start.env,
        failing,
        undefined,
        undefined,
        undefined,
        "hook_threw",
      ),
    ).rejects.toThrow("bundle read failed");

    // The client saw a failure and spooled the hook under the same id. The
    // replay is the only copy, so it has to be sealed.
    const replay = await handleHookEvent(
      start.stdin,
      start.env,
      deps,
      undefined,
      undefined,
      undefined,
      "hook_threw",
    );
    expect(replay.events.length).toBeGreaterThan(0);
  });

  it("seals a replay once the daemon forgets an id whose write failed", async () => {
    const { deps, registry } = harness();
    const start = firstFixtureNamed("01");
    await handleHookEvent(
      start.stdin,
      start.env,
      deps,
      undefined,
      undefined,
      undefined,
      "hook_unwritten",
    );
    const record = registry.get(String(start.stdin["session_id"]));
    if (record === undefined) throw new Error("no session record");
    expect(sawHookId(record, "hook_unwritten")).toBe(true);

    forgetHookId(record, "hook_unwritten");
    expect(sawHookId(record, "hook_unwritten")).toBe(false);
    const replay = await handleHookEvent(
      start.stdin,
      start.env,
      deps,
      undefined,
      undefined,
      undefined,
      "hook_unwritten",
    );
    expect(replay.events.length).toBeGreaterThan(0);
  });

  it("still records a different hook_id normally", async () => {
    const { deps, registry } = harness();
    const start = firstFixtureNamed("01");
    await handleHookEvent(
      start.stdin,
      start.env,
      deps,
      undefined,
      undefined,
      undefined,
      "hook_1",
    );
    const record = registry.get(String(start.stdin["session_id"]));
    const before = record?.recorder.chainCursor.seq;

    const prompt = firstFixtureNamed("03");
    const outcome = await handleHookEvent(
      prompt.stdin,
      prompt.env,
      deps,
      undefined,
      undefined,
      undefined,
      "hook_2",
    );
    expect(outcome.events.length).toBeGreaterThan(0);
    expect(record?.recorder.chainCursor.seq).not.toBe(before);
  });

  it("still records normally when no hook_id is given (an older tacho-hook binary)", async () => {
    const { deps } = harness();
    const start = firstFixtureNamed("01");
    const first = await handleHookEvent(start.stdin, start.env, deps);
    expect(first.events.length).toBeGreaterThan(0);
  });

  it("keeps an id well past 64 later hooks", async () => {
    // The ledger held 64 ids. A session that ran 64 hooks between a live
    // request and its spool replay (one slow PermissionRequest is enough)
    // had already forgotten the id, and the replay sealed a second time.
    const { deps, registry } = harness();
    const start = firstFixtureNamed("01");
    for (let i = 0; i < 200; i += 1) {
      // Each SessionStart on the same session_id is a resume, which the
      // recorder accepts repeatedly; only the ledger's own bookkeeping is
      // under test here.
      await handleHookEvent(
        start.stdin,
        start.env,
        deps,
        undefined,
        undefined,
        undefined,
        `hook_${i}`,
      );
    }
    const record = registry.get(String(start.stdin["session_id"]));
    expect(record?.hookIds.size).toBe(200);
    const replay = await handleHookEvent(
      start.stdin,
      start.env,
      deps,
      undefined,
      undefined,
      undefined,
      "hook_0",
    );
    expect(replay.events).toEqual([]);
  });

  it("drops the spool replay of a tool call sent without a hook_id", async () => {
    // A tacho-hook older than hook_id sends none, live or spooled. The
    // harness's own tool_use_id still names the call.
    const { deps } = harness();
    const start = firstFixtureNamed("01");
    const prompt = firstFixtureNamed("03");
    const pre = firstFixtureNamed("04");
    await handleHookEvent(start.stdin, start.env, deps);
    await handleHookEvent(prompt.stdin, prompt.env, deps);
    const live = await handleHookEvent(pre.stdin, pre.env, deps);
    expect(live.events.length).toBeGreaterThan(0);
    expect(live.hookKey).toBe(`PreToolUse:${String(pre.stdin["tool_use_id"])}`);

    const spooled: HookReplay = { receivedAt: "2026-09-23T10:00:00.500Z" };
    const replay = await handleHookEvent(pre.stdin, pre.env, deps, spooled);
    expect(replay.events).toEqual([]);
  });

  it("answers a live repeat of a tool call in full", async () => {
    // A harness waiting on PreToolUse must get the policy's answer. Only a
    // spool replay is dropped on a key the harness issued.
    const { deps } = harness();
    const start = firstFixtureNamed("01");
    const pre = firstFixtureNamed("04");
    await handleHookEvent(start.stdin, start.env, deps);
    await handleHookEvent(pre.stdin, pre.env, deps);
    const again = await handleHookEvent(pre.stdin, pre.env, deps);
    expect(again.events.length).toBeGreaterThan(0);
  });

  it("seals every Stop sent without a hook_id", async () => {
    // Two Stops can carry identical payloads and both be real, so nothing
    // keys them when the client names neither.
    const { deps } = harness();
    const start = firstFixtureNamed("01");
    const prompt = firstFixtureNamed("03");
    const stop = firstFixtureNamed("16");
    await handleHookEvent(start.stdin, start.env, deps);
    await handleHookEvent(prompt.stdin, prompt.env, deps);
    const first = await handleHookEvent(stop.stdin, stop.env, deps);
    expect(first.hookKey).toBeUndefined();
    await handleHookEvent(prompt.stdin, prompt.env, deps);
    const spooled: HookReplay = { receivedAt: "2026-09-23T10:00:00.500Z" };
    const second = await handleHookEvent(stop.stdin, stop.env, deps, spooled);
    expect(second.events.length).toBeGreaterThan(0);
  });

  it("restores a ledger from a state file written before it carried times", async () => {
    const { deps, registry } = harness();
    const start = firstFixtureNamed("01");
    await handleHookEvent(
      start.stdin,
      start.env,
      deps,
      undefined,
      undefined,
      undefined,
      "hook_legacy",
    );
    const state = registry.state();
    for (const session of state.sessions) {
      if (session.hookIds === undefined) continue;
      session.recentHookIds = session.hookIds.map(([key]) => key);
      delete session.hookIds;
    }
    const restored = new SessionRegistry({
      context: CONTEXT,
      scope: TEST_ENROLLMENT,
      now: deps.now,
    });
    restored.restore(JSON.parse(JSON.stringify(state)));
    const record = restored.get(String(start.stdin["session_id"]));
    if (record === undefined) throw new Error("no restored record");
    expect(record.hookIds.get("hook_legacy")).toBe(
      Date.parse(record.lastSeenAt),
    );
  });
});

describe("hookLedgerKey", () => {
  const pre = { hook_event_name: "PreToolUse", tool_use_id: "toolu_1" };

  it("prefers the client's hook_id", () => {
    expect(hookLedgerKey(pre, undefined, "hook_1")).toBe("hook_1");
  });

  it("keys a tool-call event on the harness's tool_use_id", () => {
    expect(hookLedgerKey(pre, "cursor", undefined)).toBe("PreToolUse:toolu_1");
    expect(
      hookLedgerKey(
        { hook_event_name: "PostToolUseFailure", tool_use_id: "toolu_1" },
        undefined,
        undefined,
      ),
    ).toBe("PostToolUseFailure:toolu_1");
  });

  it("leaves Stella out, because the daemon derives its tool-use ids", () => {
    expect(hookLedgerKey(pre, "stella", undefined)).toBeUndefined();
  });

  it("gives no key to an event without an id of its own", () => {
    expect(
      hookLedgerKey({ hook_event_name: "Stop" }, undefined, undefined),
    ).toBeUndefined();
    expect(
      hookLedgerKey(
        { hook_event_name: "PreToolUse", tool_use_id: "" },
        undefined,
        undefined,
      ),
    ).toBeUndefined();
    expect(
      hookLedgerKey("not an object", undefined, undefined),
    ).toBeUndefined();
  });
});

describe("ledger bounds", () => {
  const ledger = (): Pick<SessionRecord, "hookIds"> => ({
    hookIds: new Map(),
  });

  it("evicts the oldest key past the ceiling", () => {
    const record = ledger();
    for (let i = 0; i < HOOK_ID_LEDGER_CEILING + 5; i += 1) {
      rememberHookId(record, `key_${i}`, i);
    }
    expect(record.hookIds.size).toBe(HOOK_ID_LEDGER_CEILING);
    expect(sawHookId(record, "key_4")).toBe(false);
    expect(sawHookId(record, "key_5")).toBe(true);
    expect(sawHookId(record, `key_${HOOK_ID_LEDGER_CEILING + 4}`)).toBe(true);
  });

  it("keeps a key's first time when it is remembered again", () => {
    const record = ledger();
    rememberHookId(record, "key", 1_000);
    rememberHookId(record, "key", 9_000);
    expect(record.hookIds.get("key")).toBe(1_000);
  });

  it("prunes only the keys recorded before the bound", () => {
    const record = ledger();
    rememberHookId(record, "old", 1_000);
    rememberHookId(record, "older", 500);
    rememberHookId(record, "new", 3_000);
    expect(pruneHookIds(record, 2_000)).toBe(2);
    expect([...record.hookIds.keys()]).toEqual(["new"]);
  });
});
