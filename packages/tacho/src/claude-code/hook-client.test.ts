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
import { decideLocally, postUnix, runTachoHook } from "./hook-client";
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
