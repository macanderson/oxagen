import { describe, expect, it } from "vitest";
import {
  contextFactsFromEnv,
  harnessVersionFromExecPath,
  hostFactsFromEnv,
  snapshotEnv,
} from "./context";
import { tachoEnv } from "../host/settings-writer";

describe("host and environment facts", () => {
  it("snapshots harness-relevant env and never anything secret-shaped", () => {
    const snapshot = snapshotEnv({
      CLAUDE_CODE_ENTRYPOINT: "cli",
      ANTHROPIC_API_KEY: "sk-x",
      CLAUDE_CODE_MESSAGING_TOKEN: "t",
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer x",
      CLAUDE_CODE_OAUTH_AUTHORIZATION: "a",
      MY_PASSWORD: "p",
      TERM_PROGRAM: "ghostty",
      HOME: "/home/dev",
      CLAUDE_LONG: "y".repeat(2000),
      CLAUDE_UNDEFINED: undefined,
    });
    expect(Object.keys(snapshot).sort()).toEqual([
      "CLAUDE_CODE_ENTRYPOINT",
      "CLAUDE_LONG",
      "TERM_PROGRAM",
    ]);
    expect(snapshot["CLAUDE_LONG"]?.length).toBe(1027);
    expect(snapshotEnv({ CLAUDE_SPECIAL: "x" }, /SPECIAL/)).toEqual({});
  });

  it("keeps git identity variables out, because the reconciliation rule needs none", () => {
    // ADR-188, amended for #4320: a commit no remote-tracking ref reaches
    // counts as the session's whatever its email, so no email rides a hook.
    expect(
      snapshotEnv({
        GIT_COMMITTER_EMAIL: "agent@example.com",
        GIT_AUTHOR_EMAIL: "agent@example.com",
        GIT_COMMITTER_NAME: "agent",
        EMAIL: "agent@example.com",
        CLAUDE_CODE_ENTRYPOINT: "cli",
      }),
    ).toEqual({ CLAUDE_CODE_ENTRYPOINT: "cli" });
  });

  it("never ships the daemon's own bearer header, the exact value the installer writes", () => {
    const localToken = "tlt_0123456789abcdef0123456789abcdef";
    const snapshot = snapshotEnv(
      tachoEnv({
        enrollmentId: "enr_1",
        hookCommand: "tacho",
        port: 4242,
        localToken,
      }),
    );
    expect(snapshot["OTEL_EXPORTER_OTLP_HEADERS"]).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toContain(localToken);
    expect(snapshot["OTEL_EXPORTER_OTLP_ENDPOINT"]).toBe(
      "http://127.0.0.1:4242",
    );
  });

  it("derives host and context facts from the hook environment", () => {
    expect(
      hostFactsFromEnv({
        CLAUDE_PID: "12",
        CLAUDE_CODE_EXECPATH: "/v/versions/2.1.263",
        CLAUDE_CODE_CHILD_SESSION: "1",
        CLAUDE_CODE_BRIDGE_SESSION_ID: "b",
      }),
    ).toEqual({
      claude_pid: 12,
      claude_execpath: "/v/versions/2.1.263",
      is_child_session: true,
      bridge_session_id: "b",
    });
    expect(hostFactsFromEnv({ CLAUDE_PID: "abc" })).toEqual({});
    expect(
      contextFactsFromEnv({
        CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
        CLAUDE_EFFORT: "max",
        CLAUDE_PROJECT_DIR: "/p",
        TERM_PROGRAM: "vscode",
      }),
    ).toEqual({
      entrypoint: "sdk-ts",
      effort: "max",
      project_dir: "/p",
      terminal_type: "vscode",
    });
    expect(
      harnessVersionFromExecPath(
        "/home/dev/.local/share/claude/versions/2.1.263",
      ),
    ).toBe("2.1.263");
    expect(harnessVersionFromExecPath("/usr/local/bin/claude")).toBeUndefined();
    expect(harnessVersionFromExecPath(undefined)).toBeUndefined();
  });
});
