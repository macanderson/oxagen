// broker.ts: hands signed deliveries to a machine's local gateway and waits
// for its reply (mcp-studio-spec, Local servers).
//
// The local gateway long-polls with next() and answers with reply(). The
// cloud gateway calls dispatch() and waits. A machine that has not polled
// recently is not connected, and a call to it fails at once: no call waits
// for a machine that may never come back, and no machine runs a call later
// from a queue. There is no offline mode.
//
// reply() settles a dispatch by the delivery's id and then forgets the id,
// so a second reply with the same id is refused. That is the cloud side's
// replay check. The local gateway keeps its own ledger of nonces.
//
// A poll whose machine hangs up before the route writes the delivery gives
// it back with release(), and the machine's next poll takes it.
//
// This broker lives in one process, so the instance that holds a machine's
// long-poll must be the one that dispatches to it. #4773 chose one instance
// over a shared queue: apps/mcp serves both the routes and the served-tools
// call path, production runs it as one container on one node, and
// tools/scripts/mcp-single-instance.test.ts fails when that changes. A second
// instance needs a shared queue first.
import { TransportError } from "@oxagen/mcp-studio";
import {
  deliveryId,
  replySchema,
  type Delivery,
  type Reply,
} from "@oxagen/tacho/local-servers";

/** The two routes a machine's local gateway dials. tacho's cloud link names them, and apps/mcp serves them. */
export { LOCAL_SERVERS_NEXT_PATH, LOCAL_SERVERS_REPLY_PATH } from "@oxagen/tacho/local-servers";

/** How long a long-poll waits for a delivery before it returns none. */
export const LONG_POLL_WAIT_MS = 25_000;

/** A machine counts as connected for this long after its last poll ends. */
export const PRESENCE_MS = 10_000;

export interface DispatchOptions {
  signal: AbortSignal;
  /** Epoch ms. A delivery no machine took by then fails as disconnected: the envelope's expires_at. */
  pickupBy: number;
  /** How long to wait for the reply once the machine took the delivery. */
  replyWithinMs: number;
}

/** Why the broker refused a reply. The route answers 409 for each. */
export type ReplyRefusal = "invalid" | "wrong_machine" | "unknown_id" | "wrong_kind";

export type ReplyOutcome =
  | {
      accepted: true;
      /**
       * The server whose call reported notifications/tools/list_changed, so
       * the caller asks for its discovery (#4772). Absent otherwise.
       */
      toolsChanged?: { server: string };
    }
  | { accepted: false; reason: ReplyRefusal };

export interface LocalGatewayBroker {
  /** True while the machine's local gateway polls, or within PRESENCE_MS of its last poll. */
  connected(machine: string): boolean;
  /** Hand one delivery to the machine and wait for its reply. Throws TransportError. */
  dispatch(machine: string, delivery: Delivery, options: DispatchOptions): Promise<Reply>;
  /** The machine's long-poll: the next delivery, or undefined when none came within waitMs. */
  next(machine: string, signal: AbortSignal, waitMs?: number): Promise<Delivery | undefined>;
  /** Settle a dispatch with the machine's reply. The body is untrusted, so it is parsed here. */
  reply(machine: string, body: unknown): ReplyOutcome;
}

/** The broker the long-poll route holds. It can also take back a delivery the route could not write. */
export interface LongPollBroker extends LocalGatewayBroker {
  /**
   * Take back a delivery a poll took but never wrote, because the machine hung
   * up first. It goes to a poll that waits, or to the front of the machine's
   * queue, and its pickup clock runs again. False when no call with that id
   * waits for this machine's reply.
   */
  release(machine: string, delivery: Delivery): boolean;
}

export interface InProcessBrokerOptions {
  now?: () => number;
  presenceMs?: number;
}

interface Pending {
  machine: string;
  delivery: Delivery;
  taken: boolean;
  settle(outcome: { reply: Reply } | { error: TransportError }): void;
  pickupBy: number;
  replyWithinMs: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

interface Waiter {
  take(delivery: Delivery | undefined): void;
}

interface MachineState {
  queue: string[];
  waiters: Waiter[];
  lastSeen: number;
}

function notConnected(machine: string): TransportError {
  return new TransportError(
    "disconnected",
    `The local gateway on machine ${machine} is not connected. Start the local gateway on that machine, then retry.`,
    false,
  );
}

function kindFits(delivery: Delivery, reply: Reply): boolean {
  if (reply.kind === "refused") return true;
  return delivery.kind === "call" ? reply.kind === "result" : reply.kind === "tools";
}

export function createInProcessBroker(options: InProcessBrokerOptions = {}): LongPollBroker {
  const now = options.now ?? Date.now;
  const presenceMs = options.presenceMs ?? PRESENCE_MS;
  const machines = new Map<string, MachineState>();
  const pending = new Map<string, Pending>();

  function stateOf(machine: string): MachineState {
    let state = machines.get(machine);
    if (state === undefined) {
      state = { queue: [], waiters: [], lastSeen: Number.NEGATIVE_INFINITY };
      machines.set(machine, state);
    }
    return state;
  }

  function connected(machine: string): boolean {
    const state = machines.get(machine);
    if (state === undefined) return false;
    return state.waiters.length > 0 || now() - state.lastSeen <= presenceMs;
  }

  /** The machine took the delivery: stop the pickup clock and start the reply clock. */
  function take(id: string): Delivery {
    const entry = pending.get(id) as Pending;
    entry.taken = true;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.settle({
        error: new TransportError(
          "timeout",
          `The local gateway on machine ${entry.machine} did not answer within ${entry.replyWithinMs} ms.`,
          true,
        ),
      });
    }, entry.replyWithinMs);
    return entry.delivery;
  }

  /**
   * Hand the delivery to a poll that waits, or queue it until one comes. A
   * queued delivery that no poll takes before its envelope expires fails as
   * disconnected. A delivery the route gave back goes to the front.
   */
  function offer(state: MachineState, id: string, entry: Pending, front: boolean): void {
    const waiter = state.waiters.shift();
    if (waiter !== undefined) {
      waiter.take(take(id));
      return;
    }
    if (front) state.queue.unshift(id);
    else state.queue.push(id);
    entry.timer = setTimeout(
      () => {
        entry.settle({
          error: new TransportError(
            "disconnected",
            `The local gateway on machine ${entry.machine} did not take the call before its envelope expired. Check that the local gateway is running and online, then retry.`,
            false,
          ),
        });
      },
      Math.max(0, entry.pickupBy - now()),
    );
  }

  function dispatch(machine: string, delivery: Delivery, dispatchOptions: DispatchOptions): Promise<Reply> {
    if (!connected(machine)) return Promise.reject(notConnected(machine));
    const id = deliveryId(delivery);
    if (pending.has(id)) {
      return Promise.reject(
        new TransportError("not_sent", `A delivery with id ${id} is already waiting for a reply.`, false),
      );
    }
    const { signal } = dispatchOptions;
    if (signal.aborted) {
      return Promise.reject(new TransportError("not_sent", "The call was stopped before it was sent.", false));
    }
    return new Promise<Reply>((resolve, reject) => {
      const state = stateOf(machine);
      const onAbort = (): void => {
        entry.settle({
          error: entry.taken
            ? new TransportError("timeout", "The call was stopped before the local gateway answered it.", true)
            : new TransportError("not_sent", "The call was stopped before it was sent.", false),
        });
      };
      const entry: Pending = {
        machine,
        delivery,
        taken: false,
        pickupBy: dispatchOptions.pickupBy,
        replyWithinMs: dispatchOptions.replyWithinMs,
        timer: undefined,
        settle(outcome) {
          if (pending.get(id) !== entry) return;
          pending.delete(id);
          clearTimeout(entry.timer);
          signal.removeEventListener("abort", onAbort);
          const queued = state.queue.indexOf(id);
          if (queued !== -1) state.queue.splice(queued, 1);
          if ("reply" in outcome) resolve(outcome.reply);
          else reject(outcome.error);
        },
      };
      pending.set(id, entry);
      signal.addEventListener("abort", onAbort, { once: true });
      offer(state, id, entry, false);
    });
  }

  function next(machine: string, signal: AbortSignal, waitMs = LONG_POLL_WAIT_MS): Promise<Delivery | undefined> {
    const state = stateOf(machine);
    state.lastSeen = now();
    // A poll whose machine already hung up takes nothing: a delivery handed
    // to it would be written to nobody.
    if (signal.aborted) return Promise.resolve(undefined);
    const queued = state.queue.shift();
    if (queued !== undefined) return Promise.resolve(take(queued));
    return new Promise((resolve) => {
      const waiter: Waiter = {
        take(delivery) {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          const index = state.waiters.indexOf(waiter);
          if (index !== -1) state.waiters.splice(index, 1);
          state.lastSeen = now();
          resolve(delivery);
        },
      };
      const onAbort = (): void => waiter.take(undefined);
      const timer = setTimeout(() => waiter.take(undefined), waitMs);
      signal.addEventListener("abort", onAbort, { once: true });
      state.waiters.push(waiter);
    });
  }

  function reply(machine: string, body: unknown): ReplyOutcome {
    const parsed = replySchema.safeParse(body);
    if (!parsed.success) return { accepted: false, reason: "invalid" };
    const answer = parsed.data;
    if (answer.machine !== machine) return { accepted: false, reason: "wrong_machine" };
    const entry = pending.get(answer.id);
    if (entry === undefined || entry.machine !== machine || !entry.taken) {
      return { accepted: false, reason: "unknown_id" };
    }
    if (!kindFits(entry.delivery, answer)) return { accepted: false, reason: "wrong_kind" };
    entry.settle({ reply: answer });
    // A refused call can carry the notice too: a call to a tool the server
    // just removed fails after the server says its tools changed.
    return (answer.kind === "result" || answer.kind === "refused") && answer.tools_changed === true
      ? { accepted: true, toolsChanged: { server: entry.delivery.launch.server } }
      : { accepted: true };
  }

  function release(machine: string, delivery: Delivery): boolean {
    const id = deliveryId(delivery);
    const entry = pending.get(id);
    if (entry === undefined || entry.machine !== machine || !entry.taken) return false;
    entry.taken = false;
    clearTimeout(entry.timer);
    offer(stateOf(machine), id, entry, true);
    return true;
  }

  return { connected, dispatch, next, reply, release };
}
