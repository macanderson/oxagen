import { describe, expect, it } from "vitest";
import {
  ago,
  enrollArgs,
  pendingChange,
  primaryAction,
  reassignArgs,
  toggleHarness,
  unenrollArgs,
} from "./commands";

const HOST = {
  org_slug: "acme",
  workspace_slug: "core",
  harnesses: ["claude-code"],
};
const NONE = { org: null, workspace: null, harnesses: null };

describe("sidecar argv", () => {
  it("enrolls with the picked org, workspace, and harness list", () => {
    expect(enrollArgs(NONE)).toEqual(["enroll", "--harness", "claude-code"]);
    expect(
      enrollArgs({
        org: "acme",
        workspace: "edge",
        harnesses: ["claude-code", "codex"],
      }),
    ).toEqual([
      "enroll",
      "--org",
      "acme",
      "--workspace",
      "edge",
      "--harness",
      "claude-code,codex",
    ]);
  });

  it("reassigns with only what differs from the host", () => {
    expect(pendingChange(HOST, NONE)).toEqual({
      target: false,
      harness: false,
    });
    expect(reassignArgs(HOST, { ...NONE, workspace: "edge" })).toEqual([
      "reassign",
      "--workspace",
      "edge",
    ]);
    expect(
      reassignArgs(HOST, { org: "other", workspace: "main", harnesses: null }),
    ).toEqual(["reassign", "--org", "other", "--workspace", "main"]);
    // Harness-only change: no --workspace, so tacho re-enrolls in place.
    expect(
      reassignArgs(HOST, { ...NONE, harnesses: ["claude-code", "codex"] }),
    ).toEqual(["reassign", "--harness", "claude-code,codex"]);
    // Picking the current values is not a change.
    expect(
      pendingChange(HOST, {
        org: "acme",
        workspace: "core",
        harnesses: ["claude-code"],
      }),
    ).toEqual({ target: false, harness: false });
    // Not enrolled: nothing is pending.
    expect(pendingChange(null, { ...NONE, workspace: "edge" })).toEqual({
      target: false,
      harness: false,
    });
  });

  it("unenroll carries --purge only on request", () => {
    expect(unenrollArgs(false)).toEqual(["unenroll"]);
    expect(unenrollArgs(true)).toEqual(["unenroll", "--purge"]);
  });

  it("never empties the harness list", () => {
    expect(toggleHarness(["claude-code"], "codex")).toEqual([
      "claude-code",
      "codex",
    ]);
    expect(toggleHarness(["claude-code", "codex"], "claude-code")).toEqual([
      "codex",
    ]);
    expect(toggleHarness(["codex"], "codex")).toEqual(["codex"]);
  });
});

describe("panel helpers", () => {
  it("formats relative time", () => {
    const now = Date.parse("2026-09-13T12:00:00Z");
    expect(ago(null, now)).toBe("never");
    expect(ago("2026-09-13T11:59:30Z", now)).toBe("30s ago");
    expect(ago("2026-09-13T11:30:00Z", now)).toBe("30m ago");
    expect(ago("2026-09-13T09:00:00Z", now)).toBe("3h ago");
    expect(ago("2026-09-10T12:00:00Z", now)).toBe("3d ago");
    expect(ago("not a date", now)).toBe("not a date");
  });

  it("puts the one gold action on the next step, never on a destructive one", () => {
    const none = { target: false, harness: false };
    expect(primaryAction(false, false, none)).toBe("signin");
    expect(primaryAction(true, false, none)).toBe("enroll");
    expect(primaryAction(true, true, none)).toBeNull();
    expect(primaryAction(true, true, { target: true, harness: false })).toBe(
      "apply",
    );
    expect(primaryAction(true, true, { target: false, harness: true })).toBe(
      "apply",
    );
  });
});
