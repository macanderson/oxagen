/**
 * A hook payload with a `null` member or a string `tool_input` is recorded,
 * with a note of what was read differently (H-07, audit #3944). The strict
 * schema refused the whole payload over one such member: `tacho-hook`
 * answered `{}` with nothing recorded, and the daemon answered an http hook
 * with a 500 and a log line.
 */
import { existsSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { writeHostFile } from "../host/host-file";
import {
  bundleSigner,
  scratchPaths,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import { type postUnix, runTachoHook } from "./hook-client";
import {
  hookInputSchema,
  normalizeHook,
  PAYLOAD_REPAIRS_ATTR,
  payloadRepairs,
} from "./hooks";

const SESSION = "00000000-0000-4000-8000-000000000001";

const NULL_MEMBERS = {
  session_id: SESSION,
  hook_event_name: "PostToolUse",
  cwd: null,
  tool_name: "Bash",
  tool_input: "ls -la",
  tool_use_id: null,
  tool_response: { stdout: "ok" },
};

describe("the hook schema", () => {
  it("reads a null member as absent and keeps a string tool_input under value", () => {
    const parsed = hookInputSchema.safeParse(NULL_MEMBERS);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.cwd).toBeUndefined();
    expect(parsed.data?.tool_use_id).toBeUndefined();
    expect(parsed.data?.tool_input).toEqual({ value: "ls -la" });
  });

  it("reads a number or a boolean as text and leaves other values out", () => {
    const parsed = hookInputSchema.parse({
      session_id: SESSION,
      hook_event_name: "PreToolUse",
      tool_use_id: 17,
      agent_type: true,
      cwd: { path: "/repo" },
      tool_input: ["a", "b"],
      duration_ms: "12",
    });
    expect(parsed.tool_use_id).toBe("17");
    expect(parsed.agent_type).toBe("true");
    expect(parsed.cwd).toBeUndefined();
    expect(parsed.tool_input).toEqual({ value: ["a", "b"] });
    expect(parsed.duration_ms).toBeUndefined();
  });

  it("still refuses a payload with no session id or no event name", () => {
    expect(hookInputSchema.safeParse({ hook_event_name: "Stop" }).success).toBe(
      false,
    );
    expect(hookInputSchema.safeParse({ session_id: SESSION }).success).toBe(
      false,
    );
  });

  it("names every member it read differently, and nothing for a clean payload", () => {
    expect(payloadRepairs(NULL_MEMBERS)).toBe(
      'cwd: null, read as absent; tool_use_id: null, read as absent; tool_input: a string, kept as {"value": ...}',
    );
    expect(payloadRepairs({ cwd: { path: "/repo" }, duration_ms: "12" })).toBe(
      'cwd: an object, left out: {"path":"/repo"}; duration_ms: a string, left out: "12"',
    );
    // Codex sends a null transcript path whenever there is none.
    expect(
      payloadRepairs({
        session_id: SESSION,
        hook_event_name: "Stop",
        transcript_path: null,
        cwd: "/repo",
      }),
    ).toBeUndefined();
  });
});

describe("normalizeHook", () => {
  it("records a payload with null members and notes what it read differently", () => {
    const drafts = normalizeHook(
      NULL_MEMBERS,
      {},
      { sessionUuid: "11111111-1111-4111-8111-111111111111" },
    );
    expect(drafts.length).toBeGreaterThan(0);
    for (const draft of drafts)
      expect(draft.attrs[PAYLOAD_REPAIRS_ATTR]).toContain(
        "tool_use_id: null, read as absent",
      );
    expect(drafts[0]?.body).toMatchObject({ tool_name: "Bash" });
  });

  it("adds no note to a payload that needed no repair", () => {
    const [draft] = normalizeHook(
      {
        session_id: SESSION,
        hook_event_name: "Stop",
        cwd: "/repo",
        transcript_path: null,
      },
      {},
      { sessionUuid: "11111111-1111-4111-8111-111111111111" },
    );
    expect(draft?.attrs[PAYLOAD_REPAIRS_ATTR]).toBeUndefined();
  });
});

describe("runTachoHook", () => {
  function enrolledPaths() {
    const paths = scratchPaths();
    const signer = bundleSigner();
    writeHostFile(
      paths.hostFile,
      testHostFile(signer, signer.sign(unsignedBundle())),
    );
    return paths;
  }

  it("forwards a payload with null members to the daemon instead of quarantining it", async () => {
    const paths = enrolledPaths();
    const seen: Array<Parameters<typeof postUnix>[0]> = [];
    const result = await runTachoHook({
      paths,
      env: {},
      stdin: JSON.stringify(NULL_MEMBERS),
      platform: "linux",
      post: async (options) => {
        seen.push(options);
        return { status: 200, body: "{}" };
      },
    });
    expect(result.path).toBe("daemon");
    expect(seen).toHaveLength(1);
    expect(
      (JSON.parse(seen[0]?.body ?? "{}") as { payload: unknown }).payload,
    ).toEqual(NULL_MEMBERS);
    expect(
      existsSync(paths.quarantine) ? readdirSync(paths.quarantine) : [],
    ).toEqual([]);
  });

  it("spools a payload with null members when the daemon is down, so it replays", async () => {
    const paths = enrolledPaths();
    const result = await runTachoHook({
      paths,
      env: {},
      stdin: JSON.stringify({
        ...NULL_MEMBERS,
        hook_event_name: "PreToolUse",
      }),
      harness: "codex",
      platform: "linux",
      post: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(result.path).toBe("local");
    expect(readdirSync(paths.spool)).toHaveLength(1);
  });
});
