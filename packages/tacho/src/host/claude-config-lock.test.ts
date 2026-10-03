/**
 * The lock Claude Code saves its user config under (#5287): Oxagen's edit
 * takes it, waits while Claude Code holds it, takes over one a dead process
 * left, and always lets it go.
 */
import { existsSync, mkdirSync, mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_CONFIG_LOCK_STALE_MS,
  claudeConfigLockPath,
  withClaudeConfigLock,
} from "./claude-config-lock";
import { HarnessFileError } from "./harness-file";

function scratchConfig(): string {
  return join(mkdtempSync(join(tmpdir(), "tacho-claude-lock-")), ".claude.json");
}

describe("withClaudeConfigLock", () => {
  it("holds Claude Code's lock directory during the edit and removes it after", () => {
    const file = scratchConfig();
    const lock = claudeConfigLockPath(file);
    expect(lock).toBe(`${file}.lock`);
    const seen = withClaudeConfigLock(file, () => existsSync(lock));
    expect(seen).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  it("removes the lock when the edit throws", () => {
    const file = scratchConfig();
    expect(() =>
      withClaudeConfigLock(file, () => {
        throw new Error("edit failed");
      }),
    ).toThrow("edit failed");
    expect(existsSync(claudeConfigLockPath(file))).toBe(false);
  });

  it("waits for a live lock, then gives up without editing or taking it", () => {
    const file = scratchConfig();
    const lock = claudeConfigLockPath(file);
    mkdirSync(lock);
    let clock = Date.now();
    let waits = 0;
    let edited = false;
    expect(() =>
      withClaudeConfigLock(
        file,
        () => {
          edited = true;
        },
        {
          now: () => clock,
          sleep: (ms) => {
            waits += 1;
            clock += ms;
          },
          waitMs: 1_000,
        },
      ),
    ).toThrow(HarnessFileError);
    expect(waits).toBeGreaterThan(0);
    expect(edited).toBe(false);
    // Claude Code's lock is Claude Code's to release.
    expect(existsSync(lock)).toBe(true);
  });

  it("takes over a lock that a dead process left behind", () => {
    const file = scratchConfig();
    const lock = claudeConfigLockPath(file);
    mkdirSync(lock);
    const old = (Date.now() - CLAUDE_CONFIG_LOCK_STALE_MS - 60_000) / 1000;
    utimesSync(lock, old, old);
    let edited = false;
    withClaudeConfigLock(file, () => {
      edited = true;
    });
    expect(edited).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  it("edits without a lock when the config's directory does not exist", () => {
    const file = join(scratchConfig(), "..", "missing", ".claude.json");
    let edited = false;
    withClaudeConfigLock(file, () => {
      edited = true;
    });
    expect(edited).toBe(true);
    expect(existsSync(claudeConfigLockPath(file))).toBe(false);
  });
});
