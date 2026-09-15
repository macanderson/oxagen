import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeHostFile } from "../host/host-file";
import {
  bundleSigner,
  scratchPaths,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import {
  agentFromArgv,
  decideLocally,
  harnessFromArgv,
  postUnix,
  runTachoHook,
} from "./hook-client";
import { hookInputSchema } from "./hooks";

const PRE = JSON.stringify({
  session_id: "s",
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "git push" },
  cwd: "/repo",
});

describe("runTachoHook", () => {
  it("answers {} for junk and for an unenrolled machine without failing the hook", async () => {
    const paths = scratchPaths();
    expect(
      await runTachoHook({ paths, env: {}, stdin: "not json" }),
    ).toMatchObject({ path: "invalid", exitCode: 0, stdout: "{}\n" });
    expect(await runTachoHook({ paths, env: {}, stdin: "{}" })).toMatchObject({
      path: "invalid",
    });
    expect(await runTachoHook({ paths, env: {}, stdin: PRE })).toMatchObject({
      path: "unenrolled",
      stdout: "{}\n",
    });
    expect(
      await runTachoHook({
        paths,
        env: {},
        stdin: PRE,
        readHost: () => {
          throw new Error("corrupt");
        },
      }),
    ).toMatchObject({
      path: "unenrolled",
      stderr: expect.stringContaining("corrupt"),
    });
  });

  it("forwards to the daemon with the local bearer and a filtered env, and falls back locally", async () => {
    const paths = scratchPaths();
    const signer = bundleSigner();
    const host = testHostFile(signer, signer.sign(unsignedBundle()));
    writeHostFile(paths.hostFile, host);
    const seen: Array<Parameters<typeof postUnix>[0]> = [];
    const daemon = await runTachoHook({
      paths,
      env: { CLAUDE_PID: "1", ANTHROPIC_API_KEY: "sk-secret", HOME: "/h" },
      stdin: PRE,
      post: async (options) => {
        seen.push(options);
        return {
          status: 200,
          body: '{"hookSpecificOutput":{"permissionDecision":"deny"}}',
        };
      },
    });
    expect(daemon).toMatchObject({ path: "daemon", exitCode: 0 });
    expect(JSON.parse(daemon.stdout)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(seen[0]).toMatchObject({
      socketPath: paths.socket,
      path: `/hook/${host.host_enrollment_id}`,
      headers: {
        Authorization: `Bearer ${host.local_token}`,
        "x-tacho-envelope": "1",
      },
      connectTimeoutMs: 50,
      responseTimeoutMs: 10_000,
    });
    const body = JSON.parse(seen[0]?.body ?? "{}") as {
      env: Record<string, string>;
    };
    expect(body.env).toEqual({ CLAUDE_PID: "1" });
    // A non-200 from the daemon is treated as down.
    const refused = await runTachoHook({
      paths,
      env: {},
      stdin: PRE,
      post: async () => ({ status: 500, body: "x" }),
    });
    expect(refused.path).toBe("local");
    expect(JSON.parse(refused.stdout)).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason:
          "Denied by Oxagen policy rule Bash(git push*).",
      },
    });
    expect(readdirSync(paths.spool)).toHaveLength(1);
    const spooled = JSON.parse(
      readFileSync(
        join(paths.spool, readdirSync(paths.spool)[0] as string),
        "utf8",
      ),
    ) as { schema: string; evaluation: { decision: string } };
    expect(spooled.schema).toBe("tacho.spool.v1");
    expect(spooled.evaluation.decision).toBe("deny");
    // The real socket client against a missing socket reports a connect error quickly.
    const started = Date.now();
    const noSocket = await runTachoHook({
      paths,
      env: {},
      stdin: PRE,
      connectTimeoutMs: 50,
    });
    expect(noSocket.path).toBe("local");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("reads --harness off argv and defaults to Claude Code for anything else", () => {
    expect(harnessFromArgv(["--enrollment", "e", "--harness", "codex"])).toBe(
      "codex",
    );
    expect(harnessFromArgv(["--harness", "claude-code"])).toBe("claude-code");
    expect(harnessFromArgv(["--harness", "cursor"])).toBe("claude-code");
    expect(harnessFromArgv(["--harness"])).toBe("claude-code");
    expect(harnessFromArgv([])).toBe("claude-code");
  });

  it("posts over loopback TCP on Windows and labels the envelope and the spool with the harness", async () => {
    const paths = scratchPaths();
    const signer = bundleSigner();
    const host = testHostFile(signer, signer.sign(unsignedBundle()));
    writeHostFile(paths.hostFile, host);
    const seen: Array<Parameters<typeof postUnix>[0]> = [];
    const daemon = await runTachoHook({
      paths,
      env: {},
      stdin: PRE,
      platform: "win32",
      harness: "codex",
      post: async (options) => {
        seen.push(options);
        return { status: 200, body: "{}" };
      },
    });
    expect(daemon.path).toBe("daemon");
    // No Unix socket on Windows: the hook dials 127.0.0.1:<port> instead.
    expect(seen[0]?.loopbackPort).toBe(host.port);
    expect(seen[0]?.socketPath).toBeUndefined();
    expect(JSON.parse(seen[0]?.body ?? "{}")).toMatchObject({
      harness: "codex",
    });
    // A POSIX host keeps the socket and never sets a port.
    const posix = await runTachoHook({
      paths,
      env: {},
      stdin: PRE,
      platform: "linux",
      post: async (options) => {
        seen.push(options);
        return { status: 200, body: "{}" };
      },
    });
    expect(posix.path).toBe("daemon");
    expect(seen[1]?.socketPath).toBe(paths.socket);
    expect(seen[1]?.loopbackPort).toBeUndefined();
    expect(JSON.parse(seen[1]?.body ?? "{}")).toMatchObject({
      harness: "claude-code",
    });
    // When the daemon is down the spooled event still says which harness
    // ran the hook, so the replay labels the session the same way.
    const down = await runTachoHook({
      paths,
      env: {},
      stdin: PRE,
      platform: "win32",
      harness: "codex",
      post: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(down.path).toBe("local");
    const files = readdirSync(paths.spool);
    expect(files).toHaveLength(1);
    const spooled = JSON.parse(
      readFileSync(join(paths.spool, files[0] as string), "utf8"),
    ) as { harness: string; schema: string };
    expect(spooled.schema).toBe("tacho.spool.v1");
    expect(spooled.harness).toBe("codex");
  });

  it("decides every enforcement event locally per host status", () => {
    const signer = bundleSigner();
    const active = testHostFile(signer, signer.sign(unsignedBundle()));
    const paused = { ...active, host_status: "paused" as const };
    const parse = (event: string, extra: Record<string, unknown> = {}) =>
      hookInputSchema.parse({
        session_id: "s",
        hook_event_name: event,
        ...extra,
      });
    const now = Date.parse("2026-09-10T12:00:00.000Z");
    expect(
      decideLocally(active, parse("SessionStart"), now).response,
    ).toMatchObject({
      hookSpecificOutput: { additionalContext: "You are governed by Oxagen." },
    });
    expect(
      decideLocally(
        { ...active, bundle: { ...active.bundle, context: { system: null } } },
        parse("SessionStart"),
        now,
      ).response,
    ).toEqual({});
    expect(
      decideLocally(paused, parse("SessionStart"), now).response,
    ).toMatchObject({ continue: false });
    expect(
      decideLocally(active, parse("UserPromptSubmit"), now).response,
    ).toEqual({});
    expect(
      decideLocally(paused, parse("UserPromptSubmit"), now).response,
    ).toMatchObject({ decision: "block" });
    expect(
      decideLocally(active, parse("PermissionRequest"), now).response,
    ).toEqual({});
    expect(
      decideLocally(paused, parse("PermissionRequest"), now).response,
    ).toMatchObject({ hookSpecificOutput: { decision: { behavior: "deny" } } });
    expect(decideLocally(active, parse("Stop"), now).response).toEqual({});
    const read = decideLocally(
      active,
      parse("PreToolUse", {
        tool_name: "Read",
        tool_input: { file_path: "/x" },
      }),
      now,
    );
    expect(read.response).toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });
    const ask = decideLocally(
      active,
      parse("PreToolUse", {
        tool_name: "Bash",
        tool_input: { command: "rm -rf /" },
      }),
      now,
    );
    expect(ask.response).toMatchObject({
      hookSpecificOutput: { permissionDecision: "ask" },
    });
    const noRule = decideLocally(
      active,
      parse("PreToolUse", {
        tool_name: "Edit",
        tool_input: { file_path: "/x" },
      }),
      now,
    );
    expect(noRule.response).toEqual({});
    // Stale bundle with no daemon: fail closed in enforce, allow in observe.
    const stale = { ...active, deny_generation: { org: 9, workspace: 1 } };
    expect(
      decideLocally(
        stale,
        parse("PreToolUse", {
          tool_name: "Edit",
          tool_input: { file_path: "/x" },
        }),
        now,
      ).evaluation?.decision,
    ).toBe("deny");
    const observe = {
      ...stale,
      bundle: signer.sign(unsignedBundle({ mode: "observe" })),
    };
    expect(
      decideLocally(
        observe,
        parse("PreToolUse", {
          tool_name: "Edit",
          tool_input: { file_path: "/x" },
        }),
        now,
      ).evaluation?.decision,
    ).toBe("allow");
  });
});

const STELLA_PRE = JSON.stringify({
  event: "PreToolUse",
  cwd: "/repo",
  tool: { name: "Bash", input: { command: "git push" }, read_only: false },
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

describe("runTachoHook for Stella and custom agents", () => {
  it("reads --agent off argv, empty when the flag has no value", () => {
    expect(agentFromArgv(["--agent", "reviewer"])).toBe("reviewer");
    expect(agentFromArgv(["--enrollment", "e", "--agent"])).toBe("");
    expect(agentFromArgv(["--harness", "stella"])).toBeUndefined();
  });

  it("translates a Stella payload for the daemon and the daemon's answer for Stella", async () => {
    const paths = enrolledPaths();
    const seen: Array<Parameters<typeof postUnix>[0]> = [];
    const base = {
      paths,
      env: { HOME: "/h" },
      harness: "stella" as const,
      harnessPid: () => 4242,
      platform: "linux" as const,
    };
    const denied = await runTachoHook({
      ...base,
      stdin: STELLA_PRE,
      post: async (options) => {
        seen.push(options);
        return {
          status: 200,
          body: '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"no push"}}',
        };
      },
    });
    expect(denied).toMatchObject({
      path: "daemon",
      exitCode: 0,
      stdout: '{"action":"deny","reason":"no push"}\n',
    });
    const body = JSON.parse(seen[0]?.body ?? "{}") as {
      payload: Record<string, unknown>;
      env: Record<string, string>;
      harness: string;
    };
    expect(body.harness).toBe("stella");
    expect(body.payload).toMatchObject({
      session_id: "stella-4242",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "git push" },
    });
    expect(body.payload["tool_use_id"]).toMatch(/^stella_/);
    // HOME is not a harness variable; the Stella pid is added for the sweep.
    expect(body.env).toEqual({ TACHO_HARNESS_PID: "4242" });
    expect(seen[0]?.responseTimeoutMs).toBe(10_000);
    // A body that is not JSON is no decision, never a malformed one (which
    // Stella treats as a deny).
    const junk = await runTachoHook({
      ...base,
      stdin: STELLA_PRE,
      post: async () => ({ status: 200, body: "oops" }),
    });
    expect(junk.stdout).toBe("{}\n");
    // SessionStart context reaches Stella as prompt text.
    const started = await runTachoHook({
      ...base,
      stdin: JSON.stringify({ event: "SessionStart", cwd: "/repo" }),
      post: async () => ({
        status: 200,
        body: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: "Governed.",
          },
        }),
      }),
    });
    expect(started.stdout).toBe("Governed.\n");
    // Without an injected lookup the pid is found from this process's parent.
    const found: string[] = [];
    await runTachoHook({
      paths,
      env: {},
      stdin: JSON.stringify({ event: "Stop", cwd: "/" }),
      harness: "stella",
      post: async (options) => {
        found.push(options.body);
        return { status: 200, body: "{}" };
      },
    });
    expect(
      (JSON.parse(found[0] ?? "{}") as { payload: { session_id: string } })
        .payload.session_id,
    ).toMatch(/^stella-\d+$/);
  });

  it("decides locally in Stella's vocabulary and spools the translated payload when the daemon is down", async () => {
    const paths = enrolledPaths();
    const down = await runTachoHook({
      paths,
      env: {},
      stdin: STELLA_PRE,
      harness: "stella",
      harnessPid: () => 99,
      post: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(down.path).toBe("local");
    expect(JSON.parse(down.stdout)).toEqual({
      action: "deny",
      reason: "Denied by Oxagen policy rule Bash(git push*).",
    });
    const files = readdirSync(paths.spool);
    expect(files).toHaveLength(1);
    expect(
      JSON.parse(readFileSync(join(paths.spool, files[0] as string), "utf8")),
    ).toMatchObject({
      harness: "stella",
      payload: { session_id: "stella-99", hook_event_name: "PreToolUse" },
      env: { TACHO_HARNESS_PID: "99" },
    });
  });

  it("tells a Stella session on a suspended host why in prompt text, and denies its tool calls", async () => {
    const paths = scratchPaths();
    const signer = bundleSigner();
    writeHostFile(
      paths.hostFile,
      testHostFile(signer, signer.sign(unsignedBundle()), {
        host_status: "suspended",
      }),
    );
    const down = async (): Promise<never> => {
      throw new Error("ECONNREFUSED");
    };
    const started = await runTachoHook({
      paths,
      env: {},
      stdin: JSON.stringify({ event: "SessionStart", cwd: "/repo" }),
      harness: "stella",
      harnessPid: () => 7,
      post: down,
    });
    expect(started).toMatchObject({ path: "local", exitCode: 0 });
    expect(started.stdout).toBe(
      "Oxagen: This host is suspended by its Oxagen operator. Tool calls will be refused.\n",
    );
    const tool = await runTachoHook({
      paths,
      env: {},
      stdin: STELLA_PRE,
      harness: "stella",
      harnessPid: () => 7,
      post: down,
    });
    expect(JSON.parse(tool.stdout)).toMatchObject({ action: "deny" });
  });

  it("prints no JSON on an unenrolled Stella SessionStart and names Stella for a payload it cannot read", async () => {
    const paths = scratchPaths();
    expect(
      await runTachoHook({
        paths,
        env: {},
        stdin: JSON.stringify({ event: "SessionStart", cwd: "/" }),
        harness: "stella",
        harnessPid: () => 5,
      }),
    ).toMatchObject({ path: "unenrolled", stdout: "" });
    expect(
      await runTachoHook({
        paths,
        env: {},
        stdin: JSON.stringify({ hello: "x" }),
        harness: "stella",
        harnessPid: () => 5,
      }),
    ).toMatchObject({
      path: "invalid",
      stdout: "{}\n",
      stderr: "tacho-hook: payload is not a Stella hook\n",
    });
  });

  it("labels a custom agent's hook, lets --agent win over --harness, and refuses a bad name", async () => {
    const paths = enrolledPaths();
    const seen: Array<Parameters<typeof postUnix>[0]> = [];
    const ok = await runTachoHook({
      paths,
      env: {},
      stdin: PRE,
      agent: "reviewer",
      harness: "stella",
      post: async (options) => {
        seen.push(options);
        return {
          status: 200,
          body: '{"hookSpecificOutput":{"permissionDecision":"deny"}}',
        };
      },
    });
    expect(ok.path).toBe("daemon");
    // A custom agent speaks Claude Code's shape: the answer is untranslated.
    expect(JSON.parse(ok.stdout)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    const body = JSON.parse(seen[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body).toMatchObject({
      agent: "reviewer",
      payload: { session_id: "s" },
    });
    expect(body).not.toHaveProperty("harness");
    await runTachoHook({
      paths,
      env: {},
      stdin: PRE,
      agent: "reviewer",
      post: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const files = readdirSync(paths.spool);
    const spooled = JSON.parse(
      readFileSync(join(paths.spool, files[0] as string), "utf8"),
    ) as Record<string, unknown>;
    expect(spooled["agent"]).toBe("reviewer");
    expect(spooled).not.toHaveProperty("harness");
    for (const bad of ["", "Reviewer", "has space", "-lead", "x".repeat(65)]) {
      const refused = await runTachoHook({
        paths,
        env: {},
        stdin: PRE,
        agent: bad,
        post: async () => {
          throw new Error("must not post");
        },
      });
      expect(refused).toMatchObject({
        path: "invalid",
        stdout: "{}\n",
        exitCode: 0,
      });
      expect(refused.stderr).toContain("invalid --agent name");
    }
    // Every built-in harness and runtime name is reserved, so a custom
    // agent can never be listed as one of them.
    for (const reserved of [
      "claude-code",
      "codex",
      "stella",
      "claude-agent-sdk",
      "custom",
      "proxy",
    ]) {
      const refused = await runTachoHook({
        paths,
        env: {},
        stdin: PRE,
        agent: reserved,
        post: async () => {
          throw new Error("must not post");
        },
      });
      expect(refused).toMatchObject({
        path: "invalid",
        stdout: "{}\n",
        exitCode: 0,
      });
      expect(refused.stderr).toBe(
        `tacho-hook: invalid --agent name "${reserved}"; "${reserved}" is a built-in harness or runtime name (reserved: claude-code, codex, stella, claude-agent-sdk, custom, proxy)\n`,
      );
    }
  });
});
