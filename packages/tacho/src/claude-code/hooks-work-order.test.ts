/**
 * A run names its work order on its frames (P1-04, ADR-250). `oxagen work
 * start` sets `OXAGEN_WORK_ORDER_ID` on the harness it starts. The hook
 * process inherits it, the hook client passes it to the daemon, and the
 * session's `agent_start` carries it as `oxagen.work_order.id`. Every wrapped
 * harness takes the same path: the client translates Cursor's and Stella's
 * payloads before it posts, so the daemon reads one shape.
 */
import { describe, expect, it } from "vitest";
import { writeHostFile } from "../host/host-file";
import {
  bundleSigner,
  scratchPaths,
  TEST_ENROLLMENT,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import { handleHookEvent, type PolicyView } from "../collector/hook-handler";
import { SessionRegistry } from "../collector/registry";
import type { ClaudeCodeContext } from "./context";
import { type postUnix, runTachoHook } from "./hook-client";
import { normalizeHook } from "./hooks";

const WO = "wo_01j9k2m3n4";
const SESSION = "340ed354-6344-4727-9f8b-1e40b5e12aa7";

function start(env: Record<string, string | undefined>) {
  return normalizeHook(
    {
      session_id: SESSION,
      hook_event_name: "SessionStart",
      source: "startup",
      cwd: "/work/platform",
    },
    env,
    { sessionUuid: "11111111-1111-4111-8111-111111111111" },
  );
}

describe("the work order on a session's start", () => {
  it("names the order on agent_start when the environment carries one", () => {
    const [draft] = start({ OXAGEN_WORK_ORDER_ID: WO });
    expect(draft?.kind).toBe("agent_start");
    expect(draft?.attrs["oxagen.work_order.id"]).toBe(WO);
  });

  it("names none when the environment carries none", () => {
    const [draft] = start({});
    expect(draft?.kind).toBe("agent_start");
    expect(draft?.attrs).not.toHaveProperty("oxagen.work_order.id");
  });

  it.each(["", "wi_7f3a", "wo_", "WO_ABC", "wo_abc; rm -rf /"])(
    "names none for %j, which is not a work order id (negative)",
    (value) => {
      const [draft] = start({ OXAGEN_WORK_ORDER_ID: value });
      expect(draft?.attrs).not.toHaveProperty("oxagen.work_order.id");
    },
  );

  it("names it only on the start, not on a prompt (negative)", () => {
    const drafts = normalizeHook(
      {
        session_id: SESSION,
        hook_event_name: "UserPromptSubmit",
        cwd: "/work/platform",
        prompt: "go",
      },
      { OXAGEN_WORK_ORDER_ID: WO },
      { sessionUuid: "11111111-1111-4111-8111-111111111111" },
    );
    for (const draft of drafts)
      expect(draft.attrs).not.toHaveProperty("oxagen.work_order.id");
  });
});

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

describe("the daemon's seal", () => {
  it("carries the order on the sealed agent_start", async () => {
    const bundle = bundleSigner().sign(unsignedBundle());
    let clock = Date.parse("2026-10-02T10:00:00.000Z");
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
    const outcome = await handleHookEvent(
      {
        session_id: SESSION,
        hook_event_name: "SessionStart",
        source: "startup",
        cwd: "/work/platform",
      },
      { OXAGEN_WORK_ORDER_ID: WO },
      {
        registry,
        policy: () => view,
        acknowledge: () => undefined,
        now,
      },
    );
    const started = outcome.events.find(
      (event) => event.kind === "agent_start",
    );
    expect(started?.attrs?.["oxagen.work_order.id"]).toBe(WO);
  });
});

function enrolledPaths() {
  const paths = scratchPaths();
  const signer = bundleSigner();
  writeHostFile(
    paths.hostFile,
    testHostFile(signer, signer.sign(unsignedBundle())),
  );
  return paths;
}

/** Run one hook against a daemon that answers `{}`; return the env it sent. */
async function sentEnv(
  harness: "claude-code" | "codex" | "cursor",
  stdin: string,
  env: Record<string, string>,
): Promise<Record<string, string>> {
  const seen: Array<Parameters<typeof postUnix>[0]> = [];
  const result = await runTachoHook({
    paths: enrolledPaths(),
    env: { HOME: "/h", ...env },
    stdin,
    harness,
    harnessPid: () => undefined,
    platform: "linux",
    post: async (options) => {
      seen.push(options);
      return { status: 200, body: "{}" };
    },
  });
  expect(result.path).toBe("daemon");
  return (JSON.parse(seen[0]?.body ?? "{}") as { env: Record<string, string> })
    .env;
}

const CLAUDE_START = JSON.stringify({
  session_id: SESSION,
  hook_event_name: "SessionStart",
  cwd: "/work/platform",
  source: "startup",
});

const CURSOR_START = JSON.stringify({
  conversation_id: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
  generation_id: "gen-1",
  hook_event_name: "sessionStart",
  cwd: "/work/platform",
});

describe("the hook client", () => {
  it.each([
    ["claude-code", CLAUDE_START],
    ["codex", CLAUDE_START],
    ["cursor", CURSOR_START],
  ] as const)("passes the order on from %s's environment", async (harness, stdin) => {
    const env = await sentEnv(harness, stdin, { OXAGEN_WORK_ORDER_ID: WO });
    expect(env["OXAGEN_WORK_ORDER_ID"]).toBe(WO);
  });

  it("passes nothing on when the value is not a work order id (negative)", async () => {
    const env = await sentEnv("claude-code", CLAUDE_START, {
      OXAGEN_WORK_ORDER_ID: "not-an-order",
    });
    expect(env).not.toHaveProperty("OXAGEN_WORK_ORDER_ID");
  });

  it("passes nothing on when the harness was not started for a work order", async () => {
    const env = await sentEnv("claude-code", CLAUDE_START, {});
    expect(env).not.toHaveProperty("OXAGEN_WORK_ORDER_ID");
  });
});
