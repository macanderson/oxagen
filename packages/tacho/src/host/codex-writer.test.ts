/**
 * The Codex hooks writer on its own: every event is a command hook tagged
 * `--harness codex`, foreign groups survive a merge and a strip, and
 * presence reads what an enrollment actually installed.
 */
import { describe, expect, it } from "vitest";
import {
  CODEX_HOOK_EVENTS,
  CODEX_TELEMETRY_EVENTS,
  codexHookEntries,
  codexHookPresence,
  mergeCodexHooks,
  stripCodexHooks,
} from "./codex-writer";
import { COMMAND_HOOK_EVENTS } from "./settings-writer";
import { TEST_ENROLLMENT } from "./test-support";

const CONFIG = {
  enrollmentId: TEST_ENROLLMENT,
  hookCommand: '"C:\\Program Files\\Oxagen\\tacho.exe" hook',
  port: 47001,
  localToken: "tok",
};

const OTHER = "tch_zyxwvutsrqpnmkjhgfedcb";

const FOREIGN = {
  hooks: {
    PreToolUse: [
      { matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] },
    ],
    Stop: [{ hooks: [{ type: "command", command: "notify.sh" }] }],
  },
  extra: { kept: true },
};

describe("codex writer", () => {
  it("installs a command hook tagged with the harness for every Codex event", () => {
    const entries = codexHookEntries(CONFIG);
    expect(Object.keys(entries).sort()).toEqual([...CODEX_HOOK_EVENTS].sort());
    for (const event of CODEX_HOOK_EVENTS) {
      const hook = entries[event][0]?.hooks[0];
      expect(hook).toMatchObject({
        type: "command",
        command: `${CONFIG.hookCommand} --enrollment ${TEST_ENROLLMENT} --harness codex`,
      });
    }
    // Enforcement events keep their per-event budgets; telemetry gets 5 s.
    for (const event of CODEX_TELEMETRY_EVENTS) {
      expect(entries[event][0]?.hooks[0]).toMatchObject({ timeout: 5 });
    }
    expect(entries.PermissionRequest[0]?.hooks[0]?.timeout).toBeGreaterThan(
      entries.PostToolUse[0]?.hooks[0]?.timeout ?? 0,
    );
  });

  it("merges into an absent, empty, or foreign document without losing anything", () => {
    for (const existing of [undefined, null, "junk", 7]) {
      const merged = mergeCodexHooks(existing, CONFIG);
      expect(merged.changed).toBe(true);
      expect(Object.keys(merged.settings.hooks ?? {}).sort()).toEqual(
        [...CODEX_HOOK_EVENTS].sort(),
      );
    }
    const merged = mergeCodexHooks(FOREIGN, CONFIG);
    expect(merged.changed).toBe(true);
    expect(merged.settings["extra"]).toEqual({ kept: true });
    expect(merged.settings.hooks?.PreToolUse?.[0]).toEqual(
      FOREIGN.hooks.PreToolUse[0],
    );
    expect(merged.settings.hooks?.PreToolUse).toHaveLength(2);
    expect(merged.settings.hooks?.Stop).toHaveLength(2);
    // The input is not mutated.
    expect(FOREIGN.hooks.PreToolUse).toHaveLength(1);
    // Merging again for the same enrollment replaces, never duplicates.
    const again = mergeCodexHooks(merged.settings, CONFIG);
    expect(again.changed).toBe(false);
    expect(again.settings.hooks?.PreToolUse).toHaveLength(2);
    // Another enrollment's groups are foreign to this one.
    const both = mergeCodexHooks(merged.settings, {
      ...CONFIG,
      enrollmentId: OTHER,
    });
    expect(both.settings.hooks?.PreToolUse).toHaveLength(3);
  });

  it("strips one enrollment or all of Tacho's groups and drops empty events", () => {
    const merged = mergeCodexHooks(FOREIGN, CONFIG).settings;
    const both = mergeCodexHooks(merged, {
      ...CONFIG,
      enrollmentId: OTHER,
    }).settings;
    const one = stripCodexHooks(both, TEST_ENROLLMENT);
    expect(one.changed).toBe(true);
    expect(JSON.stringify(one.settings)).not.toContain(TEST_ENROLLMENT);
    expect(JSON.stringify(one.settings)).toContain(OTHER);
    expect(one.settings["extra"]).toEqual({ kept: true });
    const all = stripCodexHooks(one.settings);
    expect(all.changed).toBe(true);
    expect(all.settings.hooks).toEqual(FOREIGN.hooks);
    // Only Tacho's groups: `hooks` disappears altogether.
    const bare = stripCodexHooks(mergeCodexHooks({}, CONFIG).settings);
    expect(bare.settings.hooks).toBeUndefined();
    // Nothing to strip is not a change; junk documents strip to {}.
    expect(stripCodexHooks(FOREIGN, TEST_ENROLLMENT).changed).toBe(false);
    expect(stripCodexHooks(undefined)).toEqual({
      settings: {},
      changed: false,
    });
    expect(stripCodexHooks(null)).toEqual({ settings: {}, changed: false });
  });

  it("reports which of Tacho's hooks are present for an enrollment", () => {
    expect(codexHookPresence(undefined, TEST_ENROLLMENT)).toEqual({
      complete: false,
      present: [],
      missing: [...CODEX_HOOK_EVENTS],
    });
    expect(codexHookPresence(null, TEST_ENROLLMENT).complete).toBe(false);
    const merged = mergeCodexHooks(FOREIGN, CONFIG).settings;
    expect(codexHookPresence(merged, TEST_ENROLLMENT)).toEqual({
      complete: true,
      present: [...CODEX_HOOK_EVENTS],
      missing: [],
    });
    // Another enrollment's hooks do not count for this one.
    expect(codexHookPresence(merged, OTHER).complete).toBe(false);
    // A partial install names what is missing.
    const partial = JSON.parse(JSON.stringify(merged)) as {
      hooks: Record<string, unknown>;
    };
    delete partial.hooks["SessionEnd"];
    delete partial.hooks["PreToolUse"];
    const presence = codexHookPresence(partial, TEST_ENROLLMENT);
    expect(presence.complete).toBe(false);
    expect(presence.missing.sort()).toEqual(["PreToolUse", "SessionEnd"]);
    expect(presence.present).toHaveLength(CODEX_HOOK_EVENTS.length - 2);
    expect(presence.present).toEqual(
      expect.arrayContaining(
        [...COMMAND_HOOK_EVENTS].filter((e) => e !== "PreToolUse"),
      ),
    );
  });
});
