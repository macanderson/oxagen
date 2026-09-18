/**
 * The Cursor hooks writer on its own: every event is a command entry tagged
 * `--harness cursor`, `version: 1` is set when missing, foreign entries
 * survive a merge and a strip, and presence reads what an enrollment
 * actually installed.
 */
import { describe, expect, it } from "vitest";
import {
  CURSOR_COMMAND_HOOK_TIMEOUTS_S,
  CURSOR_HOOK_EVENTS,
  CURSOR_TELEMETRY_EVENTS,
  cursorHookEntries,
  cursorHookPresence,
  cursorHooksShapeProblem,
  mergeCursorHooks,
  stripCursorHooks,
} from "./cursor-writer";
import { TEST_ENROLLMENT } from "./test-support";

const CONFIG = {
  enrollmentId: TEST_ENROLLMENT,
  hookCommand: "/usr/local/bin/tacho hook",
  port: 47001,
  localToken: "tok",
};

const OTHER = "tch_zyxwvutsrqpnmkjhgfedcb";

const FOREIGN = {
  version: 1,
  hooks: {
    preToolUse: [{ command: "./guard.sh", matcher: "Shell" }],
    afterFileEdit: [{ command: "./format.sh" }],
  },
  extra: { kept: true },
};

describe("cursor writer", () => {
  it("installs a command entry tagged with the harness for every Cursor event", () => {
    const entries = cursorHookEntries(CONFIG);
    expect(Object.keys(entries).sort()).toEqual([...CURSOR_HOOK_EVENTS].sort());
    for (const event of CURSOR_HOOK_EVENTS) {
      expect(entries[event]).toHaveLength(1);
      expect(entries[event][0]).toMatchObject({
        type: "command",
        command: `${CONFIG.hookCommand} --enrollment ${TEST_ENROLLMENT} --harness cursor`,
      });
    }
    for (const [event, timeout] of Object.entries(
      CURSOR_COMMAND_HOOK_TIMEOUTS_S,
    ))
      expect(entries[event as keyof typeof entries][0]?.timeout).toBe(timeout);
    for (const event of CURSOR_TELEMETRY_EVENTS)
      expect(entries[event][0]?.timeout).toBe(5);
  });

  it("creates a versioned file from nothing", () => {
    const merged = mergeCursorHooks(undefined, CONFIG);
    expect(merged.changed).toBe(true);
    expect(merged.settings.version).toBe(1);
    expect(cursorHookPresence(merged.settings, TEST_ENROLLMENT).complete).toBe(
      true,
    );
  });

  it("keeps foreign entries and members, and is idempotent", () => {
    const merged = mergeCursorHooks(FOREIGN, CONFIG);
    expect(merged.settings.extra).toEqual({ kept: true });
    expect(merged.settings.hooks?.["afterFileEdit"]).toEqual([
      { command: "./format.sh" },
    ]);
    expect(merged.settings.hooks?.["preToolUse"]?.[0]).toEqual({
      command: "./guard.sh",
      matcher: "Shell",
    });
    expect(merged.settings.hooks?.["preToolUse"]).toHaveLength(2);
    // The input is never mutated.
    expect(FOREIGN.hooks.preToolUse).toHaveLength(1);
    expect(mergeCursorHooks(merged.settings, CONFIG).changed).toBe(false);
  });

  it("replaces an earlier entry of the same enrollment rather than stacking it", () => {
    const once = mergeCursorHooks(FOREIGN, CONFIG).settings;
    const moved = mergeCursorHooks(once, {
      ...CONFIG,
      hookCommand: "/opt/tacho hook",
    });
    expect(moved.changed).toBe(true);
    expect(moved.settings.hooks?.["preToolUse"]).toHaveLength(2);
  });

  it("strips one enrollment, or any, and gives back the user's file", () => {
    const ours = mergeCursorHooks(FOREIGN, CONFIG).settings;
    const both = mergeCursorHooks(ours, {
      ...CONFIG,
      enrollmentId: OTHER,
    }).settings;
    const one = stripCursorHooks(both, TEST_ENROLLMENT);
    expect(one.changed).toBe(true);
    expect(cursorHookPresence(one.settings, OTHER).complete).toBe(true);
    expect(cursorHookPresence(one.settings, TEST_ENROLLMENT).present).toEqual(
      [],
    );
    const all = stripCursorHooks(both);
    expect(all.settings).toEqual(FOREIGN);
    // A file that held nothing but ours empties, `version` included: the
    // merge is what wrote that `version` on a machine with no `hooks.json`,
    // and `HarnessFiles.settle` removes a file Tacho created only when what
    // is left says nothing. A leftover `{"version":1}` reads as a user edit
    // and the file survives an unenroll --purge.
    expect(
      stripCursorHooks(mergeCursorHooks(undefined, CONFIG).settings).settings,
    ).toEqual({});
    // The user's own `version` stays while any of their hooks do.
    const withUserHook = stripCursorHooks(
      mergeCursorHooks(
        { version: 1, hooks: { stop: [{ command: "mine" }] } },
        CONFIG,
      ).settings,
    ).settings;
    expect(withUserHook).toEqual({
      version: 1,
      hooks: { stop: [{ command: "mine" }] },
    });
  });

  it("leaves a document it cannot read exactly as it is", () => {
    expect(cursorHooksShapeProblem({ hooks: [] })).toMatch(/not an object/);
    expect(cursorHooksShapeProblem({ hooks: { stop: "x" } })).toMatch(
      /not a list/,
    );
    const broken = { hooks: [] };
    expect(stripCursorHooks(broken)).toEqual({
      settings: broken,
      changed: false,
    });
  });

  it("reports missing events and ignores junk entries", () => {
    const partial = {
      version: 1,
      hooks: {
        preToolUse: [
          null,
          "junk",
          {
            type: "command",
            command: `tacho hook --enrollment ${TEST_ENROLLMENT} --harness cursor`,
          },
        ],
      },
    };
    const presence = cursorHookPresence(partial, TEST_ENROLLMENT);
    expect(presence.complete).toBe(false);
    expect(presence.present).toEqual(["preToolUse"]);
    expect(presence.missing).toContain("stop");
    expect(cursorHookPresence(undefined, TEST_ENROLLMENT).present).toEqual([]);
  });
});
