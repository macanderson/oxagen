/**
 * The walk from a Codex hook up to the Codex process (#3989). It has to name
 * exactly one per-session Codex process or nothing: a transient shell would
 * seal a live session a minute after every hook, and a shared host would
 * outlive its sessions and take the operator's `SIGTERM` for all of them.
 */
import { describe, expect, it } from "vitest";
import {
  codexHarnessPid,
  type PsArgs,
  WALK_BUDGET_MS,
} from "./harness-process";
import type { ProcessInfo, PsLookup } from "./stella-adapter";

/** A process table: pid to `{ppid, comm}`, plus each pid's command line. */
function table(rows: Record<number, ProcessInfo & { args?: string }>): {
  lookup: PsLookup;
  argsOf: PsArgs;
} {
  return {
    lookup: (pid) => {
      const row = rows[pid];
      return row === undefined ? undefined : { ppid: row.ppid, comm: row.comm };
    },
    argsOf: (pid) => rows[pid]?.args,
  };
}

const TUI = {
  // The login shell Codex runs the command through, then Codex, then the
  // terminal's shell that started Codex.
  300: { ppid: 200, comm: "/bin/zsh", args: "/bin/zsh -lc tacho hook" },
  200: {
    ppid: 100,
    comm: "/opt/homebrew/Caskroom/codex/0.156.1/bin/codex",
    args: "codex",
  },
  100: { ppid: 1, comm: "-zsh", args: "-zsh" },
};

describe("codexHarnessPid", () => {
  it("walks past the shell to the Codex process", () => {
    const { lookup, argsOf } = table(TUI);
    expect(codexHarnessPid(300, "darwin", lookup, argsOf)).toBe(200);
  });

  it("takes Codex itself when the shell exec'd the hook", () => {
    const { lookup, argsOf } = table(TUI);
    expect(codexHarnessPid(200, "linux", lookup, argsOf)).toBe(200);
  });

  it("knows the per-platform binary name older npm builds shipped", () => {
    const { lookup, argsOf } = table({
      30: { ppid: 20, comm: "sh", args: "sh -lc tacho hook" },
      // Linux cuts `comm` at 15 characters.
      20: {
        ppid: 1,
        comm: "codex-x86_64-un",
        args: "codex-x86_64-unknown-linux-musl exec fix it",
      },
    });
    expect(codexHarnessPid(30, "linux", lookup, argsOf)).toBe(20);
  });

  it("gives no pid under the app server the Codex GUI drives, which runs many threads", () => {
    const { lookup, argsOf } = table({
      30: { ppid: 20, comm: "/bin/zsh", args: "/bin/zsh -lc tacho hook" },
      20: {
        ppid: 10,
        comm: "/Applications/Codex.app/Contents/Resources/codex",
        args: "/Applications/Codex.app/Contents/Resources/codex app-server",
      },
      10: { ppid: 1, comm: "/Applications/Codex.app/Contents/MacOS/Codex" },
    });
    expect(codexHarnessPid(30, "darwin", lookup, argsOf)).toBeUndefined();
  });

  it("knows the arm64 binary name, cut to 15 characters", () => {
    const { lookup, argsOf } = table({
      30: { ppid: 20, comm: "sh", args: "sh -lc tacho hook" },
      20: {
        ppid: 1,
        comm: "codex-aarch64-u",
        args: "codex-aarch64-unknown-linux-musl",
      },
    });
    expect(codexHarnessPid(30, "linux", lookup, argsOf)).toBe(20);
  });

  it.each([
    // The helper beside the 0.156.1 binary, then the per-command helpers
    // the binary names, as Linux cuts them to 15 characters.
    "/opt/homebrew/Caskroom/codex/0.156.1/bin/codex-code-mode-host",
    "codex-linux-san",
    "codex-execve-wr",
  ])(
    "never takes the helper %s for Codex, because it exits with its command",
    (helper) => {
      const { lookup, argsOf } = table({
        40: { ppid: 30, comm: "/bin/zsh", args: "/bin/zsh -lc tacho hook" },
        30: { ppid: 20, comm: helper, args: helper },
        20: { ppid: 10, comm: "bash", args: "bash" },
        10: { ppid: 1, comm: "zsh", args: "zsh" },
      });
      expect(codexHarnessPid(40, "linux", lookup, argsOf)).toBeUndefined();
    },
  );

  it.each(["exec-server", "mcp-server", "mcp", "proto"])(
    "gives no pid under codex %s, which serves many sessions",
    (mode) => {
      const { lookup, argsOf } = table({
        30: { ppid: 20, comm: "sh", args: "sh -lc tacho hook" },
        20: { ppid: 1, comm: "codex", args: `codex ${mode}` },
      });
      expect(codexHarnessPid(30, "linux", lookup, argsOf)).toBeUndefined();
    },
  );

  it("stops once the walk runs past its budget, and bounds each ps call by what is left", () => {
    const { lookup, argsOf } = table(TUI);
    let clock = 0;
    const timeouts: Array<number | undefined> = [];
    // Each `ps` call takes 300 ms, so the budget runs out before the walk
    // reaches Codex two hops up.
    const slow = (pid: number, timeoutMs?: number) => {
      timeouts.push(timeoutMs);
      clock += 300;
      return lookup(pid);
    };
    expect(
      codexHarnessPid(300, "darwin", slow, argsOf, () => clock),
    ).toBeUndefined();
    expect(timeouts).toEqual([WALK_BUDGET_MS, WALK_BUDGET_MS - 300]);
  });

  it("gives no pid when no ancestor within reach is Codex", () => {
    const { lookup, argsOf } = table({
      50: { ppid: 40, comm: "bash" },
      40: { ppid: 30, comm: "node" },
      30: { ppid: 20, comm: "bash" },
      20: { ppid: 10, comm: "tmux" },
      10: { ppid: 1, comm: "codex", args: "codex" },
    });
    expect(codexHarnessPid(50, "linux", lookup, argsOf)).toBeUndefined();
  });

  it("gives no pid when ps cannot answer, rather than guess the parent", () => {
    const { lookup, argsOf } = table({});
    expect(codexHarnessPid(300, "linux", lookup, argsOf)).toBeUndefined();
    const noArgs = table({ 20: { ppid: 1, comm: "codex" } });
    expect(
      codexHarnessPid(20, "linux", noArgs.lookup, noArgs.argsOf),
    ).toBeUndefined();
  });

  it("gives no pid on Windows, which has no ps", () => {
    const { lookup, argsOf } = table(TUI);
    expect(codexHarnessPid(300, "win32", lookup, argsOf)).toBeUndefined();
  });
});
