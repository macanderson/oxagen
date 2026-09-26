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
  ) =>
    resolveStellaIdentity({
      parentPid,
      platform: "darwin",
      cacheDir: ctx.cacheDir,
      now,
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
    expect(resolve(ctx, T0 + STELLA_IDENTITY_FRESH_MS * 5)).toEqual({
      pid: 4242,
      instance: "aaaa11112222",
    });
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
