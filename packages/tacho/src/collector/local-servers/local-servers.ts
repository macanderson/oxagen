/**
 * The local gateway's side of local servers (mcp-studio-spec, Local
 * servers).
 *
 * The gateway pulls each delivery from the cloud gateway, runs it, and posts
 * one reply. A call runs only when its envelope verifies, its launch matches
 * the lock, and the package on this machine has the digest the lock pins.
 * Its result passes the sensitive-data screen before it leaves the machine.
 *
 * When the cloud gateway cannot be reached, nothing runs. A pull that fails
 * logs the spec's sentence and backs off. A reply that fails to post is
 * dropped, because the agent that asked has stopped waiting, and the cloud
 * gateway refuses the call on its side.
 */
import { createNonceLedger, type NonceLedger } from "./nonces";
import { DEFAULT_CLOCK_SKEW_MS, verifyCallDelivery } from "./envelope";
import {
  cloudUnreachable,
  digestMismatch,
  LocalServerError,
  refusalText,
  serverFailed,
  type LocalServerRefusal,
} from "./errors";
import { prepareLaunch, type MachineEnv, type PreparedLaunch } from "./launch";
import type { PackageDigester } from "./digest";
import { callTool, listTools, type StdioSpawn } from "./stdio-client";
import { screenResult } from "./screen";
import type { CloudLink } from "./cloud-link";
import {
  DEFAULT_DEADLINE_MS,
  deliveryId,
  type CallDelivery,
  type Delivery,
  type DiscoverDelivery,
  type LaunchSpec,
  type Reply,
} from "./wire";

/** How many deliveries run at once when the options name no limit. */
export const DEFAULT_MAX_CONCURRENT = 4;

/** The first wait after a failed pull. Each failure after it doubles the wait. */
export const DEFAULT_BACKOFF_INITIAL_MS = 1_000;

/** The longest wait between failed pulls. */
export const DEFAULT_BACKOFF_MAX_MS = 60_000;

/** The longest refusal message the reply schema holds. */
const REFUSAL_MESSAGE_CHARS = 2048;

export interface LocalServersOptions {
  /** This machine's id: the host file's host_enrollment_id. */
  machine: string;
  /** The key the cloud gateway signs envelopes with, from the host file's bundle_public_key_pem. */
  publicKeyPem: string;
  link: CloudLink;
  spawn: StdioSpawn;
  /** The environment the local gateway started with. */
  env: MachineEnv;
  digester: PackageDigester;
  log(line: string): void;
  /** The time now, in epoch milliseconds. Defaults to Date.now. */
  now?: () => number;
  maxConcurrent?: number;
  skewMs?: number;
  nonces?: NonceLedger;
  backoff?: { initialMs: number; maxMs: number };
  /** Waits between failed pulls. Defaults to abortableSleep. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface LocalServers {
  /** Run one delivery and return the reply for it. Never throws. */
  handle(delivery: Delivery, signal?: AbortSignal): Promise<Reply>;
  /** Start pulling deliveries. A second start while running does nothing. */
  start(): void;
  /** Stop pulling, then wait for every delivery in flight to post its reply. */
  stop(): Promise<void>;
}

/** Wait `ms`, or less when the signal aborts first. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What went wrong on a cloud request: the link's detail when it gave one. */
function cloudDetail(error: unknown): string {
  return error instanceof Error && typeof error.cause === "string" ? error.cause : errorText(error);
}

export function createLocalServers(options: LocalServersOptions): LocalServers {
  const now = options.now ?? Date.now;
  const skewMs = options.skewMs ?? DEFAULT_CLOCK_SKEW_MS;
  const nonces = options.nonces ?? createNonceLedger({ skewMs });
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
  const backoff = options.backoff ?? { initialMs: DEFAULT_BACKOFF_INITIAL_MS, maxMs: DEFAULT_BACKOFF_MAX_MS };
  const sleep = options.sleep ?? abortableSleep;
  const inFlight = new Set<Promise<void>>();
  let running: { controller: AbortController; loop: Promise<void> } | undefined;

  function refused(id: string, refusal: LocalServerRefusal): Reply {
    options.log(`The local gateway refused ${id}. ${refusalText(refusal)}`);
    return {
      kind: "refused",
      id,
      machine: options.machine,
      refusal: { ...refusal, message: refusal.message.slice(0, REFUSAL_MESSAGE_CHARS) },
    };
  }

  /** Prepare the launch and check the package on this machine against the lock. */
  async function launchFor(spec: LaunchSpec, signal: AbortSignal | undefined): Promise<PreparedLaunch> {
    const prepared = prepareLaunch(spec, options.env);
    if (!prepared.ok) throw new LocalServerError(prepared.refusal);
    const digest = await options.digester.digest(prepared.launch.package, prepared.launch, signal);
    if (digest !== prepared.launch.package.digest) throw new LocalServerError(digestMismatch());
    return prepared.launch;
  }

  async function runCall(delivery: CallDelivery, signal: AbortSignal | undefined): Promise<Reply> {
    const { envelope } = delivery;
    const check = verifyCallDelivery(delivery, {
      machine: options.machine,
      publicKeyPem: options.publicKeyPem,
      nonces,
      now: now(),
      skewMs,
    });
    if (!check.ok) return refused(envelope.nonce, check.refusal);
    const launch = await launchFor(delivery.launch, signal);
    let toolsChanged = false;
    const result = await callTool(
      {
        spawn: options.spawn,
        launch,
        deadlineMs: envelope.deadline_ms ?? DEFAULT_DEADLINE_MS,
        signal,
        onToolsChanged: () => {
          toolsChanged = true;
        },
      },
      envelope.upstream,
      delivery.arguments,
    );
    const screened = screenResult(result);
    return {
      kind: "result",
      id: envelope.nonce,
      machine: options.machine,
      result: screened.result,
      redactions: screened.redactions,
      ...(toolsChanged ? { tools_changed: true as const } : {}),
    };
  }

  async function runDiscover(delivery: DiscoverDelivery, signal: AbortSignal | undefined): Promise<Reply> {
    const launch = await launchFor(delivery.launch, signal);
    const listed = await listTools({ spawn: options.spawn, launch, deadlineMs: delivery.deadline_ms, signal });
    return {
      kind: "tools",
      id: delivery.id,
      machine: options.machine,
      server: launch.server,
      ...(listed.serverVersion === undefined ? {} : { server_version: listed.serverVersion }),
      tools: listed.tools,
      reported_at: new Date(now()).toISOString(),
    };
  }

  async function handle(delivery: Delivery, signal?: AbortSignal): Promise<Reply> {
    const id = deliveryId(delivery);
    try {
      return delivery.kind === "call" ? await runCall(delivery, signal) : await runDiscover(delivery, signal);
    } catch (error) {
      if (error instanceof LocalServerError) return refused(id, error.refusal());
      return refused(
        id,
        serverFailed(delivery.launch.server, `the local gateway hit an unexpected error (${errorText(error)})`),
      );
    }
  }

  async function deliver(delivery: Delivery, signal: AbortSignal): Promise<void> {
    const reply = await handle(delivery, signal);
    try {
      await options.link.reply(reply);
    } catch (error) {
      options.log(
        `${refusalText(cloudUnreachable())} The local gateway dropped its reply to ${reply.id} (${cloudDetail(error)}).`,
      );
    }
  }

  async function pump(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      if (inFlight.size >= maxConcurrent) {
        await Promise.race(inFlight);
        continue;
      }
      let delivery: Delivery | undefined;
      try {
        delivery = await options.link.next(signal);
      } catch (error) {
        if (signal.aborted) return;
        failures += 1;
        options.log(`${refusalText(cloudUnreachable())} The pull failed (${cloudDetail(error)}).`);
        await sleep(Math.min(backoff.initialMs * 2 ** (failures - 1), backoff.maxMs), signal);
        continue;
      }
      failures = 0;
      if (delivery === undefined) continue;
      const task: Promise<void> = deliver(delivery, signal).finally(() => inFlight.delete(task));
      inFlight.add(task);
    }
  }

  return {
    handle,
    start() {
      if (running !== undefined) return;
      const controller = new AbortController();
      running = { controller, loop: pump(controller.signal) };
    },
    async stop() {
      if (running === undefined) return;
      const { controller, loop } = running;
      running = undefined;
      controller.abort();
      await loop;
      await Promise.all(inFlight);
    },
  };
}
