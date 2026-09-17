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

/**
 * The connected-app presence (ADR-078). Declaring the field was not enough:
 * until it was parsed, `connectedRow()` always saw `presence === undefined`,
 * so a deleted or stale MCP entry rendered as idle instead of degraded and
 * the servers Oxagen cannot see were never disclosed.
 */
describe("connected-app presence", () => {
  const doc = (claudeDesktop: unknown) =>
    JSON.stringify({ enrolled: true, claudeDesktop });

  it("parses a present entry with the servers it cannot see", () => {
    const status = parseTachoStatus(
      doc({
        present: true,
        foreignEnrollment: false,
        otherServers: 2,
        otherServerNames: ["filesystem", "slack"],
      }),
    );
    expect(status?.claudeDesktop).toEqual({
      present: true,
      foreignEnrollment: false,
      otherServers: 2,
      otherServerNames: ["filesystem", "slack"],
    });
  });

  it("parses an absent entry, which is what makes the row degraded", () => {
    const status = parseTachoStatus(doc({ present: false }));
    expect(status?.claudeDesktop?.present).toBe(false);
    expect(status?.claudeDesktop?.foreignEnrollment).toBe(false);
  });

  it("carries a stale entry from an earlier enrollment", () => {
    const status = parseTachoStatus(
      doc({ present: false, foreignEnrollment: true }),
    );
    expect(status?.claudeDesktop?.foreignEnrollment).toBe(true);
  });

  it("trusts the names over a count that disagrees with them", () => {
    // The count is what a surface prints; a count that does not match the
    // list it came from is a number nobody can check.
    const status = parseTachoStatus(
      doc({ present: true, otherServerNames: ["a", "b", "c"] }),
    );
    expect(status?.claudeDesktop?.otherServers).toBe(3);
  });

  it("drops junk rather than inventing a shape", () => {
    for (const junk of [undefined, null, 7, "x", {}, { present: "yes" }]) {
      expect(parseTachoStatus(doc(junk))?.claudeDesktop).toBeUndefined();
    }
  });

  it("keeps non-string names out of the disclosure", () => {
    const status = parseTachoStatus(
      doc({ present: true, otherServerNames: ["ok", 3, null] }),
    );
    expect(status?.claudeDesktop?.otherServerNames).toEqual(["ok"]);
  });
});
