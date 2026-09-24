import { describe, expect, it } from "vitest";
import {
  ALL_HOOK_EVENTS,
  hookUrl,
  mergeTachoSettings,
  RETIRED_HOOK_EVENTS,
  stripTachoSettings,
  tachoHookEntries,
  tachoHookPresence,
} from "./settings-writer";
import { TEST_ENROLLMENT } from "./test-support";

const CONFIG = {
  enrollmentId: TEST_ENROLLMENT,
  hookCommand: "/usr/local/bin/node /opt/tacho/tacho-hook.mjs",
  port: 47001,
  localToken: "tok",
};

const OTHER_ENROLLMENT = "tch_zyxwvutsrqpnmkjhgfedcb";

function tachoHttpGroup(enrollmentId: string) {
  return {
    hooks: [
      {
        type: "http" as const,
        url: hookUrl(47001, enrollmentId),
        headers: { Authorization: "Bearer $TACHO_LOCAL_TOKEN" },
        allowedEnvVars: ["TACHO_LOCAL_TOKEN"],
        timeout: 5,
      },
    ],
  };
}

const USER_WORKTREE_HOOK = {
  hooks: [{ type: "command" as const, command: "./scripts/make-worktree.sh" }],
};

/** A settings file an older enroll wrote, with WorktreeCreate and WorktreeRemove registered. */
function olderEnroll() {
  const current = mergeTachoSettings({}, CONFIG).settings;
  return {
    ...current,
    hooks: {
      ...current.hooks,
      WorktreeCreate: [
        USER_WORKTREE_HOOK,
        tachoHttpGroup(TEST_ENROLLMENT),
        tachoHttpGroup(OTHER_ENROLLMENT),
      ],
      WorktreeRemove: [tachoHttpGroup(TEST_ENROLLMENT)],
    },
  };
}

describe("settings writer and worktree hooks", () => {
  it("registers neither WorktreeCreate nor WorktreeRemove", () => {
    const events = Object.keys(tachoHookEntries(CONFIG));
    for (const event of RETIRED_HOOK_EVENTS) {
      expect(events).not.toContain(event);
      expect(ALL_HOOK_EVENTS as readonly string[]).not.toContain(event);
    }
    const settings = mergeTachoSettings({}, CONFIG).settings;
    expect(settings.hooks?.["WorktreeCreate"]).toBeUndefined();
    expect(settings.hooks?.["WorktreeRemove"]).toBeUndefined();
  });

  it("takes out the worktree hooks an older enroll wrote and keeps the user's own", () => {
    const merged = mergeTachoSettings(olderEnroll(), CONFIG);
    expect(merged.changed).toBe(true);
    expect(merged.settings.hooks?.["WorktreeCreate"]).toEqual([
      USER_WORKTREE_HOOK,
    ]);
    expect(merged.settings.hooks?.["WorktreeRemove"]).toBeUndefined();
    expect(tachoHookPresence(merged.settings, TEST_ENROLLMENT).complete).toBe(
      true,
    );
    // Once they are out, enrolling again changes nothing.
    expect(mergeTachoSettings(merged.settings, CONFIG).changed).toBe(false);
  });

  it("leaves a file with no retired entries untouched", () => {
    const current = mergeTachoSettings({}, CONFIG).settings;
    const withUsers = {
      ...current,
      hooks: { ...current.hooks, WorktreeCreate: [USER_WORKTREE_HOOK] },
    };
    const merged = mergeTachoSettings(withUsers, CONFIG);
    expect(merged.changed).toBe(false);
    expect(merged.settings.hooks?.["WorktreeCreate"]).toEqual([
      USER_WORKTREE_HOOK,
    ]);
  });

  it("strips the worktree hooks an older enroll wrote", () => {
    const stripped = stripTachoSettings(olderEnroll(), TEST_ENROLLMENT);
    expect(stripped.settings.hooks?.["WorktreeCreate"]).toEqual([
      USER_WORKTREE_HOOK,
      tachoHttpGroup(OTHER_ENROLLMENT),
    ]);
    expect(stripped.settings.hooks?.["WorktreeRemove"]).toBeUndefined();
    const all = stripTachoSettings(olderEnroll());
    expect(all.settings.hooks).toEqual({
      WorktreeCreate: [USER_WORKTREE_HOOK],
    });
  });
});
