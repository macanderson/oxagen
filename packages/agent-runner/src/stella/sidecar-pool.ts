/**
 * Sidecar process management — Phase C item 1 of
 * docs/specs/agent-engine-v2/stella-adoption-plan.md.
 *
 * **One `stella-serve` process per worker slot, never one per worker
 * process.** That is a containment requirement, not a tuning choice. Stella's
 * `docs/spec/serve-surface.md` §"Containment posture" establishes that several
 * of its credential and config knobs are process-global, so two tenants' turns
 * sharing one engine process share that state. A worker running
 * `OXAGEN_WORKER_CONCURRENCY=2` therefore runs two sidecars, and a slot is
 * held for the whole turn — the lease, not the request, is the unit of
 * exclusion.
 *
 * The plan's §8 risk table names the cost of this honestly: it multiplies
 * processes and memory, and the alternative was refused on isolation grounds
 * rather than cost grounds. Measuring it is Phase C work; this module is what
 * there is to measure.
 *
 * ## The three things every spawn sets
 *
 * - `STELLA_SERVE_BIND=127.0.0.1:0` — loopback only, and port 0 so the kernel
 *   picks a free port instead of this code guessing one and flaking. The bound
 *   address is read back off the server's own startup line.
 * - `STELLA_SERVE_TOKEN=<32 random bytes>` — per process, never shared, never
 *   read from ambient config. Every route but `/healthz` requires it.
 * - `STELLA_SERVE_TOOLS=remote` — the engine executes nothing locally; every
 *   tool call comes back to the host. `stella-serve` refuses any other value at
 *   startup, so this is a restatement of its own contract rather than a policy
 *   this module invents.
 */
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  readSidecarConfig,
  resolveStellaBinary,
  StellaSidecarClient,
  type SidecarConfig,
} from "@oxagen/stella-engine-client";

/** An exclusively-held sidecar. Release it, once, when the turn is over. */
export interface SidecarLease {
  readonly client: StellaSidecarClient;
  release(): void;
}

export interface SidecarPoolOptions {
  /** How many sidecars may run at once. Defaults to `OXAGEN_WORKER_CONCURRENCY`, else 2. */
  slots?: number;
  /** Overrides binary discovery; otherwise `resolveStellaBinary` decides. */
  binaryPath?: string;
  config?: SidecarConfig;
  env?: NodeJS.ProcessEnv;
  /** Injection seam for tests — same contract as `child_process.spawn`. */
  spawnImpl?: typeof spawn;
}

/** Raised when no `stella-serve` binary can be found to run. */
export class StellaBinaryMissingError extends Error {
  constructor(envVar: string, binaryName: string) {
    super(
      `no ${binaryName} binary found — set $${envVar} to one, or put it on PATH. ` +
        `The Stella engine cannot run a turn without it.`,
    );
    this.name = "StellaBinaryMissingError";
  }
}

interface Slot {
  child?: ChildProcess;
  client?: StellaSidecarClient;
  busy: boolean;
}

export class SidecarPool {
  private readonly slots: Slot[];
  /**
   * Callers queued behind a busy slot. Each carries its `reject` as well as its
   * `resolve` so shutdown can end them: an `acquire()` that neither resolves
   * nor rejects hangs its turn forever, and a worker draining on SIGTERM would
   * wait on it rather than exiting.
   */
  private readonly waiters: {
    resolve: (slot: Slot) => void;
    reject: (error: Error) => void;
  }[] = [];
  private readonly config: SidecarConfig;
  private readonly options: SidecarPoolOptions;
  private binaryPath?: string;
  private shuttingDown = false;

  constructor(options: SidecarPoolOptions = {}) {
    this.options = options;
    this.config = options.config ?? readSidecarConfig();
    const count = options.slots ?? defaultSlotCount(options.env ?? process.env);
    this.slots = Array.from({ length: count }, () => ({ busy: false }));
  }

  /** How many sidecars this pool will run at once. */
  get size(): number {
    return this.slots.length;
  }

  /** How many are booted right now (a slot spawns lazily, on first use). */
  get running(): number {
    return this.slots.filter((slot) => slot.child !== undefined).length;
  }

  /**
   * Take exclusive hold of a sidecar, waiting for one when all are busy.
   *
   * A slot whose process died since its last use is respawned here rather than
   * resurrected by a background supervisor: a crashed engine has no in-flight
   * turn to preserve, and repairing it at the point of the next acquire means
   * a dead sidecar costs one turn's startup latency instead of a restart loop
   * nobody is watching.
   */
  async acquire(signal?: AbortSignal): Promise<SidecarLease> {
    if (this.shuttingDown) throw new Error("the sidecar pool is shutting down");
    const slot = await this.claimSlot(signal);
    try {
      await this.ensureRunning(slot);
    } catch (error) {
      this.releaseSlot(slot);
      throw error;
    }
    let released = false;
    return {
      client: slot.client!,
      release: () => {
        if (released) return;
        released = true;
        this.releaseSlot(slot);
      },
    };
  }

  /**
   * Stop every sidecar.
   *
   * `SIGTERM` first, because `stella-serve` drains on it; `SIGKILL` only for a
   * process still alive after the grace period. A slot in use is signalled
   * too — a shutdown that waited for in-flight turns would never complete when
   * the thing being shut down is what those turns are blocked on.
   */
  async shutdown(graceMs = 5_000): Promise<void> {
    this.shuttingDown = true;
    // End everyone queued behind a slot before touching the processes. They
    // are waiting for something that is not coming back.
    let waiter = this.waiters.shift();
    while (waiter) {
      waiter.reject(new Error("the sidecar pool is shutting down"));
      waiter = this.waiters.shift();
    }

    // Hold the process references rather than re-reading `slot.child` after
    // the await. A turn that was mid-`acquire` when shutdown began can clear
    // and respawn its slot while we wait — and a shutdown that then read the
    // slot back would either crash on the empty one or, worse, leave the
    // respawned process running with nothing left to drive it.
    const children = this.slots
      .map((slot) => {
        const child = slot.child;
        delete slot.child;
        delete slot.client;
        return child;
      })
      .filter(
        (child): child is ChildProcess =>
          child !== undefined && child.exitCode === null,
      );

    for (const child of children) child.kill("SIGTERM");
    await Promise.all(children.map((child) => waitForExit(child, graceMs)));
    for (const child of children) {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }

  private claimSlot(signal?: AbortSignal): Promise<Slot> {
    const free = this.slots.find((slot) => !slot.busy);
    if (free) {
      free.busy = true;
      return Promise.resolve(free);
    }
    return new Promise<Slot>((resolve, reject) => {
      const waiter = {
        resolve: (slot: Slot): void => {
          signal?.removeEventListener("abort", onAbort);
          resolve(slot);
        },
        reject: (error: Error): void => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      };
      const onAbort = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("aborted while waiting for a Stella sidecar slot"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private releaseSlot(slot: Slot): void {
    const waiter = this.waiters.shift();
    if (waiter && !this.shuttingDown) {
      waiter.resolve(slot); // stays busy — handed straight to the next caller
      return;
    }
    if (waiter) {
      waiter.reject(new Error("the sidecar pool is shutting down"));
    }
    slot.busy = false;
  }

  private async ensureRunning(slot: Slot): Promise<void> {
    if (slot.child && slot.child.exitCode === null && slot.client) return;
    delete slot.child;
    delete slot.client;
    // Re-checked here, not only in `acquire`: a caller can be handed a slot by
    // a release that happened after shutdown began, and spawning then would
    // leave an orphaned `stella-serve` holding a port with nobody to drive it.
    if (this.shuttingDown) {
      throw new Error("the sidecar pool is shutting down");
    }

    const binary = await this.resolveBinary();
    const token = randomBytes(32).toString("hex");
    const spawnFn = this.options.spawnImpl ?? spawn;
    const child = spawnFn(binary, [], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...(this.options.env ?? process.env),
        STELLA_SERVE_BIND: "127.0.0.1:0",
        STELLA_SERVE_TOKEN: token,
        STELLA_SERVE_TOOLS: "remote",
      },
    });

    let baseUrl: string;
    try {
      baseUrl = await readBoundAddress(child, this.config.readinessTimeoutMs);
    } catch (error) {
      child.kill("SIGKILL");
      throw error;
    }

    slot.child = child;
    slot.client = new StellaSidecarClient({ baseUrl, token });
  }

  private async resolveBinary(): Promise<string> {
    if (this.options.binaryPath) return this.options.binaryPath;
    if (this.binaryPath) return this.binaryPath;
    const resolution = await resolveStellaBinary(this.config);
    if (!resolution) {
      throw new StellaBinaryMissingError(
        this.config.binaryEnvVar,
        this.config.binaryName,
      );
    }
    this.binaryPath = resolution.path;
    return this.binaryPath;
  }
}

function defaultSlotCount(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.OXAGEN_WORKER_CONCURRENCY);
  return Number.isInteger(raw) && raw > 0 ? raw : 2;
}

/**
 * Resolve once `stella-serve` reports the address it bound.
 *
 * Reading the address back is what makes port 0 usable: picking a port and
 * hoping it is free is the classic source of flake here, and the kernel
 * already knows a free one.
 */
function readBoundAddress(
  child: ChildProcess,
  timeoutMs: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            `stella-serve did not report a bound address within ${timeoutMs}ms\n` +
              `stdout: ${stdout}\nstderr: ${stderr}`,
          ),
        ),
      );
    }, timeoutMs);
    const finish = (fn: () => void): void => {
      clearTimeout(timer);
      fn();
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const match = /listening on (\S+)/.exec(stdout);
      if (match) finish(() => resolve(`http://${match[1]}`));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code) =>
      finish(() =>
        reject(
          new Error(
            `stella-serve exited with code ${code} during startup\n` +
              `stdout: ${stdout}\nstderr: ${stderr}`,
          ),
        ),
      ),
    );
    child.on("error", (err) => finish(() => reject(err)));
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
