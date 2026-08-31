/**
 * Sidecar process management.
 *
 * Driven against a fake `spawn` rather than a real binary: what is under test
 * is the pool's own contract — exclusion, the boot environment, respawn after a
 * crash, and that a slot is never leaked — none of which needs a Rust process
 * to exercise. The live boot is the smoke test's job.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import { SidecarPool, StellaBinaryMissingError } from "./sidecar-pool";

const CONFIG = {
  stellaVersion: "0.6.2",
  binaryEnvVar: "STELLA_SERVE_BIN",
  legacyBinaryEnvVar: "STELLA_BIN",
  binaryName: "stella-serve",
  readinessTimeoutMs: 50,
};

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  kill: ReturnType<typeof vi.fn>;
}

/** A `spawn` that reports a bound address on the next tick, like the real one. */
function fakeSpawn(options: { announce?: boolean } = {}) {
  const children: FakeChild[] = [];
  const envs: NodeJS.ProcessEnv[] = [];
  const impl = vi.fn(
    (_bin: string, _args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      envs.push(opts.env);
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null as number | null,
        kill: vi.fn(function (this: FakeChild) {
          this.exitCode = 0;
          this.emit("exit", 0);
          return true;
        }),
      }) as FakeChild;
      children.push(child);
      if (options.announce !== false) {
        setImmediate(() => {
          child.stdout.write(
            `listening on 127.0.0.1:${41000 + children.length}\n`,
          );
        });
      }
      return child;
    },
  );
  return { impl: impl as never, children, envs };
}

function poolWith(spawn: ReturnType<typeof fakeSpawn>, slots = 1) {
  return new SidecarPool({
    slots,
    binaryPath: "/fake/stella-serve",
    config: CONFIG,
    env: {},
    spawnImpl: spawn.impl,
  });
}

describe("SidecarPool", () => {
  test("boots on first acquire, not at construction", async () => {
    const spawn = fakeSpawn();
    const pool = poolWith(spawn);
    expect(pool.running).toBe(0);
    expect(spawn.impl).not.toHaveBeenCalled();

    const lease = await pool.acquire();
    expect(pool.running).toBe(1);
    expect(lease.client.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
    lease.release();
    await pool.shutdown();
  });

  test("binds loopback, sends remote tools, and mints a fresh token per process", async () => {
    const spawn = fakeSpawn();
    const pool = poolWith(spawn, 2);
    const first = await pool.acquire();
    const second = await pool.acquire();

    for (const env of spawn.envs) {
      expect(env.STELLA_SERVE_BIND).toBe("127.0.0.1:0");
      // The engine executes nothing locally; every tool comes back to the host.
      expect(env.STELLA_SERVE_TOOLS).toBe("remote");
      expect(env.STELLA_SERVE_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    }
    // Per process, never shared.
    expect(spawn.envs[0]!.STELLA_SERVE_TOKEN).not.toBe(
      spawn.envs[1]!.STELLA_SERVE_TOKEN,
    );

    first.release();
    second.release();
    await pool.shutdown();
  });

  test("a one-slot pool serializes: the second caller waits for the first", async () => {
    const spawn = fakeSpawn();
    const pool = poolWith(spawn, 1);
    const first = await pool.acquire();

    let secondArrived = false;
    const second = pool.acquire().then((lease) => {
      secondArrived = true;
      return lease;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(secondArrived).toBe(false);

    first.release();
    (await second).release();
    expect(secondArrived).toBe(true);
    // The waiter reused the running sidecar rather than booting another.
    expect(spawn.impl).toHaveBeenCalledTimes(1);
    await pool.shutdown();
  });

  test("releasing twice does not hand the same slot out twice", async () => {
    const spawn = fakeSpawn();
    const pool = poolWith(spawn, 1);
    const lease = await pool.acquire();
    lease.release();
    lease.release();

    const a = await pool.acquire();
    let bArrived = false;
    const b = pool.acquire().then(
      () => {
        bArrived = true;
      },
      () => undefined, // shutdown ends it below; the rejection is expected
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(bArrived).toBe(false);
    await pool.shutdown();
    a.release();
    await b;
  });

  test("respawns a slot whose process died", async () => {
    const spawn = fakeSpawn();
    const pool = poolWith(spawn, 1);
    const first = await pool.acquire();
    first.release();

    spawn.children[0]!.exitCode = 1;
    const second = await pool.acquire();
    expect(spawn.impl).toHaveBeenCalledTimes(2);
    second.release();
    await pool.shutdown();
  });

  test("a sidecar that never reports an address frees its slot instead of wedging it", async () => {
    // A leaked slot permanently shrinks the worker's concurrency, and the
    // symptom points nowhere near the cause.
    const spawn = fakeSpawn({ announce: false });
    const pool = poolWith(spawn, 1);
    await expect(pool.acquire()).rejects.toThrow(
      /did not report a bound address/,
    );
    expect(spawn.children[0]!.kill).toHaveBeenCalledWith("SIGKILL");
    // The slot is usable again.
    await expect(pool.acquire()).rejects.toThrow(
      /did not report a bound address/,
    );
    expect(spawn.impl).toHaveBeenCalledTimes(2);
  });

  test("shutdown never leaves a sidecar respawned behind it", async () => {
    // A turn handed a slot by a release that lands after shutdown began would
    // otherwise boot a fresh `stella-serve` holding a port with nobody left to
    // drive it — an orphan the process exits without reaping.
    const spawn = fakeSpawn();
    const pool = poolWith(spawn, 1);
    const held = await pool.acquire();
    const queued = pool.acquire();

    const shutdown = pool.shutdown();
    held.release(); // hands the slot straight to the queued caller
    await shutdown;

    await expect(queued).rejects.toThrow(/shutting down/);
    expect(spawn.impl).toHaveBeenCalledTimes(1);
    expect(pool.running).toBe(0);
  });

  test("defaults its size to the worker's concurrency", () => {
    expect(
      new SidecarPool({
        config: CONFIG,
        env: { OXAGEN_WORKER_CONCURRENCY: "4" },
      }).size,
    ).toBe(4);
    // One sidecar per slot, so the default matches the worker's own default.
    expect(new SidecarPool({ config: CONFIG, env: {} }).size).toBe(2);
    expect(
      new SidecarPool({
        config: CONFIG,
        env: { OXAGEN_WORKER_CONCURRENCY: "nope" },
      }).size,
    ).toBe(2);
  });

  test("names the missing binary rather than failing obscurely", async () => {
    const pool = new SidecarPool({
      slots: 1,
      config: { ...CONFIG, binaryName: "definitely-not-installed-xyz" },
      env: {},
      spawnImpl: fakeSpawn().impl,
    });
    await expect(pool.acquire()).rejects.toThrow(StellaBinaryMissingError);
  });

  test("shutdown signals every sidecar and refuses further acquires", async () => {
    const spawn = fakeSpawn();
    const pool = poolWith(spawn, 2);
    const a = await pool.acquire();
    const b = await pool.acquire();
    a.release();
    b.release();

    await pool.shutdown();
    for (const child of spawn.children) {
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    }
    expect(pool.running).toBe(0);
    await expect(pool.acquire()).rejects.toThrow(/shutting down/);
  });
});
