import { describe, expect, it } from "vitest";
import {
  ALL_HOOK_EVENTS,
  COMMAND_HOOK_EVENTS,
  HTTP_HOOK_EVENTS,
  mergeTachoSettings,
  renderManagedSettings,
  stripTachoSettings,
  tachoEnv,
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

const FOREIGN = {
  permissions: { allow: ["Bash(ls)"] },
  hooks: {
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [{ type: "command", command: "./.claude/hooks/guard.sh" }],
      },
    ],
    PostToolUse: [
      {
        matcher: "Write|Edit",
        hooks: [{ type: "command", command: "lint", async: true }],
      },
    ],
  },
  env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318", MY_VAR: "1" },
};

describe("settings writer", () => {
  it("installs command hooks for enforcement events and http hooks for the rest", () => {
    const entries = tachoHookEntries(CONFIG);
    expect(Object.keys(entries).sort()).toEqual([...ALL_HOOK_EVENTS].sort());
    for (const event of COMMAND_HOOK_EVENTS) {
      expect(entries[event][0]?.hooks[0]).toMatchObject({
        type: "command",
        command: `${CONFIG.hookCommand} --enrollment ${TEST_ENROLLMENT}`,
      });
    }
    for (const event of HTTP_HOOK_EVENTS) {
      expect(entries[event][0]?.hooks[0]).toMatchObject({
        type: "http",
        url: `http://127.0.0.1:47001/hook/${TEST_ENROLLMENT}`,
        headers: { Authorization: "Bearer $TACHO_LOCAL_TOKEN" },
        allowedEnvVars: ["TACHO_LOCAL_TOKEN"],
      });
    }
    expect(entries.PermissionRequest[0]?.hooks[0]?.timeout).toBe(600);
    expect(tachoEnv(CONFIG)).toMatchObject({
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:47001",
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer tok",
      TACHO_LOCAL_TOKEN: "tok",
    });
    expect(tachoEnv({ ...CONFIG, tachoHome: "/x" })["TACHO_HOME"]).toBe("/x");
  });

  it("merges idempotently and keeps every foreign entry", () => {
    const first = mergeTachoSettings(FOREIGN, CONFIG);
    expect(first.changed).toBe(true);
    expect(first.settings.permissions).toEqual(FOREIGN.permissions);
    expect(first.settings.hooks?.PreToolUse).toHaveLength(2);
    expect(first.settings.hooks?.PreToolUse?.[0]).toEqual(
      FOREIGN.hooks.PreToolUse[0],
    );
    expect(first.settings.hooks?.PostToolUse?.[0]).toEqual(
      FOREIGN.hooks.PostToolUse[0],
    );
    expect(first.settings.env?.MY_VAR).toBe("1");
    expect(first.displaced).toEqual({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
    });
    const second = mergeTachoSettings(first.settings, CONFIG);
    expect(second.changed).toBe(false);
    expect(second.settings).toEqual(first.settings);
    expect(second.displaced).toEqual({});
    // A changed port replaces the earlier Tacho group instead of stacking one.
    const moved = mergeTachoSettings(first.settings, {
      ...CONFIG,
      port: 47002,
    });
    expect(moved.changed).toBe(true);
    expect(moved.settings.hooks?.PostToolUse).toHaveLength(2);
    expect(
      mergeTachoSettings(null, CONFIG).settings.hooks?.SessionStart,
    ).toHaveLength(1);
    expect(mergeTachoSettings("junk", CONFIG).settings.hooks).toBeDefined();
  });

  it("strips its own entries, restores displaced env, and leaves the rest", () => {
    const merged = mergeTachoSettings(FOREIGN, CONFIG);
    const stripped = stripTachoSettings(
      merged.settings,
      TEST_ENROLLMENT,
      merged.displaced,
    );
    expect(stripped.changed).toBe(true);
    expect(stripped.settings).toEqual(FOREIGN);
    expect(stripTachoSettings(FOREIGN, TEST_ENROLLMENT).changed).toBe(false);
    const alone = stripTachoSettings(mergeTachoSettings({}, CONFIG).settings);
    expect(alone.settings).toEqual({});
    expect(stripTachoSettings(undefined).settings).toEqual({});
  });

  it("reports presence per event and notices disableAllHooks", () => {
    const merged = mergeTachoSettings(FOREIGN, CONFIG).settings;
    const complete = tachoHookPresence(merged, TEST_ENROLLMENT);
    expect(complete.complete).toBe(true);
    expect(complete.missing).toEqual([]);
    const withoutEnd = JSON.parse(JSON.stringify(merged)) as typeof merged;
    delete withoutEnd.hooks?.["SessionEnd"];
    const partial = tachoHookPresence(withoutEnd, TEST_ENROLLMENT);
    expect(partial.complete).toBe(false);
    expect(partial.missing).toEqual(["SessionEnd"]);
    expect(
      tachoHookPresence({ ...merged, disableAllHooks: true }, TEST_ENROLLMENT),
    ).toMatchObject({
      complete: false,
      disabledByFlag: true,
    });
    expect(tachoHookPresence(FOREIGN, TEST_ENROLLMENT).present).toEqual([]);
    expect(
      tachoHookPresence(merged, "tch_zzzzzzzzzzzzzzzzzzzzzz").present,
    ).toEqual([]);
    expect(tachoHookPresence(null, TEST_ENROLLMENT).envOk).toBe(false);
  });

  it("renders a managed settings document that locks the hooks", () => {
    const managed = renderManagedSettings(CONFIG);
    expect(managed["allowManagedHooksOnly"]).toBe(true);
    expect(managed["disableBypassPermissionsMode"]).toBe("disable");
    expect(managed.hooks?.PreToolUse).toHaveLength(1);
  });
});
