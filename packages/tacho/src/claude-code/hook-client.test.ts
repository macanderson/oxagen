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
import { RESERVED_AGENT_NAMES } from "../wire";
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

  it("refuses a Cursor call whose payload it cannot parse", async () => {
    // The same fail-open as an unreadable enrollment, one step earlier. `{}`
    // reads as no opinion to Claude Code, and Cursor's failClosed does not
    // cover it: the hook answered successfully with nothing. A truncated
    // payload or a schema change on Cursor's side would stop enforcement
    // while every call was recorded as allowed.
    const paths = scratchPaths();
    const cursor = await runTachoHook({
      paths,
      env: {},
      stdin: '{"hook_event_name":"preToolUse"}',
      harness: "cursor",
    });
    expect(cursor.path).toBe("invalid");
    expect(cursor.exitCode).toBe(0);
    expect(
      (JSON.parse(cursor.stdout) as Record<string, unknown>)["permission"],
    ).toBe("deny");

    // The refusal has to take the shape the event reads. Cursor reads
    // `permission` at preToolUse and `continue` at beforeSubmitPrompt, so one
    // blanket permission deny was ignored outright at the prompt veto and the
    // malformed prompt went through.
    const prompt = await runTachoHook({
      paths,
      env: {},
      stdin: '{"hook_event_name":"beforeSubmitPrompt"}',
      harness: "cursor",
    });
    expect(prompt.path).toBe("invalid");
    const promptAnswer = JSON.parse(prompt.stdout) as Record<string, unknown>;
    expect(promptAnswer["continue"]).toBe(false);

    // A payload too broken to name its own event is refused in both shapes,
    // since refusing an event that needed no refusal costs nothing next to
    // allowing one that did.
    const nameless = await runTachoHook({
      paths,
      env: {},
      stdin: "{}",
      harness: "cursor",
    });
    const namelessAnswer = JSON.parse(nameless.stdout) as Record<
      string,
      unknown
    >;
    expect(namelessAnswer["permission"]).toBe("deny");
    expect(namelessAnswer["continue"]).toBe(false);

    // Truncated JSON is the likeliest unreadable payload there is, and it
    // takes a different branch from a readable payload that fails the
    // schema. Fixing one and not the other left the common case open.
    const truncated = await runTachoHook({
      paths,
      env: {},
      stdin: '{"hook_event_name":"preToolUse","tool_nam',
      harness: "cursor",
    });
    expect(truncated.path).toBe("invalid");
    expect(
      (JSON.parse(truncated.stdout) as Record<string, unknown>)["permission"],
    ).toBe("deny");

    // Claude Code keeps its own answer: `{}` is how a hook says nothing
    // there, and changing it would alter behaviour this finding is not about.
    const claude = await runTachoHook({
      paths,
      env: {},
      stdin: "not json",
    });
    expect(claude.path).toBe("invalid");
    expect(claude.stdout).toBe("{}\n");
  });

  it("refuses a Cursor call when it cannot read the enrollment it has", async () => {
    // An unenrolled machine is one Oxagen does not govern, so allowing is
    // right. A machine whose host.json exists and will not parse is a
    // governed machine with an unreadable mandate, and Cursor turns an empty
    // answer into an explicit allow at a veto point. `failClosed` does not
    // catch that: the hook did not crash or time out, it succeeded and
    // granted permission.
    const paths = scratchPaths();
    const corrupt = await runTachoHook({
      paths,
      env: {},
      stdin: JSON.stringify({
        conversation_id: "11111111-1111-4111-8111-1111111111aa",
        generation_id: "gen-1",
        hook_event_name: "preToolUse",
        cursor_version: "1.7.2",
        workspace_roots: ["/home/dev/proj"],
        tool_name: "Shell",
        tool_input: { command: "rm -rf /" },
        tool_use_id: "toolu_1",
        cwd: "/home/dev/proj",
      }),
      harness: "cursor",
      readHost: () => {
        throw new Error("corrupt");
      },
    });
    expect(corrupt.path).toBe("unenrolled");
    expect(corrupt.exitCode).toBe(0);
    const answer = JSON.parse(corrupt.stdout) as Record<string, unknown>;
    expect(answer["permission"]).toBe("deny");
    expect(String(answer["user_message"])).toContain("enrollment");

    // A machine with no enrollment at all is still allowed: Oxagen does not
    // govern it and must not block it.
    const absent = await runTachoHook({
      paths,
      env: {},
      stdin: JSON.stringify({
        conversation_id: "11111111-1111-4111-8111-1111111111bb",
        generation_id: "gen-1",
        hook_event_name: "preToolUse",
        cursor_version: "1.7.2",
        workspace_roots: ["/home/dev/proj"],
        tool_name: "Shell",
        tool_input: { command: "ls" },
        tool_use_id: "toolu_2",
        cwd: "/home/dev/proj",
      }),
      harness: "cursor",
    });
    expect(absent.path).toBe("unenrolled");
    expect(
      (JSON.parse(absent.stdout) as Record<string, unknown>)["permission"],
    ).toBe("allow");
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
    expect(harnessFromArgv(["--harness", "cursor"])).toBe("cursor");
    expect(harnessFromArgv(["--harness", "not-a-harness"])).toBe("claude-code");
    expect(harnessFromArgv(["--harness", "windsurf"])).toBe("claude-code");
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
    // PermissionRequest carries a tool identity exactly like PreToolUse
    // (data-model.md section 6), so it must consult the cached bundle rather
    // than answering `{}` (allow) unconditionally: an earlier version did
    // exactly that, which meant a deny-listed tool bypassed the mandate
    // whenever the daemon was down and Claude Code happened to route the
    // call through its own permission-request flow instead of PreToolUse.
    expect(
      decideLocally(
        active,
        parse("PermissionRequest", {
          tool_name: "Bash",
          tool_input: { command: "git push" },
        }),
        now,
      ).response,
    ).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        permissionDecision: "deny",
      },
    });
    // A tool the mandate never mentions still fails open, and to Claude
    // Code's own permission prompt (`{}`), not to a manufactured allow.
    expect(
      decideLocally(
        active,
        parse("PermissionRequest", {
          tool_name: "Edit",
          tool_input: { file_path: "/x" },
        }),
        now,
      ).response,
    ).toEqual({});
    expect(decideLocally(active, parse("Stop"), now).response).toEqual({});
    // Cursor's subagentStart is a permission event: a paused host must deny,
    // or an empty answer becomes allow and the subagent launches anyway.
    expect(
      decideLocally(
        paused,
        parse("SubagentStart", { agent_type: "explore" }),
        now,
      ).response,
    ).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(
      decideLocally(
        active,
        parse("SubagentStart", { agent_type: "explore" }),
        now,
      ).evaluation?.decision,
    ).toBeDefined();
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
      harnessInstance: () => "c0ffee112233",
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
      // The pid alone would be reused; the process start time is mixed in.
      session_id: "stella-4242-c0ffee112233",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "git push" },
    });
    expect(body.payload["tool_use_id"]).toMatch(/^stella_/);
    // HOME is not a harness variable; the Stella pid is added for the sweep.
    expect(body.env).toEqual({ TACHO_HARNESS_PID: "4242" });
    expect(seen[0]?.responseTimeoutMs).toBe(10_000);
    // A body that is not a JSON object is a fault, not a decision, so the
    // local evaluator answers instead of the daemon.
    const junk = await runTachoHook({
      ...base,
      stdin: STELLA_PRE,
      post: async () => ({ status: 200, body: "oops" }),
    });
    expect(junk).toMatchObject({ path: "local", exitCode: 0 });
    expect(junk.stderr).toContain("not a JSON object");
    // A blank 200 is the same fault: whitespace is not an intentional "{}".
    const blank = await runTachoHook({
      ...base,
      stdin: STELLA_PRE,
      post: async () => ({ status: 200, body: "   \n\t" }),
    });
    expect(blank).toMatchObject({ path: "local", exitCode: 0 });
    expect(blank.stderr).toContain("not a JSON object");
    // An intentional empty object still reaches Stella as no opinion.
    const emptyObject = await runTachoHook({
      ...base,
      stdin: STELLA_PRE,
      post: async () => ({ status: 200, body: "{}" }),
    });
    expect(emptyObject).toMatchObject({ path: "daemon", exitCode: 0 });
    expect(emptyObject.stdout).toBe("{}\n");
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
    // Without an injected lookup the pid is found from this process's parent,
    // and its start time from ps (absent on a host where ps says nothing).
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
    ).toMatch(/^stella-\d+(-[0-9a-f]{12})?$/);
  });

  it("decides locally in Stella's vocabulary and spools the translated payload when the daemon is down", async () => {
    const paths = enrolledPaths();
    const down = await runTachoHook({
      paths,
      env: {},
      stdin: STELLA_PRE,
      harness: "stella",
      harnessPid: () => 99,
      // ps could not read a start time: the id keeps the bare pid form.
      harnessInstance: () => undefined,
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
    const reservedNames = [
      "claude-code",
      "codex",
      "cursor",
      "stella",
      "claude-desktop",
      "claude-agent-sdk",
      "custom",
      "proxy",
    ];
    // Every harness and runtime is reserved, so the list here is the whole
    // set: a harness added without updating this test would drift the
    // diagnostic every caller reads.
    expect([...RESERVED_AGENT_NAMES]).toEqual(reservedNames);
    for (const reserved of reservedNames) {
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
        `tacho-hook: invalid --agent name "${reserved}"; "${reserved}" is a built-in harness or runtime name (reserved: ${reservedNames.join(", ")})\n`,
      );
    }
  });
});

/**
 * Cursor end to end through the hook process: Cursor's payload in, the
 * daemon's Claude Code answer back, Cursor's flat permission object out.
 * The shapes are Cursor's documented ones (verified 2026-09-18 against
 * https://cursor.com/docs/agent/hooks, fetched that day).
 */
describe("runTachoHook for Cursor", () => {
  const CURSOR_PRE = JSON.stringify({
    conversation_id: "conv_01J8",
    generation_id: "gen_04",
    hook_event_name: "preToolUse",
    cursor_version: "2026.9.10",
    workspace_roots: ["/repo"],
    user_email: "someone@example.com",
    tool_name: "Shell",
    tool_input: { command: "git push" },
    tool_use_id: "toolu_77",
    cwd: "/repo",
  });

  it("translates the payload for the daemon and the answer back for Cursor", async () => {
    const paths = enrolledPaths();
    const seen: Array<Parameters<typeof postUnix>[0]> = [];
    const denied = await runTachoHook({
      paths,
      env: { HOME: "/h" },
      harness: "cursor",
      platform: "linux",
      stdin: CURSOR_PRE,
      post: async (options) => {
        seen.push(options);
        return {
          status: 200,
          body: '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"no push"}}',
        };
      },
    });
    expect(denied).toMatchObject({ path: "daemon", exitCode: 0 });
    expect(JSON.parse(denied.stdout)).toEqual({
      permission: "deny",
      user_message: "no push",
      agent_message: "no push",
    });
    const body = JSON.parse(seen[0]?.body ?? "{}") as {
      payload: Record<string, unknown>;
      harness: string;
    };
    expect(body.harness).toBe("cursor");
    expect(body.payload).toMatchObject({
      // Cursor issues both ids, so nothing is synthesized from a pid or a
      // digest of the call the way Stella's are. The tool is renamed to
      // Claude Code's vocabulary so one policy rule governs both harnesses.
      session_id: "conv_01J8",
      hook_event_name: "PreToolUse",
      tool_use_id: "toolu_77",
      tool_name: "Bash",
      cursor_tool_name: "Shell",
      cwd: "/repo",
    });
    // The address Cursor sends on every hook never reaches the daemon.
    expect(seen[0]?.body).not.toContain("someone@example.com");
    expect(seen[0]?.responseTimeoutMs).toBe(10_000);
    // A body that is not a JSON object is a fault, not an empty decision: it
    // takes the local evaluator rather than becoming the explicit allow that
    // an empty answer translates to. Cursor still reads a conforming answer.
    const junk = await runTachoHook({
      paths,
      env: {},
      stdin: CURSOR_PRE,
      harness: "cursor",
      platform: "linux",
      post: async () => ({ status: 200, body: "oops" }),
    });
    expect(junk).toMatchObject({ path: "local", exitCode: 0 });
    expect(junk.stderr).toContain("not a JSON object");
    expect(
      (JSON.parse(junk.stdout) as { permission?: string }).permission,
    ).toMatch(/^(allow|deny)$/);
    // Blank or whitespace-only is the same fault as truncated JSON.
    const blank = await runTachoHook({
      paths,
      env: {},
      stdin: CURSOR_PRE,
      harness: "cursor",
      platform: "linux",
      post: async () => ({ status: 200, body: "" }),
    });
    expect(blank).toMatchObject({ path: "local", exitCode: 0 });
    expect(blank.stderr).toContain("not a JSON object");
    expect(
      (JSON.parse(blank.stdout) as { permission?: string }).permission,
    ).toMatch(/^(allow|deny)$/);
  });

  it("denies from the cached bundle when the daemon is down", async () => {
    // Cursor fails open on its own, which is why the hook is registered
    // failClosed. What it answers when the daemon cannot be reached still
    // has to be a refusal, not an empty document.
    const paths = enrolledPaths();
    const local = await runTachoHook({
      paths,
      env: {},
      harness: "cursor",
      platform: "linux",
      stdin: CURSOR_PRE,
      post: async () => {
        throw new Error("no daemon");
      },
    });
    expect(local.path).toBe("local");
    expect(JSON.parse(local.stdout)["permission"]).toBe("deny");
  });

  it("refuses a payload that is not a Cursor hook", async () => {
    const result = await runTachoHook({
      paths: enrolledPaths(),
      env: {},
      harness: "cursor",
      platform: "linux",
      stdin: '{"hook_event_name":"preToolUse"}',
      post: async () => ({ status: 200, body: "{}" }),
    });
    expect(result.path).toBe("invalid");
    expect(result.stderr).toBe("tacho-hook: payload is not a Cursor hook\n");
  });

  it("refuses a Cursor tool call when the enrollment cannot be read, and allows one on a machine that is simply not enrolled", async () => {
    // Cursor reads a malformed answer as a block, so "no opinion" is written
    // as an explicit allow. That is right for a machine Oxagen does not
    // govern and wrong when the file saying whether it governs this machine
    // is unreadable: the tool would run with no policy evaluated.
    const unreadable = await runTachoHook({
      paths: scratchPaths(),
      env: {},
      stdin: CURSOR_PRE,
      harness: "cursor",
      platform: "linux",
      readHost: () => {
        throw new Error("corrupt");
      },
    });
    expect(unreadable).toMatchObject({ path: "unenrolled", exitCode: 0 });
    expect(JSON.parse(unreadable.stdout)).toMatchObject({
      permission: "deny",
    });
    expect(unreadable.stderr).toContain("corrupt");

    // A machine that was never enrolled is not a failure to evaluate, so it
    // still answers allow and does not block the person's own tools.
    const unenrolled = await runTachoHook({
      paths: scratchPaths(),
      env: {},
      stdin: CURSOR_PRE,
      harness: "cursor",
      platform: "linux",
    });
    expect(unenrolled).toMatchObject({ path: "unenrolled", exitCode: 0 });
    expect(JSON.parse(unenrolled.stdout)).toEqual({ permission: "allow" });
  });

  it("refuses a Cursor subagent start while the host is blocked and allows one otherwise", async () => {
    const CURSOR_SUBAGENT = JSON.stringify({
      conversation_id: "conv-9",
      hook_event_name: "subagentStart",
      workspace_roots: ["/repo"],
      subagent_id: "sa-1",
      subagent_type: "explore",
    });
    const pathsWithStatus = (
      status: "active" | "paused" | "suspended" | "revoked",
    ) => {
      const paths = scratchPaths();
      const signer = bundleSigner();
      writeHostFile(
        paths.hostFile,
        testHostFile(signer, signer.sign(unsignedBundle()), {
          host_status: status,
        }),
      );
      return paths;
    };
    // Cursor reads subagentStart as a permission event, and an empty answer
    // translates to an explicit allow. An operator who paused, suspended or
    // revoked the host said the agent stops, so the local evaluator decides
    // rather than falling through to that allow.
    for (const status of ["paused", "suspended", "revoked"] as const) {
      const blocked = await runTachoHook({
        paths: pathsWithStatus(status),
        env: {},
        stdin: CURSOR_SUBAGENT,
        harness: "cursor",
        platform: "linux",
        post: async () => {
          throw new Error("daemon down");
        },
      });
      expect(blocked.path).toBe("local");
      expect(JSON.parse(blocked.stdout)).toMatchObject({
        permission: "deny",
        agent_message: expect.stringContaining(status),
      });
    }
    // An active host still launches subagents, so the refusal is the operator
    // state and not a blanket block.
    const allowed = await runTachoHook({
      paths: pathsWithStatus("active"),
      env: {},
      stdin: CURSOR_SUBAGENT,
      harness: "cursor",
      platform: "linux",
      post: async () => {
        throw new Error("daemon down");
      },
    });
    expect(allowed.path).toBe("local");
    expect(JSON.parse(allowed.stdout)).toEqual({ permission: "allow" });
    // The daemon's own deny, which is where a cancelled session lands, reaches
    // Cursor in the same shape.
    const fromDaemon = await runTachoHook({
      paths: pathsWithStatus("active"),
      env: {},
      stdin: CURSOR_SUBAGENT,
      harness: "cursor",
      platform: "linux",
      post: async () => ({
        status: 200,
        body: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "SubagentStart",
            permissionDecision: "deny",
            permissionDecisionReason:
              "This session was cancelled by its Oxagen operator.",
          },
        }),
      }),
    });
    expect(fromDaemon.path).toBe("daemon");
    expect(JSON.parse(fromDaemon.stdout)).toEqual({
      permission: "deny",
      user_message: "This session was cancelled by its Oxagen operator.",
      agent_message: "This session was cancelled by its Oxagen operator.",
    });
  });
});

/**
 * The compiled mandate actually reaches the hook: enroll a fake harness with
 * a signed bundle carrying a real deny rule, take the daemon down, and prove
 * `PreToolUse` denies the call the rule names. The negative control is the
 * same harness, the same call, and a bundle with no mandate at all: the
 * shape a freshly enrolled, unmandated host carries (`mode: "observe"`,
 * every permission array empty, as `tacho-host-enroll.ts` inserts one). It
 * must allow, so the positive result is the rule's doing and not some
 * other default this test would not have caught.
 */
describe("a mandate that denies git push, end to end", () => {
  const PUSH = JSON.stringify({
    session_id: "s",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "git push origin main" },
    cwd: "/repo",
  });
  const daemonDown = async (): Promise<never> => {
    throw new Error("daemon unreachable");
  };

  function enroll(bundleOverrides: Parameters<typeof unsignedBundle>[0]) {
    const paths = scratchPaths();
    const signer = bundleSigner();
    writeHostFile(
      paths.hostFile,
      testHostFile(signer, signer.sign(unsignedBundle(bundleOverrides))),
    );
    return paths;
  }

  it("denies git push when the mandate carries a deny rule for it", async () => {
    const paths = enroll({
      mode: "enforce",
      permissions: {
        allow: [],
        deny: ["Bash(git push*)"],
        ask: [],
      },
    });
    const result = await runTachoHook({
      paths,
      env: {},
      stdin: PUSH,
      post: daemonDown,
    });
    expect(result.path).toBe("local");
    expect(JSON.parse(result.stdout)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining("Bash(git push*)"),
      },
    });
  });

  it("negative control: the same call allows when the host carries no mandate", async () => {
    const paths = enroll({
      mode: "observe",
      permissions: { allow: [], deny: [], ask: [] },
    });
    const result = await runTachoHook({
      paths,
      env: {},
      stdin: PUSH,
      post: daemonDown,
    });
    expect(result.path).toBe("local");
    expect(JSON.parse(result.stdout)).toEqual({});
  });
});
