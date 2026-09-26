/**
 * The hook's wait for the daemon ends well before the harness kills the
 * hook, for every event each writer registers (H-13, audit #3944). The wait
 * was a fixed five seconds for every telemetry event, equal to the
 * five-second timeout Codex, Cursor and Stella give those hooks, so a daemon
 * that accepted the connection and never answered got the process killed
 * before it spooled the event.
 */
import { mkdtempSync, readdirSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexHookEntries } from "../host/codex-writer";
import { cursorHookEntries } from "../host/cursor-writer";
import { writeHostFile } from "../host/host-file";
import { tachoHookEntries } from "../host/settings-writer";
import { stellaHookEntries } from "../host/stella-writer";
import {
  bundleSigner,
  scratchPaths,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import type { TachoHarness } from "../wire";
import {
  harnessKillMs,
  type HookRunDeps,
  responseBudgetMs,
  runTachoHook,
} from "./hook-client";

const CONFIG = {
  enrollmentId: "tch_aaaaaaaaaaaaaaaaaaaaaa",
  hookCommand: "/usr/local/bin/tacho hook",
  port: 4318,
  localToken: "token",
};

function enrolledPaths() {
  const paths = scratchPaths();
  const signer = bundleSigner();
  writeHostFile(
    paths.hostFile,
    testHostFile(signer, signer.sign(unsignedBundle())),
  );
  return paths;
}

interface Case {
  harness: TachoHarness;
  event: string;
  killMs: number;
  stdin: string;
}

/** One case per event each writer registers as a command hook, with the timeout it writes. */
function writtenHooks(): Case[] {
  const cases: Case[] = [];
  for (const [event, groups] of Object.entries(tachoHookEntries(CONFIG))) {
    const entry = groups[0]?.hooks[0];
    if (entry?.type !== "command" || entry.timeout === undefined) continue;
    cases.push({
      harness: "claude-code",
      event,
      killMs: entry.timeout * 1_000,
      stdin: JSON.stringify({ session_id: "s", hook_event_name: event }),
    });
  }
  for (const [event, groups] of Object.entries(codexHookEntries(CONFIG)))
    cases.push({
      harness: "codex",
      event,
      killMs: (groups[0]?.hooks[0]?.timeout ?? 0) * 1_000,
      stdin: JSON.stringify({ session_id: "s", hook_event_name: event }),
    });
  for (const [event, entries] of Object.entries(cursorHookEntries(CONFIG)))
    cases.push({
      harness: "cursor",
      event,
      killMs: (entries[0]?.timeout ?? 0) * 1_000,
      stdin: JSON.stringify({
        conversation_id: "conv-1",
        hook_event_name: event,
      }),
    });
  for (const [event, groups] of Object.entries(stellaHookEntries(CONFIG)))
    cases.push({
      harness: "stella",
      event,
      killMs: Number(groups[0]?.hooks[0]?.["timeoutMs"]),
      stdin: JSON.stringify({ event, cwd: "/repo" }),
    });
  return cases;
}

const STELLA_IDENTITY: Partial<HookRunDeps> = {
  harnessPid: () => 4242,
  harnessInstance: () => "c0ffee112233",
};

describe("the daemon response budget", () => {
  const cases = writtenHooks();

  it("covers every harness the writers register hooks for", () => {
    expect(new Set(cases.map((c) => c.harness))).toEqual(
      new Set(["claude-code", "codex", "cursor", "stella"]),
    );
    expect(cases.every((c) => c.killMs > 0)).toBe(true);
  });

  it.each(cases.map((c) => [c.harness, c.event, c] as const))(
    "%s %s: reads the timeout its writer registers, and waits for the daemon well under it",
    async (_harness, _event, c) => {
      // A Cursor timeout is read by Cursor's own event name.
      expect(
        harnessKillMs(
          c.harness,
          c.event,
          c.harness === "cursor" ? c.event : undefined,
        ),
      ).toBe(c.killMs);
      const paths = enrolledPaths();
      const budgets: number[] = [];
      const result = await runTachoHook({
        paths,
        env: {},
        stdin: c.stdin,
        harness: c.harness,
        platform: "linux",
        ...(c.harness === "stella" ? STELLA_IDENTITY : {}),
        post: async (options) => {
          budgets.push(options.responseTimeoutMs);
          throw new Error("response timeout");
        },
      });
      expect(budgets).toHaveLength(1);
      const budget = budgets[0] as number;
      // At least half the timeout, or five seconds, is left after the wait.
      expect(c.killMs - budget).toBeGreaterThanOrEqual(
        Math.min(5_000, c.killMs / 2),
      );
      // A daemon that never answers still leaves the event on the spool.
      expect(result.path).toBe("local");
      expect(readdirSync(paths.spool)).toHaveLength(1);
    },
  );

  it("takes the time this process already spent off the budget, down to a floor", () => {
    expect(responseBudgetMs(5_000)).toBe(2_500);
    expect(responseBudgetMs(5_000, 2_000)).toBe(500);
    expect(responseBudgetMs(5_000, 4_900)).toBe(100);
    expect(responseBudgetMs(10_000, 300)).toBe(4_700);
    expect(responseBudgetMs(600_000)).toBe(595_000);
  });

  it("gives the same event a different budget on a harness with a shorter timeout", () => {
    expect(responseBudgetMs(harnessKillMs("claude-code", "SessionEnd"))).toBe(
      5_000,
    );
    expect(responseBudgetMs(harnessKillMs("codex", "SessionEnd"))).toBe(2_500);
    expect(
      responseBudgetMs(harnessKillMs("cursor", "SessionEnd", "sessionEnd")),
    ).toBe(2_500);
  });
});

describe("a daemon that accepts the connection and never answers", () => {
  const servers: Server[] = [];
  const sockets: Socket[] = [];
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy();
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise((resolve) => server.close(resolve))),
    );
  });

  /** The hooks whose five-second timeout the old fixed wait equalled. */
  const stalled = writtenHooks().filter(
    (c) =>
      (c.harness === "codex" && c.event === "PostToolUse") ||
      (c.harness === "cursor" &&
        (c.event === "postToolUse" || c.event === "sessionEnd")) ||
      (c.harness === "stella" &&
        (c.event === "PostToolUse" || c.event === "SubagentStop")),
  );

  it("covers a telemetry hook and a session end on every harness with a five-second timeout", () => {
    expect(stalled.map((c) => `${c.harness} ${c.event}`).sort()).toEqual([
      "codex PostToolUse",
      "cursor postToolUse",
      "cursor sessionEnd",
      "stella PostToolUse",
      "stella SubagentStop",
    ]);
    expect(stalled.every((c) => c.killMs === 5_000)).toBe(true);
  });

  it.each(stalled.map((c) => [c.harness, c.event, c] as const))(
    "%s %s: spools before the harness timeout, counting the time already spent",
    async (_harness, _event, c) => {
      const socketPath = join(mkdtempSync("/tmp/tacho-"), "d.sock");
      const server = createServer((socket) => {
        // Read the request and never answer it.
        sockets.push(socket);
        socket.on("data", () => {});
      });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      const paths = { ...enrolledPaths(), socket: socketPath };
      // Node's start-up, stdin and a slow `ps` have already taken 2.3 s.
      const spent = 2_300;
      const started = Date.now();
      const result = await runTachoHook({
        paths,
        env: {},
        stdin: c.stdin,
        harness: c.harness,
        platform: "linux",
        ...(c.harness === "stella" ? STELLA_IDENTITY : {}),
        elapsedMs: () => spent + (Date.now() - started),
      });
      const took = Date.now() - started;
      expect(result.path).toBe("local");
      expect(result.stderr).toContain("response timeout");
      expect(readdirSync(paths.spool)).toHaveLength(1);
      expect(spent + took).toBeLessThan(c.killMs);
    },
  );
});
