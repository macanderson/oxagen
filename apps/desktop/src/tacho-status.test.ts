import { describe, expect, it } from "vitest";
import { parseTachoStatus } from "./tacho-status";

/** What `tacho status --json` prints for an enrolled host with both wrappers. */
const ENROLLED = {
  enrolled: true,
  host: {
    host_enrollment_id: "tch_x",
    port: 47001,
    harnesses: ["claude-code", "codex"],
  },
  bundle: { version: 3, etag: "e", fetched_at: "2026-09-14T00:00:00.000Z" },
  service: {
    kind: "launchd",
    installed: true,
    running: true,
    detail: "pid 12",
  },
  daemon: { uptime_s: 5 },
  hooks: {
    complete: false,
    present: ["PreToolUse", "SessionStart"],
    missing: ["Stop"],
  },
  codexHooks: { complete: true, present: ["PreToolUse"], missing: [] },
  stellaHooks: { complete: false, present: [], missing: ["PreToolUse"] },
  wal: {
    sessions: 2,
    unshipped: 7,
    oldest_unshipped_at: "2026-09-13T00:00:00.000Z",
  },
};

describe("parseTachoStatus", () => {
  it("keeps the members the panels show and drops the rest", () => {
    expect(parseTachoStatus(JSON.stringify(ENROLLED, null, 2))).toEqual({
      enrolled: true,
      hooks: {
        complete: false,
        present: ["PreToolUse", "SessionStart"],
        missing: ["Stop"],
      },
      codexHooks: { complete: true, present: ["PreToolUse"], missing: [] },
      stellaHooks: { complete: false, present: [], missing: ["PreToolUse"] },
      service: { kind: "launchd", installed: true, running: true },
      wal: { sessions: 2, unshipped: 7 },
    });
    // The CLI appends a newline; an unenrolled machine has nothing else.
    expect(parseTachoStatus('{\n  "enrolled": false\n}\n')).toEqual({
      enrolled: false,
    });
  });

  it("answers null for anything that is not a status document", () => {
    expect(parseTachoStatus("")).toBeNull();
    expect(parseTachoStatus("tacho: command not found\n")).toBeNull();
    expect(parseTachoStatus("null")).toBeNull();
    expect(parseTachoStatus("[]")).toBeNull();
    expect(parseTachoStatus('"enrolled"')).toBeNull();
    expect(parseTachoStatus("{}")).toBeNull();
    expect(parseTachoStatus('{"enrolled":"yes"}')).toBeNull();
    // A document cut short mid-stream is not "not enrolled".
    expect(parseTachoStatus('{"enrolled": true, "hooks": {')).toBeNull();
  });

  it("ignores malformed optional members instead of failing the read", () => {
    expect(
      parseTachoStatus(
        JSON.stringify({
          enrolled: true,
          hooks: { complete: "no" },
          codexHooks: {
            complete: true,
            present: "PreToolUse",
            missing: [1, "Stop"],
          },
          service: { kind: "systemd", installed: true },
          wal: { sessions: "2", unshipped: 0 },
        }),
      ),
    ).toEqual({
      enrolled: true,
      codexHooks: { complete: true, present: [], missing: ["Stop"] },
    });
  });
});
