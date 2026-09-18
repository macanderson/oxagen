/**
 * What this file holds honest about Cursor's `hooks.json`: that the veto
 * points fail closed (Cursor otherwise proceeds when a hook cannot answer),
 * that the merge is a merge and not a replacement, and that a moved config
 * directory moves the file. Paths and behaviour verified 2026-09-18 against
 * https://cursor.com/docs/agent/hooks and
 * https://cursor.com/docs/cli/reference/configuration, both fetched that day.
 */
import { describe, expect, it } from "vitest";
import {
  CURSOR_ENFORCEMENT_EVENTS,
  CURSOR_HOOK_EVENTS,
} from "../claude-code/cursor-adapter";
import {
  absoluteHookCommandProblem,
  CURSOR_HOOKS_VERSION,
  cursorConfigDir,
  cursorHookEntries,
  cursorHookPresence,
  cursorHooksPaths,
  cursorHooksShapeProblem,
  mergeCursorHooks,
  stripCursorHooks,
} from "./cursor-writer";
import type { HookEntry, HookInstallConfig } from "./settings-writer";

const ENROLLMENT = "tch_abcdefghijklmnopqrstuv";

const CONFIG: HookInstallConfig = {
  enrollmentId: ENROLLMENT,
  hookCommand: "/opt/oxagen/tacho hook",
  port: 41_234,
  localToken: "token",
};

describe("the hooks the writer emits", () => {
  const entries = cursorHookEntries(CONFIG);

  it("registers every event with an absolute command tagged as Cursor's", () => {
    expect(Object.keys(entries).sort()).toEqual([...CURSOR_HOOK_EVENTS].sort());
    for (const list of Object.values(entries)) {
      expect(list).toHaveLength(1);
      const entry = list[0] as HookEntry;
      expect(entry.command).toBe(
        `/opt/oxagen/tacho hook --enrollment ${ENROLLMENT} --harness cursor`,
      );
      expect(entry.type).toBe("command");
      expect(typeof entry.timeout).toBe("number");
    }
  });

  it("fails closed at every veto point, because Cursor otherwise allows", () => {
    // Cursor logs a crashed, timed-out or unexpectedly non-zero hook and lets
    // the action proceed unless `failClosed` is set. Without it a dead
    // collector silently means allow.
    for (const event of CURSOR_ENFORCEMENT_EVENTS)
      expect((entries[event][0] as HookEntry)["failClosed"]).toBe(true);
  });

  it("fails open after the fact, where there is nothing left to permit", () => {
    // postToolUse and the rest record something that already happened.
    // Failing closed there would turn a collector outage into an unusable
    // Cursor, which is the call this repo already made for Claude Code's
    // HTTP hooks and Codex's telemetry hooks.
    for (const event of CURSOR_HOOK_EVENTS) {
      if (CURSOR_ENFORCEMENT_EVENTS.includes(event)) continue;
      expect((entries[event][0] as HookEntry)["failClosed"]).toBe(false);
    }
  });

  it("refuses a relative path, which Cursor would resolve in ~/.cursor", () => {
    expect(absoluteHookCommandProblem("/opt/oxagen/tacho hook")).toBeUndefined();
    expect(
      absoluteHookCommandProblem("'/opt/my apps/tacho' hook"),
    ).toBeUndefined();
    expect(
      absoluteHookCommandProblem("C:\\Oxagen\\tacho.exe hook"),
    ).toBeUndefined();
    // The bundled layout: `node` is a PATH lookup, which does not depend on
    // the working directory, and the script it runs is absolute.
    expect(
      absoluteHookCommandProblem("node /opt/tacho/tacho-hook.mjs"),
    ).toBeUndefined();
    expect(absoluteHookCommandProblem("tacho-hook")).toBeUndefined();
    expect(absoluteHookCommandProblem("./hooks/tacho.sh")).toContain(
      "~/.cursor/",
    );
    expect(absoluteHookCommandProblem("node bin/tacho-hook.mjs")).toContain(
      '"bin/tacho-hook.mjs"',
    );
  });
});

describe("merging into an existing hooks.json", () => {
  it("keeps the operator's own hooks and the rest of the document", () => {
    const foreign: HookEntry = {
      type: "command",
      command: "/usr/local/bin/audit.sh",
      matcher: "Shell",
    };
    const existing = {
      version: 1,
      permissions: { allow: ["Read"] },
      hooks: { preToolUse: [foreign], afterFileEdit: [foreign] },
    };
    const merged = mergeCursorHooks(existing, CONFIG);
    expect(merged.changed).toBe(true);
    expect(merged.document["permissions"]).toEqual({ allow: ["Read"] });
    // The foreign entry survives, ours is appended, and an event we do not
    // register is left exactly as it was.
    expect(merged.document.hooks?.["preToolUse"]?.[0]).toEqual(foreign);
    expect(merged.document.hooks?.["preToolUse"]).toHaveLength(2);
    expect(merged.document.hooks?.["afterFileEdit"]).toEqual([foreign]);
    // The input is never mutated.
    expect(existing.hooks.preToolUse).toHaveLength(1);
  });

  it("sets the schema version only when the document does not carry one", () => {
    expect(mergeCursorHooks(undefined, CONFIG).document["version"]).toBe(
      CURSOR_HOOKS_VERSION,
    );
    expect(
      mergeCursorHooks({ version: 2 }, CONFIG).document["version"],
    ).toBe(2);
  });

  it("replaces this enrollment's earlier entries instead of stacking them", () => {
    const once = mergeCursorHooks(undefined, CONFIG).document;
    const twice = mergeCursorHooks(once, CONFIG);
    expect(twice.changed).toBe(false);
    expect(twice.document.hooks?.["preToolUse"]).toHaveLength(1);
  });

  it("names a document it cannot merge into rather than rewriting it", () => {
    expect(cursorHooksShapeProblem({ hooks: [] })).toContain("not an object");
    expect(cursorHooksShapeProblem({ hooks: { preToolUse: 3 } })).toContain(
      "not a list",
    );
    expect(cursorHooksShapeProblem(undefined)).toBeUndefined();
  });

  it("strips this enrollment and drops the events it emptied", () => {
    const foreign: HookEntry = {
      type: "command",
      command: "/usr/local/bin/audit.sh",
    };
    const merged = mergeCursorHooks({ hooks: { stop: [foreign] } }, CONFIG);
    const stripped = stripCursorHooks(merged.document, ENROLLMENT);
    expect(stripped.changed).toBe(true);
    expect(stripped.document.hooks).toEqual({ stop: [foreign] });
    expect(JSON.stringify(stripped.document)).not.toContain("--enrollment");
    // A document with nothing of ours in it goes back untouched.
    expect(stripCursorHooks({ hooks: { stop: [foreign] } }).changed).toBe(
      false,
    );
  });
});

describe("presence", () => {
  it("is complete only when every event is registered and fails closed", () => {
    const merged = mergeCursorHooks(undefined, CONFIG).document;
    const presence = cursorHookPresence(merged, ENROLLMENT);
    expect(presence.complete).toBe(true);
    expect(presence.missing).toEqual([]);
    expect(presence.failOpenEnforcement).toEqual([]);
    expect(cursorHookPresence(merged, "tch_zzzzzzzzzzzzzzzzzzzzzz").present)
      .toEqual([]);
  });

  it("names a veto hook someone edited to fail open", () => {
    const merged = mergeCursorHooks(undefined, CONFIG).document;
    delete (merged.hooks?.["preToolUse"]?.[0] as HookEntry)["failClosed"];
    const presence = cursorHookPresence(merged, ENROLLMENT);
    expect(presence.present).toContain("preToolUse");
    expect(presence.failOpenEnforcement).toEqual(["preToolUse"]);
    expect(presence.complete).toBe(false);
  });
});

describe("where the file goes", () => {
  it("is ~/.cursor/hooks.json by default", () => {
    expect(cursorConfigDir("/home/dev", "linux", {})).toBe("/home/dev/.cursor");
    expect(cursorHooksPaths("/home/dev", "linux", {})).toEqual([
      "/home/dev/.cursor/hooks.json",
    ]);
  });

  it("follows CURSOR_CONFIG_DIR, and writes the default as well", () => {
    // Cursor documents CURSOR_CONFIG_DIR and XDG_CONFIG_HOME for its CLI
    // config directory, and the hooks page names only ~/.cursor/hooks.json.
    // Nothing says which file the hooks loader reads, so both are written:
    // the unread one is inert, and betting on one would leave a machine
    // reported as covered whose hooks nothing runs.
    expect(
      cursorConfigDir("/home/dev", "darwin", { CURSOR_CONFIG_DIR: "/etc/cur" }),
    ).toBe("/etc/cur");
    expect(
      cursorHooksPaths("/home/dev", "darwin", { CURSOR_CONFIG_DIR: "/etc/cur" }),
    ).toEqual(["/etc/cur/hooks.json", "/home/dev/.cursor/hooks.json"]);
  });

  it("follows XDG_CONFIG_HOME on Linux and BSD, and nowhere else", () => {
    expect(
      cursorConfigDir("/home/dev", "linux", { XDG_CONFIG_HOME: "/home/dev/.config" }),
    ).toBe("/home/dev/.config/cursor");
    expect(
      cursorConfigDir("/home/dev", "freebsd", { XDG_CONFIG_HOME: "/x" }),
    ).toBe("/x/cursor");
    for (const platform of ["darwin", "win32"] as const)
      expect(
        cursorConfigDir("/home/dev", platform, { XDG_CONFIG_HOME: "/x" }),
      ).toBe("/home/dev/.cursor");
  });
});
