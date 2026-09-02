/**
 * Unit tests for lib/ci-wait.ts — the CI-wait awareness behind the turn
 * inactivity guard's pre-abort call-out:
 *   - looksLikeCiWait: which tool calls mark a turn as "waiting on CI"
 *   - createCiWaitProbe: probes only after a CI-watch tool was seen, treats a
 *     pending rollup as a live wait, and never extends on green/red/error
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../debug-log.js", () => ({ debugLog: vi.fn() }));

import {
  looksLikeCiWait,
  createCiWaitProbe,
  type CommandRunner,
} from "../ci-wait.js";

function rollup(items: Array<{ conclusion?: string; state?: string }>): string {
  return JSON.stringify({ statusCheckRollup: items });
}

describe("looksLikeCiWait", () => {
  it("matches gh CI watch/poll commands run via bash", () => {
    expect(
      looksLikeCiWait("bash", { command: "gh run watch 123 --exit-status" }),
    ).toBe(true);
    expect(
      looksLikeCiWait("bash", { command: "gh pr checks 42 --watch" }),
    ).toBe(true);
    expect(
      looksLikeCiWait("bash", {
        command: "gh pr view --json statusCheckRollup",
      }),
    ).toBe(true);
    expect(
      looksLikeCiWait("bash", { command: "sleep 60 && gh run list --limit 3" }),
    ).toBe(true);
  });

  it("ignores non-bash tools and unrelated commands", () => {
    expect(looksLikeCiWait("read_file", { command: "gh run watch" })).toBe(
      false,
    );
    expect(looksLikeCiWait("bash", { command: "pnpm test" })).toBe(false);
    expect(looksLikeCiWait("bash", { command: "git push origin main" })).toBe(
      false,
    );
    expect(looksLikeCiWait("bash", {})).toBe(false);
    expect(looksLikeCiWait("bash", null)).toBe(false);
  });
});

describe("createCiWaitProbe", () => {
  const pendingRun: CommandRunner = vi
    .fn()
    .mockResolvedValue(
      rollup([{ state: "PENDING" }, { conclusion: "SUCCESS" }]),
    );

  it("probes false when no CI-watch tool was ever seen", async () => {
    const run = vi.fn();
    const probe = createCiWaitProbe("/repo", {
      run: run as unknown as CommandRunner,
    });
    await expect(probe.probe()).resolves.toBe(false);
    expect(run).not.toHaveBeenCalled(); // no call-out for a turn that never watched CI
  });

  it("probes true when a CI-watch tool ran and checks are still pending", async () => {
    const probe = createCiWaitProbe("/repo", { run: pendingRun });
    probe.noteToolCall("bash", { command: "gh run watch 99" });
    await expect(probe.probe()).resolves.toBe(true);
  });

  it("probes false when checks reached a terminal state (green or failing)", async () => {
    const green: CommandRunner = vi
      .fn()
      .mockResolvedValue(
        rollup([{ conclusion: "SUCCESS" }, { conclusion: "SUCCESS" }]),
      );
    const probe = createCiWaitProbe("/repo", { run: green });
    probe.noteToolCall("bash", { command: "gh pr checks --watch" });
    await expect(probe.probe()).resolves.toBe(false);

    const failing: CommandRunner = vi
      .fn()
      .mockResolvedValue(
        rollup([{ conclusion: "FAILURE" }, { state: "PENDING" }]),
      );
    const probe2 = createCiWaitProbe("/repo", { run: failing });
    probe2.noteToolCall("bash", { command: "gh pr checks --watch" });
    await expect(probe2.probe()).resolves.toBe(false);
  });

  it("probes false (never throws) when gh fails or returns junk", async () => {
    const boom: CommandRunner = vi
      .fn()
      .mockRejectedValue(new Error("no pull requests found"));
    const probe = createCiWaitProbe("/repo", { run: boom });
    probe.noteToolCall("bash", { command: "gh run watch" });
    await expect(probe.probe()).resolves.toBe(false);

    const junk: CommandRunner = vi.fn().mockResolvedValue("not json");
    const probe2 = createCiWaitProbe("/repo", { run: junk });
    probe2.noteToolCall("bash", { command: "gh run watch" });
    await expect(probe2.probe()).resolves.toBe(false);
  });

  it("parses ANSI-colorized gh output (GH_FORCE_TTY shells)", async () => {
    // gh under a color-forcing shell wraps JSON in escape sequences; the probe
    // must strip them or every call-out silently downgrades to "not pending".
    const colorized: CommandRunner = vi
      .fn()
      .mockResolvedValue(
        `\x1b[1;38m{\x1b[m\x1b[1;34m"statusCheckRollup"\x1b[m\x1b[1;38m:\x1b[m ` +
          `\x1b[1;38m[\x1b[m\x1b[1;38m{\x1b[m\x1b[1;34m"state"\x1b[m\x1b[1;38m:\x1b[m ` +
          `\x1b[32m"PENDING"\x1b[m\x1b[1;38m}\x1b[m\x1b[1;38m]\x1b[m\x1b[1;38m}\x1b[m`,
      );
    const probe = createCiWaitProbe("/repo", { run: colorized });
    probe.noteToolCall("bash", { command: "gh run watch" });
    await expect(probe.probe()).resolves.toBe(true);
  });

  it("passes cwd and a bounded timeout to the runner", async () => {
    const run = vi.fn().mockResolvedValue(rollup([{ state: "PENDING" }]));
    const probe = createCiWaitProbe("/some/repo", { run });
    probe.noteToolCall("bash", { command: "gh run watch" });
    await probe.probe();
    expect(run).toHaveBeenCalledWith(
      "gh",
      ["pr", "view", "--json", "statusCheckRollup"],
      expect.objectContaining({
        cwd: "/some/repo",
        timeoutMs: expect.any(Number),
      }),
    );
  });
});
