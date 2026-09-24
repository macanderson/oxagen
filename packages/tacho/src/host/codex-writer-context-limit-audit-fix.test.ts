/**
 * Codex spills a hook's `additionalContext` past about 2,500 tokens to a
 * file unless the handler sets `additionalContextLimit`. The three handlers
 * that answer with text (SessionStart, UserPromptSubmit and PostToolUse, where
 * a steer lands mid-turn) set it high enough for the 9,500 characters the
 * daemon delivers at most; no other handler carries it, since Codex warns
 * about the key on an event that cannot produce context.
 */
import { describe, expect, it } from "vitest";
import {
  CODEX_ADDITIONAL_CONTEXT_LIMIT,
  CODEX_HOOK_EVENTS,
  codexHookEntries,
  mergeCodexHooks,
} from "./codex-writer";
import { TEST_ENROLLMENT } from "./test-support";

const CONFIG = {
  enrollmentId: TEST_ENROLLMENT,
  hookCommand: "/opt/tacho/tacho hook",
  port: 47001,
  localToken: "tok",
};

describe("the Codex additionalContext limit", () => {
  it("is set on the handlers that answer with text only", () => {
    const entries = codexHookEntries(CONFIG);
    for (const event of CODEX_HOOK_EVENTS) {
      const hook = entries[event][0]?.hooks[0];
      if (
        event === "SessionStart" ||
        event === "UserPromptSubmit" ||
        event === "PostToolUse"
      ) {
        expect(hook).toMatchObject({
          type: "command",
          additionalContextLimit: 10_000,
        });
      } else {
        expect(hook).not.toHaveProperty("additionalContextLimit");
      }
    }
    // Enough approximate tokens for the daemon's 9,500-character answer.
    expect(CODEX_ADDITIONAL_CONTEXT_LIMIT).toBeGreaterThanOrEqual(9_500);
  });

  it("rewrites an install from before the limit, and is idempotent after", () => {
    const merged = mergeCodexHooks(undefined, CONFIG).settings;
    const older = JSON.parse(JSON.stringify(merged)) as typeof merged;
    for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse"]) {
      delete older.hooks![event]![0]!.hooks[0]!["additionalContextLimit"];
    }
    const upgraded = mergeCodexHooks(older, CONFIG);
    expect(upgraded.changed).toBe(true);
    expect(upgraded.settings).toEqual(merged);
    expect(mergeCodexHooks(merged, CONFIG).changed).toBe(false);
  });
});
