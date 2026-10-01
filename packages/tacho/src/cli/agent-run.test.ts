/**
 * `oxagen agent run -- <command>` (#4879): one agent session under Oxagen
 * control. The hook, the spawn, and the contained launcher are stand-ins, so
 * nothing here starts a process or reaches a daemon.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writeHostFile } from "../host/host-file";
import { agentPaths } from "../host/paths";
import {
  bundleSigner,
  scratchPaths,
  TEST_ENROLLMENT,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import {
  type AgentExit,
  type AgentRunDeps,
  agentNameFromCommand,
  exitCodeOf,
  runAgentSession,
  sessionRefusal,
  spawnAgent,
} from "./agent-run";

const SESSION = "11111111-1111-4111-8111-111111111111";

function machine(options: { enrolled?: boolean; harnesses?: string[] } = {}) {
  const paths = scratchPaths("linux");
  if (options.enrolled !== false) {
    const signer = bundleSigner();
    mkdirSync(dirname(paths.hostFile), { recursive: true });
    writeHostFile(
      paths.hostFile,
      testHostFile(signer, signer.sign(unsignedBundle()), {
        harnesses: (options.harnesses ?? ["claude-code"]) as never,
      }),
    );
  }
  const errors: string[] = [];
  const hookCalls: Array<{ payload: Record<string, unknown>; argv: string[] }> =
    [];
  const spawned: Array<{
    command: string;
    args: string[];
    env: Record<string, string | undefined>;
  }> = [];
  let answer = "{}\n";
  let exit: AgentExit = { code: 0, signal: null };
  const contained = vi.fn(async () => 9);
  const deps: AgentRunDeps = {
    paths,
    env: { PATH: "/usr/bin" },
    platform: "linux",
    err: (line) => errors.push(line),
    write: () => undefined,
    cwd: "/work/repo",
    runtime: {
      hookCommand: "/opt/oxagen/oxagen hook",
      credentialHelperCommand:
        "/opt/oxagen/oxagen credential issue --harness claude-code",
      daemonCommand: ["/opt/oxagen/oxagen", "daemon"],
      mcpStdioCommand: ["/opt/oxagen/oxagen", "mcp-stdio"],
      binDir: "/opt/oxagen",
      program: "oxagen",
    },
    hook: async (payload, argv) => {
      hookCalls.push({
        payload: JSON.parse(payload) as Record<string, unknown>,
        argv: [...argv],
      });
      return { stdout: answer };
    },
    spawnAgent: async (command, args, options) => {
      spawned.push({ command, args, env: options.env });
      return exit;
    },
    contained,
    newSessionId: () => SESSION,
  };
  return {
    deps,
    errors,
    hookCalls,
    spawned,
    contained,
    answer: (value: string) => {
      answer = value;
    },
    exit: (value: AgentExit) => {
      exit = value;
    },
  };
}

describe("oxagen agent run with a custom agent", () => {
  it("opens the session, runs the agent with the session's hook, and closes it", async () => {
    const m = machine();
    m.exit({ code: 3, signal: null });
    const code = await runAgentSession(
      { command: ["./bin/release-bot.mjs", "--dry-run"] },
      m.deps,
    );
    expect(code).toBe(3);
    expect(m.hookCalls.map((call) => call.payload["hook_event_name"])).toEqual(
      ["SessionStart", "SessionEnd"],
    );
    for (const call of m.hookCalls) {
      expect(call.payload["session_id"]).toBe(SESSION);
      expect(call.payload["cwd"]).toBe("/work/repo");
      expect(call.argv).toEqual([
        "node",
        "oxagen",
        "hook",
        "--enrollment",
        TEST_ENROLLMENT,
        "--agent",
        "release-bot",
      ]);
    }
    expect(m.spawned).toHaveLength(1);
    expect(m.spawned[0]?.command).toBe("./bin/release-bot.mjs");
    expect(m.spawned[0]?.args).toEqual(["--dry-run"]);
    // The agent reports its own steps on the same session through these.
    expect(m.spawned[0]?.env).toMatchObject({
      PATH: "/usr/bin",
      OXAGEN_AGENT: "release-bot",
      OXAGEN_SESSION_ID: SESSION,
      OXAGEN_HOOK: `/opt/oxagen/oxagen hook --enrollment ${TEST_ENROLLMENT} --agent release-bot`,
    });
  });

  it("records the agent under --name", async () => {
    const m = machine();
    await runAgentSession(
      { command: ["python3", "agent.py"], name: "stripe-refunds" },
      m.deps,
    );
    expect(m.hookCalls[0]?.argv.at(-1)).toBe("stripe-refunds");
    expect(m.spawned[0]?.env["OXAGEN_AGENT"]).toBe("stripe-refunds");
  });

  it("starts nothing when the control plane refuses the session (negative)", async () => {
    const m = machine();
    m.answer(
      JSON.stringify({ continue: false, stopReason: "This host is paused." }),
    );
    const code = await runAgentSession({ command: ["./my-agent"] }, m.deps);
    expect(code).toBe(1);
    expect(m.spawned).toEqual([]);
    expect(m.hookCalls).toHaveLength(1);
    expect(m.errors.join("\n")).toContain("This host is paused.");
  });

  it("closes the session even when the agent cannot start", async () => {
    const m = machine();
    m.exit({ code: null, signal: null, error: new Error("spawn ENOENT") });
    const code = await runAgentSession({ command: ["./missing"] }, m.deps);
    expect(code).toBe(1);
    expect(m.hookCalls.map((call) => call.payload["hook_event_name"])).toEqual(
      ["SessionStart", "SessionEnd"],
    );
    expect(m.errors.join("\n")).toContain("Could not start ./missing");
  });

  it("refuses a name the hook would refuse, and names --name (negative)", async () => {
    const m = machine();
    // `custom` is a reserved runtime name.
    const code = await runAgentSession({ command: ["./custom"] }, m.deps);
    expect(code).toBe(2);
    expect(m.hookCalls).toEqual([]);
    expect(m.errors.join("\n")).toContain("--name");
  });

  it("reports under a live agent when the first agent directory is retired", async () => {
    const m = machine();
    // A retired agent whose directory sorts before the live one.
    const signer = bundleSigner();
    const retired = agentPaths(m.deps.paths, "00000000");
    mkdirSync(dirname(retired.hostFile), { recursive: true });
    writeHostFile(
      retired.hostFile,
      testHostFile(signer, signer.sign(unsignedBundle()), {
        host_enrollment_id: "tch_retired0000000000000000",
        enrolled_at: "2026-09-01T00:00:00.000Z",
        revoked_at: "2026-09-02T00:00:00.000Z",
      }),
    );
    await runAgentSession({ command: ["./my-agent"] }, m.deps);
    for (const call of m.hookCalls)
      expect(call.argv.slice(3, 5)).toEqual(["--enrollment", TEST_ENROLLMENT]);
    expect(m.spawned[0]?.env["OXAGEN_HOOK"]).toContain(
      `--enrollment ${TEST_ENROLLMENT}`,
    );
  });

  it("refuses on a machine that is not enrolled (negative)", async () => {
    const m = machine({ enrolled: false });
    const code = await runAgentSession({ command: ["./my-agent"] }, m.deps);
    expect(code).toBe(1);
    expect(m.hookCalls).toEqual([]);
    expect(m.errors.join("\n")).toContain("oxagen agent enroll");
  });

  it("names the form when no command follows -- (negative)", async () => {
    const m = machine();
    expect(await runAgentSession({ command: [] }, m.deps)).toBe(2);
    expect(m.errors.join("\n")).toContain("oxagen agent run -- ");
  });
});

describe("oxagen agent run with a harness", () => {
  it("runs a wrapped harness as it is, recorded by its own hooks", async () => {
    const m = machine({ harnesses: ["claude-code"] });
    const code = await runAgentSession(
      { command: ["/usr/local/bin/claude", "-p", "fix the build"] },
      m.deps,
    );
    expect(code).toBe(0);
    expect(m.hookCalls).toEqual([]);
    expect(m.spawned[0]?.args).toEqual(["-p", "fix the build"]);
    expect(m.spawned[0]?.env).not.toHaveProperty("OXAGEN_HOOK");
    expect(m.errors.join("\n")).toContain("acme.core.cc-laptop");
  });

  it("refuses a harness this machine does not wrap (negative)", async () => {
    const m = machine({ harnesses: ["claude-code"] });
    const code = await runAgentSession(
      { command: ["codex", "exec", "fix it"] },
      m.deps,
    );
    expect(code).toBe(2);
    expect(m.spawned).toEqual([]);
    expect(m.errors.join("\n")).toContain(
      "oxagen agent enroll --harness codex",
    );
    expect(m.errors.join("\n")).toContain("--contained");
  });

  it("starts the contained launcher with --contained", async () => {
    const m = machine();
    const code = await runAgentSession(
      {
        command: ["claude", "-p", "task"],
        contained: true,
        image: "ghcr.io/acme/contained:1",
      },
      m.deps,
    );
    expect(code).toBe(9);
    expect(m.contained).toHaveBeenCalledWith(
      { agent: "claude", args: ["-p", "task"], image: "ghcr.io/acme/contained:1" },
      m.deps,
    );
    expect(m.spawned).toEqual([]);
  });
});

describe("the session helpers", () => {
  it("derives a custom agent's name from its command", () => {
    expect(agentNameFromCommand("./bin/Release Bot.mjs")).toBe("release-bot");
    expect(agentNameFromCommand("C:\\agents\\deploy.exe")).toBe("deploy");
    expect(agentNameFromCommand("/opt/__agent")).toBe("agent");
  });

  it("reads a refusal from the hook's answer, and nothing else", () => {
    expect(sessionRefusal('{"continue":false,"stopReason":"paused"}')).toBe(
      "paused",
    );
    expect(sessionRefusal('{"decision":"block","reason":"suspended"}')).toBe(
      "suspended",
    );
    expect(sessionRefusal('{"continue":false}')).toBe(
      "the control plane refused this session",
    );
    expect(sessionRefusal("{}")).toBeUndefined();
    expect(sessionRefusal("not json")).toBeUndefined();
    expect(sessionRefusal("null")).toBeUndefined();
  });

  it("reports the agent's exit, a signal as 128 plus its number", () => {
    expect(exitCodeOf({ code: 0, signal: null })).toBe(0);
    expect(exitCodeOf({ code: 5, signal: null })).toBe(5);
    expect(exitCodeOf({ code: null, signal: "SIGTERM" })).toBe(143);
    expect(exitCodeOf({ code: null, signal: null })).toBe(1);
    expect(
      exitCodeOf({ code: null, signal: null, error: new Error("ENOENT") }),
    ).toBe(1);
  });
});

describe("spawnAgent", () => {
  it("waits for the agent and reports its exit code", async () => {
    const before = ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) =>
      process.listenerCount(signal),
    );
    const exit = await spawnAgent(
      process.execPath,
      ["-e", "process.exit(Number(process.env.EXIT_WITH))"],
      { env: { ...process.env, EXIT_WITH: "3" }, cwd: process.cwd() },
    );
    expect(exit).toEqual({ code: 3, signal: null });
    // The wrapper's own signal handlers come off with the agent.
    expect(
      ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) =>
        process.listenerCount(signal),
      ),
    ).toEqual(before);
  });

  it("reports a command that cannot start (negative)", async () => {
    const exit = await spawnAgent(
      "/nonexistent/oxagen-agent-run-test",
      [],
      { env: process.env, cwd: process.cwd() },
    );
    expect(exit.error).toBeInstanceOf(Error);
    expect(exitCodeOf(exit)).toBe(1);
  });
});
