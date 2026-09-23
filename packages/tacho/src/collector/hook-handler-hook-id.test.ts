/**
 * The hook-id replay ledger: a hook whose live request timed out on the
 * client's own side, after the daemon already processed it, used to be
 * recorded a second time when the client's spool fallback replayed the same
 * payload. `hookId` names one hook invocation across both paths, and a
 * session's ledger drops a replay whose id it already recorded.
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
import { handleHookEvent, type PolicyView } from "./hook-handler";
import { HOOK_ID_LEDGER_CAPACITY, SessionRegistry } from "./registry";

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

  it("bounds the ledger so it cannot grow without limit", async () => {
    const { deps, registry } = harness();
    const start = firstFixtureNamed("01");
    for (let i = 0; i < HOOK_ID_LEDGER_CAPACITY + 10; i += 1) {
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
    expect(record?.recentHookIds.length).toBeLessThanOrEqual(
      HOOK_ID_LEDGER_CAPACITY,
    );
    // The oldest ids are the ones dropped; the most recent one is still held.
    expect(record?.recentHookIds).toContain(
      `hook_${HOOK_ID_LEDGER_CAPACITY + 9}`,
    );
  });
});
