import { describe, expect, it } from "vitest";
import {
  ago,
  defaultRegistration,
  deregisterArgs,
  missionControlUrl,
  wizardStep,
  enrollArgs,
  loginArgs,
  needsWorkspacePick,
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
  it("signs in with the browser flow forced, since the sidecar has no TTY", () => {
    // A bare `login` in a piped child refuses without a token and, with a
    // session saved, prints it and exits 0; only --browser reaches PKCE.
    expect(loginArgs()).toEqual(["login", "--browser"]);
    expect(loginArgs({ signup: true })).toEqual([
      "login",
      "--browser",
      "--signup",
    ]);
  });

  it("enrolls with the picked org, workspace, and harness list", () => {
    expect(enrollArgs(NONE)).toEqual(["enroll", "--harness", "claude-code"]);
    // An org without a workspace never reaches tacho: it would fill the
    // workspace from config.json, the previous org's.
    expect(() =>
      enrollArgs({ org: "other", workspace: null, harnesses: null }),
    ).toThrow(/pick a workspace in other/);
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
    expect(reassignArgs(HOST, { ...NONE, workspace: "edge" })).toEqual({
      sidecar: "tacho",
      args: ["reassign", "--workspace", "edge"],
    });
    expect(
      reassignArgs(HOST, { org: "other", workspace: "main", harnesses: null }),
    ).toEqual({
      sidecar: "tacho",
      args: ["reassign", "--org", "other", "--workspace", "main"],
    });
    // Harness-only change: no --workspace, so tacho re-enrolls in place.
    expect(
      reassignArgs(HOST, { ...NONE, harnesses: ["claude-code", "codex"] }),
    ).toEqual({
      sidecar: "tacho",
      args: ["reassign", "--harness", "claude-code,codex"],
    });
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

  it("treats an org change as incomplete until a workspace in it is picked", () => {
    // Resetting the workspace on an org change leaves the host's slug as the
    // only candidate, and it names a workspace of the old org: no argv until
    // the operator picks one in the new org.
    const orgOnly = { org: "other", workspace: null, harnesses: null };
    expect(needsWorkspacePick("acme", orgOnly)).toBe(true);
    expect(needsWorkspacePick("acme", { org: "acme", workspace: null })).toBe(
      false,
    );
    expect(needsWorkspacePick("acme", { org: "other", workspace: "x" })).toBe(
      false,
    );
    expect(needsWorkspacePick(null, { org: "other", workspace: null })).toBe(
      true,
    );
    expect(pendingChange(HOST, orgOnly)).toEqual({
      target: false,
      harness: false,
    });
    expect(() => reassignArgs(HOST, orgOnly)).toThrow(
      /pick a workspace in other/,
    );
    expect(() => reassignArgs(HOST, orgOnly, true)).toThrow(
      /pick a workspace in other/,
    );
    // Picking the host's own org back is not an org change.
    expect(pendingChange(HOST, { ...orgOnly, org: "acme" })).toEqual({
      target: false,
      harness: false,
    });
  });

  it("reassigns through the oxagen sidecar with --default when the CLI default should follow", () => {
    // config.json is the CLI's file, so making the new pair the CLI default
    // means running the same reassign as `oxagen tacho reassign … --default`.
    expect(
      reassignArgs(
        HOST,
        { org: "other", workspace: "main", harnesses: null },
        true,
      ),
    ).toEqual({
      sidecar: "oxagen",
      args: [
        "tacho",
        "reassign",
        "--org",
        "other",
        "--workspace",
        "main",
        "--default",
      ],
    });
    // A harness-only apply still goes through oxagen when asked: the pair
    // written is the host's current one, so config.json lands in step.
    expect(reassignArgs(HOST, { ...NONE, harnesses: ["codex"] }, true)).toEqual(
      {
        sidecar: "oxagen",
        args: ["tacho", "reassign", "--harness", "codex", "--default"],
      },
    );
    // Explicit false is the plain tacho form.
    expect(reassignArgs(HOST, { ...NONE, workspace: "edge" }, false)).toEqual({
      sidecar: "tacho",
      args: ["reassign", "--workspace", "edge"],
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

describe("wizard and de-register", () => {
  it("derives the step from the machine state so a relaunch resumes", () => {
    const base = {
      loggedIn: false,
      targetChosen: false,
      enrolled: false,
      outcomeSeen: false,
    };
    expect(wizardStep(base)).toBe(1);
    expect(wizardStep({ ...base, loggedIn: true })).toBe(2);
    expect(wizardStep({ ...base, loggedIn: true, targetChosen: true })).toBe(3);
    expect(wizardStep({ ...base, loggedIn: true, enrolled: true })).toBe(4);
    expect(
      wizardStep({
        ...base,
        loggedIn: true,
        enrolled: true,
        outcomeSeen: true,
      }),
    ).toBe(5);
    // Signed out after enrolling: back to step 1, never a half state.
    expect(wizardStep({ ...base, enrolled: true, outcomeSeen: true })).toBe(1);
  });

  it("ticks every detected agent by default and none of the absent ones", () => {
    expect(
      defaultRegistration([
        { harness: "claude-code", installed: true },
        { harness: "codex", installed: false },
      ]),
    ).toEqual(["claude-code"]);
    expect(
      defaultRegistration([
        { harness: "claude-code", installed: true },
        { harness: "codex", installed: true },
      ]),
    ).toEqual(["claude-code", "codex"]);
    expect(defaultRegistration([])).toEqual([]);
  });

  it("de-registers one agent by re-enrolling with the rest, or unenrolls the last", () => {
    expect(deregisterArgs(["claude-code", "codex"], "codex")).toEqual({
      sidecar: "tacho",
      args: ["reassign", "--harness", "claude-code"],
    });
    expect(deregisterArgs(["claude-code"], "claude-code")).toEqual({
      sidecar: "tacho",
      args: ["unenroll"],
    });
  });

  it("links Mission Control for the workspace the host reports to", () => {
    expect(missionControlUrl("https://app.oxagen.sh/", "acme", "core")).toBe(
      "https://app.oxagen.sh/acme/core/runs",
    );
    expect(missionControlUrl("https://app.oxagen.sh", "a b", "c/d")).toBe(
      "https://app.oxagen.sh/a%20b/c%2Fd/runs",
    );
  });
});
