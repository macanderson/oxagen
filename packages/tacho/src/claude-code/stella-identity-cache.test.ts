/**
 * A Stella hook reads its identity from a cache under `TACHO_HOME`, so most
 * hooks run no `ps` and a transient `ps` failure keeps the chain (H-14, audit
 * #3944). Every Stella hook ran `ps` twice, and a failure of either call
 * changed the session id: the hook landed on a new chain, and a shell pid
 * sent as the harness pid let the sweep seal it as soon as the shell exited.
 * A hook that bash forks has no entry to fall back on, so it finds Stella
 * through `/proc` or `STELLA_PID` instead (#4358), and the instance token
 * comes from a start time a clock step does not move (#4366).
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeHostFile } from "../host/host-file";
import type { Exec } from "../host/service";
import {
  bundleSigner,
  scratchPaths,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import { type postUnix, runTachoHook } from "./hook-client";
import {
  type ProcessInfo,
  processStartInstance,
  resolveStellaIdentity,
  STELLA_IDENTITY_FRESH_MS,
  STELLA_IDENTITY_TRUST_MS,
  STELLA_PS_BUDGET_MS,
  STELLA_PS_FLOOR_MS,
  stellaSessionId,
} from "./stella-adapter";

/**
 * A `ps` double that counts its calls and can be told to fail, and a
 * `/proc` double beside it. The `/proc` one answers only when `proc` is set,
 * as on Linux. Left unset it answers nothing, as on macOS, and a test that
 * passes it never reads the real `/proc` of the machine it runs on.
 */
function fakePs(
  tree: Record<number, ProcessInfo & { start: string }>,
  options: { proc?: boolean } = {},
) {
  const calls = { lookup: 0, startInstance: 0 };
  const failing = { lookup: false, startInstance: false };
  const proc = { answers: options.proc ?? false, calls: 0 };
  const parentOf = (pid: number) => {
    const entry = tree[pid];
    return entry === undefined
      ? undefined
      : { ppid: entry.ppid, comm: entry.comm };
  };
  return {
    calls,
    failing,
    proc,
    lookup: (pid: number) => {
      calls.lookup += 1;
      if (failing.lookup) return undefined;
      return parentOf(pid);
    },
    procLookup: (pid: number) => {
      proc.calls += 1;
      return proc.answers ? parentOf(pid) : undefined;
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

  it("names Stella through a forking shell from /proc on Linux when ps fails (#4358)", () => {
    const ctx = setup();
    Object.assign(ctx.tree, {
      5555: { ppid: 4242, comm: "bash", start: "cccc55556666" },
    });
    ctx.ps.failing.lookup = true;
    ctx.ps.proc.answers = true;
    const identity = resolveStellaIdentity({
      parentPid: 5555,
      platform: "linux",
      cacheDir: ctx.cacheDir,
      now: T0,
      lookup: ctx.ps.lookup,
      procLookup: ctx.ps.procLookup,
      startInstance: ctx.ps.startInstance,
      isAlive: () => true,
    });
    expect(identity).toEqual({ pid: 4242, instance: "aaaa11112222" });
    // `/proc` answered, so `ps` was never asked.
    expect(ctx.ps.calls.lookup).toBe(0);
    expect(existsSync(join(ctx.cacheDir, "5555.json"))).toBe(false);
  });

  it("names the forking shell when ps fails where there is no /proc and no STELLA_PID", () => {
    // macOS today: nothing a forked hook can read without `ps` names Stella,
    // which is why the spec asks Stella to export `STELLA_PID`.
    const ctx = setup();
    Object.assign(ctx.tree, {
      5555: { ppid: 4242, comm: "bash", start: "cccc55556666" },
    });
    ctx.ps.failing.lookup = true;
    expect(resolve(ctx, T0, 5555)).toEqual({
      pid: 5555,
      instance: "cccc55556666",
    });
  });

  it("takes the pid Stella exports, so a forking shell cannot stand in for it when ps fails", () => {
    const ctx = setup();
    Object.assign(ctx.tree, {
      5555: { ppid: 4242, comm: "bash", start: "cccc55556666" },
      5556: { ppid: 4242, comm: "bash", start: "dddd55556666" },
    });
    ctx.ps.failing.lookup = true;
    const hook = (shell: number, now: number) =>
      resolveStellaIdentity({
        parentPid: shell,
        exportedPid: 4242,
        platform: "darwin",
        cacheDir: ctx.cacheDir,
        now,
        lookup: ctx.ps.lookup,
        startInstance: ctx.ps.startInstance,
        isAlive: () => true,
      });
    expect(hook(5555, T0)).toEqual({ pid: 4242, instance: "aaaa11112222" });
    expect(ctx.ps.calls).toEqual({ lookup: 0, startInstance: 1 });
    // The entry is keyed by Stella, so the next hook's new shell finds it.
    expect(existsSync(join(ctx.cacheDir, "4242.json"))).toBe(true);
    expect(hook(5556, T0 + 5_000)).toEqual({
      pid: 4242,
      instance: "aaaa11112222",
    });
    expect(ctx.ps.calls).toEqual({ lookup: 0, startInstance: 1 });
  });

  it("ignores an exported pid that names no live process", () => {
    const ctx = setup();
    const identity = resolveStellaIdentity({
      parentPid: 4242,
      exportedPid: 9999,
      platform: "darwin",
      cacheDir: ctx.cacheDir,
      now: T0,
      lookup: ctx.ps.lookup,
      startInstance: ctx.ps.startInstance,
      isAlive: (pid) => pid !== 9999,
    });
    expect(identity).toEqual({ pid: 4242, instance: "aaaa11112222" });
  });

  it("keeps a live run's session id across the change to how the instance token is built", () => {
    const ctx = setup();
    // An entry as `tacho-hook` wrote it before #4366: its instance is the
    // `ps -o lstart=` token, and it has no check.
    mkdirSync(ctx.cacheDir, { recursive: true });
    writeFileSync(
      join(ctx.cacheDir, "4242.json"),
      JSON.stringify({
        schema: "tacho.stella-identity.v1",
        pid: 4242,
        instance: "01d157a27000",
        confirmed_at: T0,
      }),
    );
    let legacyReads = 0;
    const hook = (now: number, legacy: string) =>
      resolveStellaIdentity({
        parentPid: 4242,
        platform: "darwin",
        cacheDir: ctx.cacheDir,
        now,
        lookup: ctx.ps.lookup,
        startInstance: ctx.ps.startInstance,
        legacyStartInstance: () => {
          legacyReads += 1;
          return legacy;
        },
        isAlive: () => true,
      });
    const later = T0 + STELLA_IDENTITY_FRESH_MS + 1;
    expect(hook(later, "01d157a27000")).toEqual({
      pid: 4242,
      instance: "01d157a27000",
    });
    expect(legacyReads).toBe(1);
    // The entry now carries the new token, so the next check needs no read
    // made the old way.
    expect(hook(later + STELLA_IDENTITY_FRESH_MS + 1, "unused")).toEqual({
      pid: 4242,
      instance: "01d157a27000",
    });
    expect(legacyReads).toBe(1);
  });

  it("looks up afresh when an old entry's process is not the one the old read finds", () => {
    const ctx = setup();
    mkdirSync(ctx.cacheDir, { recursive: true });
    writeFileSync(
      join(ctx.cacheDir, "4242.json"),
      JSON.stringify({
        schema: "tacho.stella-identity.v1",
        pid: 4242,
        instance: "01d157a27000",
        confirmed_at: T0,
      }),
    );
    // The pid now names a process that started at another time.
    const identity = resolveStellaIdentity({
      parentPid: 4242,
      platform: "darwin",
      cacheDir: ctx.cacheDir,
      now: T0 + STELLA_IDENTITY_FRESH_MS + 1,
      lookup: ctx.ps.lookup,
      startInstance: ctx.ps.startInstance,
      legacyStartInstance: () => "0f4e27000000",
      isAlive: () => true,
    });
    expect(identity).toEqual({ pid: 4242, instance: "aaaa11112222" });
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
        stellaPs: {
          lookup: ps.lookup,
          procLookup: ps.procLookup,
          startInstance: ps.startInstance,
        },
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

  /** Run one Stella hook and return the session id and harness pid it posted. */
  async function postedIdentity(
    options: Omit<Parameters<typeof runTachoHook>[0], "post" | "stdin">,
  ): Promise<Array<{ session: string; pid: string | undefined }>> {
    const sent: Array<{ session: string; pid: string | undefined }> = [];
    await runTachoHook({
      ...options,
      stdin: STOP,
      post: async (post: Parameters<typeof postUnix>[0]) => {
        const body = JSON.parse(post.body) as {
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
    return sent;
  }

  it("names the Stella process, not a forking shell, when ps fails on Linux (#4358)", async () => {
    const stella = 4242;
    const ps = fakePs(
      {
        [process.ppid]: { ppid: stella, comm: "bash", start: "cccc55556666" },
        [stella]: { ppid: 1, comm: "stella", start: "eeee99990000" },
      },
      { proc: true },
    );
    ps.failing.lookup = true;
    const sent = await postedIdentity({
      paths: enrolledPaths(),
      env: {},
      harness: "stella",
      platform: "linux",
      now: () => T0,
      stellaPs: {
        lookup: ps.lookup,
        procLookup: ps.procLookup,
        startInstance: ps.startInstance,
      },
    });
    expect(sent).toEqual([
      { session: `stella-${stella}-eeee99990000`, pid: String(stella) },
    ]);
    expect(ps.calls.lookup).toBe(0);
  });

  it("names the Stella process from STELLA_PID, not a forking shell, when ps fails (#4358)", async () => {
    // STELLA_PID must name a live process, and this one is alive for the
    // whole test.
    const stella = process.pid;
    const ps = fakePs({
      [process.ppid]: { ppid: stella, comm: "bash", start: "cccc55556666" },
      [stella]: { ppid: 1, comm: "stella", start: "eeee99990000" },
    });
    ps.failing.lookup = true;
    const sent = await postedIdentity({
      paths: enrolledPaths(),
      env: { STELLA_PID: String(stella) },
      harness: "stella",
      platform: "darwin",
      now: () => T0,
      stellaPs: {
        lookup: ps.lookup,
        procLookup: ps.procLookup,
        startInstance: ps.startInstance,
      },
    });
    expect(sent).toEqual([
      { session: `stella-${stella}-eeee99990000`, pid: String(stella) },
    ]);
    expect(ps.calls.lookup).toBe(0);
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
        stellaPs: {
          lookup: ps.lookup,
          procLookup: ps.procLookup,
          startInstance: ps.startInstance,
        },
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
      stellaPs: {
        lookup: ps.lookup,
        procLookup: ps.procLookup,
        startInstance: ps.startInstance,
      },
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
      stellaPs: {
        lookup: ps.lookup,
        procLookup: ps.procLookup,
        startInstance: ps.startInstance,
      },
    });
    expect(result.path).toBe("unenrolled");
    expect(ps.calls).toEqual({ lookup: 0, startInstance: 0 });
    expect(ps.proc.calls).toBe(0);
  });
});

describe("the Stella instance token", () => {
  const BOOT = "9f0c2b7e-51a4-4a4e-8d0b-3c1e7f2a6b90";
  /** A `/proc/<pid>/stat` line with `ticks` in field 22. */
  const stat = (pid: number, ticks: number) =>
    `${pid} (stella) S 1 ${pid} ${pid} 0 -1 4194560 100 0 0 0 5 3 0 0 20 0 4 0 ${ticks} 12345678 900 18446744073709551615\n`;
  const files: Record<string, string> = {
    "/proc/sys/kernel/random/boot_id": `${BOOT}\n`,
    "/proc/4242/stat": stat(4242, 98765),
  };
  const read = (path: string) => files[path];

  /**
   * `ps -o pid=,lstart=` for one process, answered once before and once
   * after a wall-clock step. procps prints `lstart` as the boot time plus the
   * start ticks, and the kernel moves the boot time on a step, so the same
   * process prints two start times.
   */
  function steppingPs() {
    const answers = [
      "4242 Fri Sep 25 09:00:00 2026\n",
      "4242 Fri Sep 25 09:00:07 2026\n",
    ];
    const calls = { count: 0 };
    const exec: Exec = () => {
      const stdout = answers[calls.count % answers.length] ?? "";
      calls.count += 1;
      return { status: 0, stdout, stderr: "" };
    };
    return { exec, calls };
  }

  it("gives one Stella process one session id on Linux across a clock step (#4366)", () => {
    const ps = steppingPs();
    const cacheDir = join(mkdtempSync(join(tmpdir(), "tacho-")), "ids");
    // A forking shell on every hook, so nothing is cached and each hook
    // reads Stella's start time again.
    const hook = (shell: number) =>
      resolveStellaIdentity({
        parentPid: shell,
        platform: "linux",
        cacheDir,
        now: T0,
        lookup: () => undefined,
        procLookup: (pid) =>
          pid === 4242
            ? { ppid: 1, comm: "stella" }
            : { ppid: 4242, comm: "bash" },
        startInstance: (pid, timeoutMs) =>
          processStartInstance(pid, timeoutMs, "linux", ps.exec, read),
        isAlive: () => true,
      });
    const first = hook(5555);
    const second = hook(5556);
    expect(first.pid).toBe(4242);
    expect(first.instance).toMatch(/^[0-9a-f]{12}$/);
    expect(stellaSessionId(second.pid, second.instance)).toBe(
      stellaSessionId(first.pid, first.instance),
    );
    // The token came from `/proc`, and no `ps` ran.
    expect(ps.calls.count).toBe(0);
  });

  it("reads ps off Linux, so there the token follows what ps prints", () => {
    const ps = steppingPs();
    const first = processStartInstance(4242, 500, "darwin", ps.exec, read);
    const second = processStartInstance(4242, 500, "darwin", ps.exec, read);
    expect(ps.calls.count).toBe(2);
    expect(first).toMatch(/^[0-9a-f]{12}$/);
    expect(second).not.toBe(first);
    // Windows has neither `/proc` nor `ps`.
    expect(
      processStartInstance(4242, 500, "win32", ps.exec, read),
    ).toBeUndefined();
    expect(ps.calls.count).toBe(2);
  });
});
