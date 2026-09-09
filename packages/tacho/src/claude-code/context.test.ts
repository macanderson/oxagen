import { describe, expect, it } from "vitest";
import {
  contextFactsFromEnv,
  harnessVersionFromExecPath,
  hostFactsFromEnv,
  snapshotEnv,
} from "./context";

describe("host and environment facts", () => {
  it("snapshots harness-relevant env and never anything secret-shaped", () => {
    const snapshot = snapshotEnv({
      CLAUDE_CODE_ENTRYPOINT: "cli",
      ANTHROPIC_API_KEY: "sk-x",
      CLAUDE_CODE_MESSAGING_TOKEN: "t",
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer x",
      MY_PASSWORD: "p",
      TERM_PROGRAM: "ghostty",
      HOME: "/home/dev",
      CLAUDE_LONG: "y".repeat(2000),
      CLAUDE_UNDEFINED: undefined,
    });
    expect(Object.keys(snapshot).sort()).toEqual([
      "CLAUDE_CODE_ENTRYPOINT",
      "CLAUDE_LONG",
      "OTEL_EXPORTER_OTLP_HEADERS",
      "TERM_PROGRAM",
    ]);
    expect(snapshot["CLAUDE_LONG"]?.length).toBe(1027);
    expect(snapshotEnv({ CLAUDE_SPECIAL: "x" }, /SPECIAL/)).toEqual({});
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
