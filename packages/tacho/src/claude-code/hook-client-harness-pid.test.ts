/**
 * The harness pid a hook hands the daemon (#3989). The daemon seals a
 * session within one sweep of that pid exiting, and without one it waits
 * out the six-hour idle bound. Codex exports no pid, so `tacho-hook` finds
 * the Codex process itself. Cursor gets none on purpose: the process that
 * runs its hooks serves many conversations (see `runTachoHook`).
 */
import { describe, expect, it } from "vitest";
import { writeHostFile } from "../host/host-file";
import {
  bundleSigner,
  scratchPaths,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import { type postUnix, runTachoHook } from "./hook-client";

function enrolledPaths() {
  const paths = scratchPaths();
  const signer = bundleSigner();
  writeHostFile(
    paths.hostFile,
    testHostFile(signer, signer.sign(unsignedBundle())),
  );
  return paths;
}

const CODEX_START = JSON.stringify({
  session_id: "019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b",
  hook_event_name: "SessionStart",
  cwd: "/repo",
  source: "startup",
});

const CODEX_PROMPT = JSON.stringify({
  session_id: "019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b",
  hook_event_name: "UserPromptSubmit",
  cwd: "/repo",
  prompt: "fix the build",
});

const CODEX_PRE = JSON.stringify({
  session_id: "019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b",
  hook_event_name: "PreToolUse",
  cwd: "/repo",
  tool_name: "Bash",
  tool_input: { command: "ls" },
  tool_use_id: "call_1",
});

const CURSOR_PRE = JSON.stringify({
  conversation_id: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
  generation_id: "gen-1",
  hook_event_name: "preToolUse",
  tool_name: "Shell",
  tool_input: { command: "ls" },
  tool_use_id: "tool_1",
  cwd: "/repo",
});

/** Run one hook against a daemon that answers `{}`; return the env it sent. */
async function sentEnv(
  harness: "codex" | "cursor",
  stdin: string,
  harnessPid: () => number | undefined,
): Promise<Record<string, string>> {
  const seen: Array<Parameters<typeof postUnix>[0]> = [];
  const result = await runTachoHook({
    paths: enrolledPaths(),
    env: { HOME: "/h" },
    stdin,
    harness,
    harnessPid,
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

describe("the harness pid on a hook", () => {
  it("names the Codex process at the session's start and at each prompt, so the sweep can seal the session when it exits", async () => {
    expect(await sentEnv("codex", CODEX_START, () => 4242)).toEqual({
      TACHO_HARNESS_PID: "4242",
    });
    expect(await sentEnv("codex", CODEX_PROMPT, () => 4242)).toEqual({
      TACHO_HARNESS_PID: "4242",
    });
  });

  it("does not walk the process tree on a Codex tool call, because the registry already holds the pid", async () => {
    let asked = false;
    const env = await sentEnv("codex", CODEX_PRE, () => {
      asked = true;
      return 4242;
    });
    expect(env).toEqual({});
    expect(asked).toBe(false);
  });

  it("is left off a Codex hook when the walk finds no per-session Codex process", async () => {
    expect(await sentEnv("codex", CODEX_START, () => undefined)).toEqual({});
  });

  it("is never put on a Cursor hook, whatever a walk would find", async () => {
    let asked = false;
    const env = await sentEnv("cursor", CURSOR_PRE, () => {
      asked = true;
      return 4242;
    });
    expect(env).toEqual({});
    expect(asked).toBe(false);
  });
});
