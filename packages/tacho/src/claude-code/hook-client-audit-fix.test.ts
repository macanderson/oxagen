/**
 * The offline hook path's audit fixes: another host's bundle, the signed
 * host status, home-relative rules, Stella's read-only claim, a host.json
 * this binary cannot fully parse, and a hook entry from an old enrollment.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { writeHostFile } from "../host/host-file";
import {
  bundleSigner,
  scratchPaths,
  TEST_ENROLLMENT,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import {
  decideLocally,
  enrollmentFromArgv,
  postUnix,
  runTachoHook,
} from "./hook-client";
import { hookInputSchema } from "./hooks";

const NOW = Date.parse("2026-09-10T12:00:00.000Z");
const signer = bundleSigner();
const OTHER_ENROLLMENT = "tch_zzzzzzzzzzzzzzzzzzzz00";

const parse = (event: string, extra: Record<string, unknown> = {}) =>
  hookInputSchema.parse({ session_id: "s", hook_event_name: event, ...extra });

const EDIT = parse("PreToolUse", {
  tool_name: "Edit",
  tool_input: { file_path: "/repo/a.ts" },
  cwd: "/repo",
});

const PRE = (tool_name: string, tool_input: Record<string, unknown>) =>
  JSON.stringify({
    session_id: "s",
    hook_event_name: "PreToolUse",
    tool_name,
    tool_input,
    cwd: "/repo",
  });

const down = async (): Promise<never> => {
  throw new Error("ECONNREFUSED");
};

describe("the bundle the offline path trusts", () => {
  it("refuses a mutating call under another host's signed observe bundle", () => {
    const copied = testHostFile(
      signer,
      signer.sign(
        unsignedBundle({
          mode: "observe",
          host_enrollment_id: OTHER_ENROLLMENT,
        }),
      ),
    );
    expect(decideLocally(copied, EDIT, NOW).evaluation).toMatchObject({
      decision: "deny",
      reason_code: "bundle_unverified",
    });
  });

  it("refuses a mutating call when host.json was edited from enforce to observe", () => {
    const signed = signer.sign(unsignedBundle());
    const tampered = testHostFile(signer, { ...signed, mode: "observe" });
    expect(decideLocally(tampered, EDIT, NOW).evaluation).toMatchObject({
      decision: "deny",
      reason_code: "bundle_unverified",
    });
  });
});

describe("the host status the offline path acts on", () => {
  it("keeps a signed suspension when host.json says active", () => {
    const host = testHostFile(
      signer,
      signer.sign(unsignedBundle({ host_status: "suspended" })),
      { host_status: "active" },
    );
    expect(decideLocally(host, EDIT, NOW).evaluation).toMatchObject({
      decision: "deny",
      reason_code: "host_suspended",
    });
    expect(decideLocally(host, parse("SessionStart"), NOW).response).toEqual({
      continue: false,
      stopReason: "This host is suspended by its Oxagen operator.",
    });
  });

  it("keeps an unsigned pause over a signed active status", () => {
    const host = testHostFile(signer, signer.sign(unsignedBundle()), {
      host_status: "paused",
    });
    expect(decideLocally(host, EDIT, NOW).evaluation?.reason_code).toBe(
      "host_paused",
    );
  });

  it("does not take a status from a bundle that did not verify", () => {
    const signed = signer.sign(unsignedBundle({ mode: "observe" }));
    const host = testHostFile(
      signer,
      { ...signed, host_status: "revoked" },
      { host_status: "active" },
    );
    expect(
      decideLocally(host, parse("UserPromptSubmit"), NOW).response,
    ).toEqual({});
  });
});

describe("rule matching context on the offline path", () => {
  it("reads home-relative rules against home", () => {
    const host = testHostFile(
      signer,
      signer.sign(
        unsignedBundle({
          permissions: { allow: ["Read"], deny: ["Read(~/.ssh/**)"], ask: [] },
        }),
      ),
    );
    const read = parse("PreToolUse", {
      tool_name: "Read",
      tool_input: { file_path: "/home/dev/.ssh/id_rsa" },
      cwd: "/repo",
    });
    expect(
      decideLocally(host, read, NOW, { home: "/home/dev" }).evaluation,
    ).toMatchObject({ decision: "deny", rule: "Read(~/.ssh/**)" });
  });

  it("honours Stella's read-only claim for a tool it cannot classify", () => {
    // A deny generation newer than the bundle makes it stale, and a stale
    // bundle with no daemon lets only read-only tools through.
    const host = testHostFile(signer, signer.sign(unsignedBundle()), {
      deny_generation: { org: 9, workspace: 1 },
    });
    const call = (read_only?: boolean) =>
      parse("PreToolUse", {
        tool_name: "lookup_docs",
        tool_input: { query: "x" },
        ...(read_only !== undefined ? { tool_read_only: read_only } : {}),
      });
    expect(decideLocally(host, call(), NOW).evaluation).toMatchObject({
      decision: "deny",
      reason_code: "bundle_stale",
    });
    expect(decideLocally(host, call(false), NOW).evaluation?.reason_code).toBe(
      "bundle_stale",
    );
    expect(decideLocally(host, call(true), NOW).evaluation).toMatchObject({
      read_only: true,
      reason_code: "no_rule",
    });
  });
});

describe("a host.json this binary cannot fully parse", () => {
  /** A newer daemon's cache: a bundle field this binary's strict schema rejects. */
  function newerHostFile() {
    const paths = scratchPaths();
    const host = testHostFile(signer, signer.sign(unsignedBundle()));
    writeHostFile(paths.hostFile, host);
    const document = JSON.parse(readFileSync(paths.hostFile, "utf8")) as {
      bundle: Record<string, unknown>;
    };
    document.bundle["field_from_the_future"] = true;
    writeFileSync(paths.hostFile, JSON.stringify(document));
    return { paths, host };
  }

  it("still forwards the event to the daemon on its routing fields", async () => {
    const { paths, host } = newerHostFile();
    const seen: Array<Parameters<typeof postUnix>[0]> = [];
    const result = await runTachoHook({
      paths,
      env: {},
      stdin: PRE("Bash", { command: "git push" }),
      platform: "linux",
      post: async (options) => {
        seen.push(options);
        return {
          status: 200,
          body: '{"hookSpecificOutput":{"permissionDecision":"allow"}}',
        };
      },
    });
    expect(result.path).toBe("daemon");
    expect(JSON.parse(result.stdout)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });
    expect(result.stderr).toContain("cannot read enrollment");
    expect(seen[0]).toMatchObject({
      socketPath: paths.socket,
      path: `/hook/${host.host_enrollment_id}`,
      headers: { Authorization: `Bearer ${host.local_token}` },
    });
    // Windows routes by the port in the same file.
    const tcp: Array<Parameters<typeof postUnix>[0]> = [];
    await runTachoHook({
      paths,
      env: {},
      stdin: PRE("Bash", { command: "ls" }),
      platform: "win32",
      post: async (options) => {
        tcp.push(options);
        return { status: 200, body: "{}" };
      },
    });
    expect(tcp[0]?.loopbackPort).toBe(host.port);
  });

  it("refuses tool calls on every harness when the daemon is down too", async () => {
    const { paths } = newerHostFile();
    const pre = await runTachoHook({
      paths,
      env: {},
      stdin: PRE("Read", { file_path: "/repo/a" }),
      platform: "linux",
      post: down,
    });
    expect(pre.path).toBe("unenrolled");
    expect(JSON.parse(pre.stdout)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining("enrollment"),
      },
    });
    expect(pre.stderr).toContain("field_from_the_future");
    const request = await runTachoHook({
      paths,
      env: {},
      stdin: JSON.stringify({
        session_id: "s",
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      }),
      platform: "linux",
      post: down,
    });
    expect(JSON.parse(request.stdout)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny" },
      },
    });
    const codex = await runTachoHook({
      paths,
      env: {},
      stdin: PRE("Bash", { command: "ls" }),
      harness: "codex",
      platform: "linux",
      post: down,
    });
    expect(JSON.parse(codex.stdout)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    // An event that carries no tool keeps its old answer.
    const stop = await runTachoHook({
      paths,
      env: {},
      stdin: JSON.stringify({ session_id: "s", hook_event_name: "Stop" }),
      platform: "linux",
      post: down,
    });
    expect(stop.stdout).toBe("{}\n");
  });
});

describe("a hook entry from an earlier enrollment", () => {
  it("reads --enrollment off argv, and only a well-formed id", () => {
    expect(enrollmentFromArgv(["hook", "--enrollment", TEST_ENROLLMENT])).toBe(
      TEST_ENROLLMENT,
    );
    expect(enrollmentFromArgv(["--enrollment", "nope"])).toBeUndefined();
    expect(enrollmentFromArgv(["--enrollment"])).toBeUndefined();
    expect(enrollmentFromArgv(["--harness", "codex"])).toBeUndefined();
  });

  it("answers no opinion and posts nothing when the ids differ", async () => {
    const paths = scratchPaths();
    writeHostFile(
      paths.hostFile,
      testHostFile(signer, signer.sign(unsignedBundle())),
    );
    let posts = 0;
    const post = async () => {
      posts += 1;
      return { status: 200, body: "{}" };
    };
    const stale = await runTachoHook({
      paths,
      env: {},
      stdin: PRE("Bash", { command: "git push" }),
      platform: "linux",
      enrollment: OTHER_ENROLLMENT,
      post,
    });
    expect(stale).toMatchObject({ stdout: "{}\n", path: "invalid" });
    expect(stale.stderr).toContain(OTHER_ENROLLMENT);
    expect(posts).toBe(0);
    // Cursor's no-opinion answer is its explicit allow.
    const cursor = await runTachoHook({
      paths,
      env: {},
      stdin: JSON.stringify({
        conversation_id: "11111111-1111-4111-8111-1111111111aa",
        hook_event_name: "preToolUse",
        tool_name: "Shell",
        tool_input: { command: "ls" },
        cwd: "/repo",
      }),
      harness: "cursor",
      platform: "linux",
      enrollment: OTHER_ENROLLMENT,
      post,
    });
    expect(JSON.parse(cursor.stdout)).toEqual({ permission: "allow" });
    expect(posts).toBe(0);
    // The current enrollment's own entry still posts.
    const current = await runTachoHook({
      paths,
      env: {},
      stdin: PRE("Bash", { command: "git push" }),
      platform: "linux",
      enrollment: TEST_ENROLLMENT,
      post,
    });
    expect(current.path).toBe("daemon");
    expect(posts).toBe(1);
  });

  it("compares against the routing id when host.json does not fully parse", async () => {
    const paths = scratchPaths();
    writeHostFile(
      paths.hostFile,
      testHostFile(signer, signer.sign(unsignedBundle())),
    );
    const document = JSON.parse(readFileSync(paths.hostFile, "utf8")) as {
      bundle: Record<string, unknown>;
    };
    document.bundle["field_from_the_future"] = true;
    writeFileSync(paths.hostFile, JSON.stringify(document));
    const stale = await runTachoHook({
      paths,
      env: {},
      stdin: PRE("Bash", { command: "git push" }),
      platform: "linux",
      enrollment: OTHER_ENROLLMENT,
      post: async () => {
        throw new Error("must not post");
      },
    });
    expect(stale).toMatchObject({ stdout: "{}\n", path: "invalid" });
  });
});
