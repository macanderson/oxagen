/**
 * A Stella hook reads its identity from a cache under `TACHO_HOME`, so most
 * hooks run no `ps` and a transient `ps` failure keeps the chain (H-14, audit
 * #3944). Every Stella hook ran `ps` twice, and a failure of either call
 * changed the session id: the hook landed on a new chain, and a shell pid
 * sent as the harness pid let the sweep seal it as soon as the shell exited.
 */
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeHostFile } from "../host/host-file";
import {
  bundleSigner,
  scratchPaths,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import { type postUnix, runTachoHook } from "./hook-client";
import {
  type ProcessInfo,
  resolveStellaIdentity,
  STELLA_IDENTITY_FRESH_MS,
  STELLA_IDENTITY_TRUST_MS,
  STELLA_PS_BUDGET_MS,
  STELLA_PS_FLOOR_MS,
} from "./stella-adapter";

/** A `ps` double that counts its calls and can be told to fail. */
function fakePs(tree: Record<number, ProcessInfo & { start: string }>) {
  const calls = { lookup: 0, startInstance: 0 };
  const failing = { lookup: false, startInstance: false };
  return {
    calls,
    failing,
    lookup: (pid: number) => {
      calls.lookup += 1;
      if (failing.lookup) return undefined;
      const entry = tree[pid];
      return entry === undefined
        ? undefined
        : { ppid: entry.ppid, comm: entry.comm };
    },
    startInstance: (pid: number) => {
      calls.startInstance += 1;
      if (failing.startInstance) return undefined;
      return tree[pid]?.start;
    },
  };
}

const T0 = 1_800_000_000_000;

describe("resolveStellaIdentity", () => {
  function setup() {
    const cacheDir = join(mkdtempSync(join(tmpdir(), "tacho-")), "ids");
    const tree = {
      4242: { ppid: 1, comm: "/usr/local/bin/stella", start: "aaaa11112222" },
    };
    return { cacheDir, tree, ps: fakePs(tree) };
  }

  const resolve = (
    ctx: ReturnType<typeof setup>,
    now: number,
    parentPid = 4242,
    event?: string,
  ) =>
    resolveStellaIdentity({
      parentPid,
      platform: "darwin",
      cacheDir: ctx.cacheDir,
      now,
      ...(event !== undefined ? { event } : {}),
      lookup: ctx.ps.lookup,
      startInstance: ctx.ps.startInstance,
      isAlive: () => true,
    });

  it("looks a run's first hook up with ps and caches it", () => {
    const ctx = setup();
    expect(resolve(ctx, T0)).toEqual({ pid: 4242, instance: "aaaa11112222" });
    expect(ctx.ps.calls).toEqual({ lookup: 1, startInstance: 1 });
    expect(existsSync(join(ctx.cacheDir, "4242.json"))).toBe(true);
  });

  it("runs no ps for a hook soon after the last one", () => {
    const ctx = setup();
    resolve(ctx, T0);
    ctx.ps.calls.lookup = 0;
    ctx.ps.calls.startInstance = 0;
    expect(resolve(ctx, T0 + 5_000)).toEqual({
      pid: 4242,
      instance: "aaaa11112222",
    });
    expect(ctx.ps.calls).toEqual({ lookup: 0, startInstance: 0 });
  });

  it("confirms an older entry with one ps call", () => {
    const ctx = setup();
    resolve(ctx, T0);
    ctx.ps.calls.lookup = 0;
    ctx.ps.calls.startInstance = 0;
    const later = T0 + STELLA_IDENTITY_FRESH_MS + 1;
    expect(resolve(ctx, later)).toEqual({
      pid: 4242,
      instance: "aaaa11112222",
    });
    expect(ctx.ps.calls).toEqual({ lookup: 0, startInstance: 1 });
    // The check refreshed the entry, so the next hook runs none.
    expect(resolve(ctx, later + 1_000)).toEqual({
      pid: 4242,
      instance: "aaaa11112222",
    });
    expect(ctx.ps.calls).toEqual({ lookup: 0, startInstance: 1 });
  });

  it("keeps the cached identity when the start-time read fails", () => {
    const ctx = setup();
    resolve(ctx, T0);
    ctx.ps.failing.startInstance = true;
    expect(resolve(ctx, T0 + STELLA_IDENTITY_FRESH_MS * 3)).toEqual({
      pid: 4242,
      instance: "aaaa11112222",
    });
  });

  it("looks up afresh when the start-time read fails on an entry past the trust window", () => {
    const ctx = setup();
    resolve(ctx, T0);
    // Stella exited, and its pid went to a shell forked for another Stella.
    Object.assign(ctx.tree, {
      4242: { ppid: 9000, comm: "bash", start: "bbbb33334444" },
      9000: { ppid: 1, comm: "stella", start: "9999aaaabbbb" },
    });
    // The shell's start-time read fails. The other reads answer.
    const identity = resolveStellaIdentity({
      parentPid: 4242,
      platform: "darwin",
      cacheDir: ctx.cacheDir,
      now: T0 + STELLA_IDENTITY_TRUST_MS + 1,
      lookup: ctx.ps.lookup,
      startInstance: (pid) =>
        pid === 4242 ? undefined : ctx.ps.startInstance(pid),
      isAlive: () => true,
    });
    // The cached identity would have filed the hook on the old run's chain.
    expect(identity).toEqual({ pid: 9000, instance: "9999aaaabbbb" });
  });

  it("keeps the cached identity when the parent lookup fails", () => {
    const ctx = setup();
    resolve(ctx, T0);
    ctx.ps.failing.lookup = true;
    expect(resolve(ctx, T0 + STELLA_IDENTITY_FRESH_MS * 5)).toEqual({
      pid: 4242,
      instance: "aaaa11112222",
    });
  });

  it("looks up afresh when the pid now names a different process", () => {
    const ctx = setup();
    resolve(ctx, T0);
    ctx.tree[4242].start = "bbbb33334444";
    expect(resolve(ctx, T0 + STELLA_IDENTITY_FRESH_MS * 5)).toEqual({
      pid: 4242,
      instance: "bbbb33334444",
    });
    // The new run's entry replaced the old one.
    expect(resolve(ctx, T0 + STELLA_IDENTITY_FRESH_MS * 5 + 1)).toEqual({
      pid: 4242,
      instance: "bbbb33334444",
    });
  });

  it("names Stella through a forking shell and caches nothing for the shell", () => {
    const ctx = setup();
    Object.assign(ctx.tree, {
      5555: { ppid: 4242, comm: "-bash", start: "cccc55556666" },
    });
    expect(resolve(ctx, T0, 5555)).toEqual({
      pid: 4242,
      instance: "aaaa11112222",
    });
    expect(existsSync(join(ctx.cacheDir, "5555.json"))).toBe(false);
  });

  it("reads the start time on a SessionStart even when the entry is fresh", () => {
    const ctx = setup();
    resolve(ctx, T0);
    // Stella exited and a new Stella got the same pid inside the minute.
    ctx.tree[4242].start = "ffff00001111";
    ctx.ps.calls.lookup = 0;
    ctx.ps.calls.startInstance = 0;
    expect(resolve(ctx, T0 + 5_000, 4242, "SessionStart")).toEqual({
      pid: 4242,
      instance: "ffff00001111",
    });
    expect(ctx.ps.calls.startInstance).toBeGreaterThanOrEqual(1);
    // The same start time costs one read and keeps the entry.
    ctx.ps.calls.lookup = 0;
    ctx.ps.calls.startInstance = 0;
    expect(resolve(ctx, T0 + 6_000, 4242, "SessionStart")).toEqual({
      pid: 4242,
      instance: "ffff00001111",
    });
    expect(ctx.ps.calls).toEqual({ lookup: 0, startInstance: 1 });
  });

  it("does not trust the entry on a SessionStart whose start-time read fails", () => {
    const ctx = setup();
    resolve(ctx, T0);
    // Stella exited and a new Stella got the same pid inside the minute.
    ctx.tree[4242].start = "ffff00001111";
    ctx.ps.failing.startInstance = true;
    // The bare pid form starts a new chain; the cached instance would have
    // reopened the old run's chain as a resume.
    expect(resolve(ctx, T0 + 5_000, 4242, "SessionStart")).toEqual({
      pid: 4242,
    });
    // The entry is gone, so the next hook looks the process up again
    // instead of returning to the old run's chain.
    expect(existsSync(join(ctx.cacheDir, "4242.json"))).toBe(false);
    ctx.ps.failing.startInstance = false;
    ctx.ps.calls.lookup = 0;
    expect(resolve(ctx, T0 + 6_000)).toEqual({
      pid: 4242,
      instance: "ffff00001111",
    });
    expect(ctx.ps.calls.lookup).toBe(1);
  });

  it("drops the entry on a SessionStart with a new start time, even when the lookup then fails", () => {
    const ctx = setup();
    resolve(ctx, T0);
    ctx.tree[4242].start = "ffff00001111";
    ctx.ps.failing.lookup = true;
    expect(resolve(ctx, T0 + 5_000, 4242, "SessionStart")).toEqual({
      pid: 4242,
      instance: "ffff00001111",
    });
    expect(existsSync(join(ctx.cacheDir, "4242.json"))).toBe(false);
    // The next hook inside the minute does not get the old instance back.
    ctx.ps.failing.lookup = false;
    ctx.ps.calls.lookup = 0;
    expect(resolve(ctx, T0 + 6_000)).toEqual({
      pid: 4242,
      instance: "ffff00001111",
    });
    expect(ctx.ps.calls.lookup).toBe(1);
  });

  it("gives a ps call at least the floor after a slow one used the shared budget", () => {
    const ctx = setup();
    let clock = 0;
    const timeouts: number[] = [];
    const identity = resolveStellaIdentity({
      parentPid: 4242,
      platform: "darwin",
      cacheDir: ctx.cacheDir,
      now: T0,
      clock: () => clock,
      lookup: (pid, timeoutMs) => {
        timeouts.push(timeoutMs ?? Number.POSITIVE_INFINITY);
        // A slow ps uses the whole budget.
        clock += STELLA_PS_BUDGET_MS;
        return ctx.ps.lookup(pid);
      },
      startInstance: (pid, timeoutMs) => {
        timeouts.push(timeoutMs ?? Number.POSITIVE_INFINITY);
        return ctx.ps.startInstance(pid);
      },
      isAlive: () => true,
    });
    // The lookup got the whole budget, and the start-time read still ran
    // with the floor, so the first hook takes the same id as the next.
    expect(timeouts).toEqual([STELLA_PS_BUDGET_MS, STELLA_PS_FLOOR_MS]);
    expect(identity).toEqual({ pid: 4242, instance: "aaaa11112222" });
  });

  it("removes the entries of Stella processes that have exited", () => {
    const ctx = setup();
    resolve(ctx, T0);
    writeFileSync(join(ctx.cacheDir, "777.json"), "{}");
    resolveStellaIdentity({
      parentPid: 4242,
      platform: "darwin",
      cacheDir: ctx.cacheDir,
      now: T0 + STELLA_IDENTITY_FRESH_MS * 5,
      lookup: ctx.ps.lookup,
      startInstance: () => "dddd77778888",
      isAlive: (pid) => pid !== 777,
    });
    expect(existsSync(join(ctx.cacheDir, "777.json"))).toBe(false);
    expect(existsSync(join(ctx.cacheDir, "4242.json"))).toBe(true);
  });
});

describe("runTachoHook for Stella", () => {
  function enrolledPaths() {
    const paths = scratchPaths();
    const signer = bundleSigner();
    writeHostFile(
      paths.hostFile,
      testHostFile(signer, signer.sign(unsignedBundle())),
    );
    return paths;
  }

  const STOP = JSON.stringify({ event: "Stop", cwd: "/repo" });

  it("keeps one session id and harness pid across hooks when ps fails between them", async () => {
    const paths = enrolledPaths();
    const ps = fakePs({
      [process.ppid]: { ppid: 1, comm: "stella", start: "eeee99990000" },
    });
    let clock = T0;
    const sent: Array<{ session: string; pid: string | undefined }> = [];
    const hook = () =>
      runTachoHook({
        paths,
        env: {},
        stdin: STOP,
        harness: "stella",
        platform: "linux",
        now: () => clock,
        stellaPs: { lookup: ps.lookup, startInstance: ps.startInstance },
        post: async (options: Parameters<typeof postUnix>[0]) => {
          const body = JSON.parse(options.body) as {
            payload: { session_id: string };
            env: Record<string, string>;
          };
          sent.push({
            session: body.payload.session_id,
            pid: body.env["TACHO_HARNESS_PID"],
          });
          return { status: 200, body: "{}" };
        },
      });

    await hook();
    expect(ps.calls).toEqual({ lookup: 1, startInstance: 1 });
    // A warm cache spawns no ps.
    clock += 1_000;
    await hook();
    expect(ps.calls).toEqual({ lookup: 1, startInstance: 1 });
    // Past the fresh window, each ps call fails in turn.
    clock += STELLA_IDENTITY_FRESH_MS * 2;
    ps.failing.startInstance = true;
    await hook();
    ps.failing.startInstance = false;
    ps.failing.lookup = true;
    clock += STELLA_IDENTITY_FRESH_MS * 2;
    await hook();

    expect(sent).toHaveLength(4);
    for (const one of sent)
      expect(one).toEqual({
        session: `stella-${process.ppid}-eeee99990000`,
        pid: String(process.ppid),
      });
  });

  it("passes Stella's event name, so a SessionStart checks a fresh entry", async () => {
    const paths = enrolledPaths();
    const tree = {
      [process.ppid]: { ppid: 1, comm: "stella", start: "eeee99990000" },
    };
    const ps = fakePs(tree);
    const sessions: string[] = [];
    const hook = (stdin: string) =>
      runTachoHook({
        paths,
        env: {},
        stdin,
        harness: "stella",
        platform: "linux",
        now: () => T0,
        stellaPs: { lookup: ps.lookup, startInstance: ps.startInstance },
        post: async (options: Parameters<typeof postUnix>[0]) => {
          sessions.push(
            (JSON.parse(options.body) as { payload: { session_id: string } })
              .payload.session_id,
          );
          return { status: 200, body: "{}" };
        },
      });
    await hook(STOP);
    // A new Stella got the same pid inside the minute.
    tree[process.ppid] = { ppid: 1, comm: "stella", start: "ffff00001111" };
    await hook(JSON.stringify({ event: "SessionStart", cwd: "/repo" }));
    expect(sessions).toEqual([
      `stella-${process.ppid}-eeee99990000`,
      `stella-${process.ppid}-ffff00001111`,
    ]);
  });

  it("keeps the cache under TACHO_HOME at the path unenroll removes", async () => {
    const paths = enrolledPaths();
    const ps = fakePs({
      [process.ppid]: { ppid: 1, comm: "stella", start: "eeee99990000" },
    });
    await runTachoHook({
      paths,
      env: {},
      stdin: STOP,
      harness: "stella",
      platform: "linux",
      stellaPs: { lookup: ps.lookup, startInstance: ps.startInstance },
      post: async () => ({ status: 200, body: "{}" }),
    });
    expect(existsSync(join(paths.stellaIdentity, `${process.ppid}.json`))).toBe(
      true,
    );
  });

  it("runs no ps on a machine that is not enrolled", async () => {
    const ps = fakePs({});
    const result = await runTachoHook({
      paths: scratchPaths(),
      env: {},
      stdin: STOP,
      harness: "stella",
      platform: "linux",
      stellaPs: { lookup: ps.lookup, startInstance: ps.startInstance },
    });
    expect(result.path).toBe("unenrolled");
    expect(ps.calls).toEqual({ lookup: 0, startInstance: 0 });
  });
});
