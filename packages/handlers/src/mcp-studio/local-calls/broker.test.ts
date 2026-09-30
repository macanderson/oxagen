// broker.test.ts: the in-process broker between the cloud gateway's
// dispatch and a machine's long-poll. A machine that is not polling gets no
// call, and each delivery settles once.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TransportError } from "@oxagen/mcp-studio";
import { digestMismatch, type Delivery } from "@oxagen/tacho/local-servers";
import {
  createInProcessBroker,
  LONG_POLL_WAIT_MS,
  PRESENCE_MS,
  type LocalGatewayBroker,
  type LongPollBroker,
} from "./broker";
import { newNonce, signLocalCall } from "./envelope";
import { DEFINITION_HASH, FILES_DIGEST, FILES_LAUNCH, MACHINE, testSigner } from "./test-support";

const OTHER = "tch_desktop02";
const signer = testSigner();

function callDelivery(machine = MACHINE): Delivery {
  const args = { path: "notes/today.md" };
  const envelope = signLocalCall({
    call: {
      tool: "files__read_file",
      upstream: "read_file",
      version: 1,
      definition_hash: DEFINITION_HASH,
      package_digest: FILES_DIGEST,
      arguments: args,
      deadline_ms: 5_000,
    },
    machine,
    signer,
    now: new Date(Date.now()),
  });
  return { kind: "call", envelope, arguments: args, launch: FILES_LAUNCH };
}

function discoverDelivery(): Delivery {
  return { kind: "discover", id: newNonce(), launch: FILES_LAUNCH, deadline_ms: 60_000 };
}

function idOf(delivery: Delivery): string {
  return delivery.kind === "call" ? delivery.envelope.nonce : delivery.id;
}

function resultReply(id: string, machine = MACHINE) {
  return { kind: "result", id, machine, result: { content: [{ type: "text", text: "hello" }] }, redactions: 0 };
}

function toolsReply(id: string, machine = MACHINE) {
  return {
    kind: "tools",
    id,
    machine,
    server: "files",
    tools: [{ name: "read_file", inputSchema: { type: "object" } }],
    reported_at: new Date(Date.now()).toISOString(),
  };
}

function refusedReply(id: string, machine = MACHINE) {
  return { kind: "refused", id, machine, refusal: digestMismatch() };
}

function live(): AbortSignal {
  return new AbortController().signal;
}

function options(signal = live()) {
  return { signal, pickupBy: Date.now() + 10_000, replyWithinMs: 10_000 };
}

/** The machine polled a moment ago and is not polling now. */
async function markPresent(broker: LocalGatewayBroker, machine = MACHINE): Promise<void> {
  await broker.next(machine, AbortSignal.abort());
}

let broker: LongPollBroker;

/** Nothing waits in the machine's queue: a poll that has not hung up gets nothing before its short wait ends. */
async function expectEmptyQueue(machine = MACHINE): Promise<void> {
  const poll = broker.next(machine, live(), 1);
  await vi.advanceTimersByTimeAsync(1);
  await expect(poll).resolves.toBeUndefined();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-27T12:00:00.000Z"));
  broker = createInProcessBroker({ now: () => Date.now() });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("connected", () => {
  it("is false for a machine that never polled", () => {
    expect(broker.connected(MACHINE)).toBe(false);
  });

  it("is true while the machine polls and for PRESENCE_MS after", async () => {
    const poll = broker.next(MACHINE, live(), 1_000);
    expect(broker.connected(MACHINE)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(poll).resolves.toBeUndefined();
    expect(broker.connected(MACHINE)).toBe(true);
    await vi.advanceTimersByTimeAsync(PRESENCE_MS);
    expect(broker.connected(MACHINE)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(broker.connected(MACHINE)).toBe(false);
  });

  it("uses the real clock and default presence when given no options", async () => {
    const plain = createInProcessBroker();
    await plain.next(MACHINE, AbortSignal.abort());
    expect(plain.connected(MACHINE)).toBe(true);
    expect(plain.connected(OTHER)).toBe(false);
  });
});

describe("dispatch", () => {
  it("fails at once for a machine that is not connected, and sends nothing", async () => {
    const error = await broker.dispatch(MACHINE, callDelivery(), options()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect(error).toMatchObject({
      code: "disconnected",
      sent: false,
      message: `The local gateway on machine ${MACHINE} is not connected. Start the local gateway on that machine, then retry.`,
    });
  });

  it("hands the delivery to a waiting poll and resolves with the machine's reply", async () => {
    const poll = broker.next(MACHINE, live());
    const delivery = callDelivery();
    const call = broker.dispatch(MACHINE, delivery, options());
    await expect(poll).resolves.toBe(delivery);
    const answer = resultReply(idOf(delivery));
    expect(broker.reply(MACHINE, answer)).toEqual({ accepted: true });
    await expect(call).resolves.toEqual(answer);
  });

  it("names the server whose call reported its tools changed (#4772)", async () => {
    const poll = broker.next(MACHINE, live());
    const delivery = callDelivery();
    const call = broker.dispatch(MACHINE, delivery, options());
    await poll;
    const answer = { ...resultReply(idOf(delivery)), tools_changed: true };
    expect(broker.reply(MACHINE, answer)).toEqual({
      accepted: true,
      toolsChanged: { server: FILES_LAUNCH.server },
    });
    await expect(call).resolves.toEqual(answer);
  });

  it("names the server when a refused call reports its tools changed (#4772)", async () => {
    const poll = broker.next(MACHINE, live());
    const delivery = callDelivery();
    const call = broker.dispatch(MACHINE, delivery, options());
    await poll;
    const answer = { ...refusedReply(idOf(delivery)), tools_changed: true };
    expect(broker.reply(MACHINE, answer)).toEqual({
      accepted: true,
      toolsChanged: { server: FILES_LAUNCH.server },
    });
    await Promise.allSettled([call]);
  });

  it("queues the delivery for a machine seen within PRESENCE_MS, and the next poll takes it", async () => {
    await markPresent(broker);
    const delivery = callDelivery();
    const call = broker.dispatch(MACHINE, delivery, options());
    await expect(broker.next(MACHINE, live())).resolves.toBe(delivery);
    broker.reply(MACHINE, resultReply(idOf(delivery)));
    await expect(call).resolves.toMatchObject({ kind: "result" });
  });

  it("delivers queued calls in order", async () => {
    await markPresent(broker);
    const first = callDelivery();
    const second = callDelivery();
    void broker.dispatch(MACHINE, first, options()).catch(() => undefined);
    void broker.dispatch(MACHINE, second, options()).catch(() => undefined);
    await expect(broker.next(MACHINE, live())).resolves.toBe(first);
    await expect(broker.next(MACHINE, live())).resolves.toBe(second);
  });

  it("fails as disconnected when no poll takes the delivery before the envelope expires", async () => {
    await markPresent(broker);
    const call = broker.dispatch(MACHINE, callDelivery(), options());
    const settled = expect(call).rejects.toMatchObject({
      code: "disconnected",
      sent: false,
      message: `The local gateway on machine ${MACHINE} did not take the call before its envelope expired. Check that the local gateway is running and online, then retry.`,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await settled;
    await expectEmptyQueue();
  });

  it("fails as a timeout, sent, when the machine takes the call and does not answer", async () => {
    await markPresent(broker);
    const call = broker.dispatch(MACHINE, callDelivery(), { ...options(), replyWithinMs: 7_000 });
    await broker.next(MACHINE, live());
    const settled = expect(call).rejects.toMatchObject({
      code: "timeout",
      sent: true,
      message: `The local gateway on machine ${MACHINE} did not answer within 7000 ms.`,
    });
    await vi.advanceTimersByTimeAsync(6_999);
    await vi.advanceTimersByTimeAsync(1);
    await settled;
  });

  it("stops the pickup clock once the machine takes the call", async () => {
    await markPresent(broker);
    const delivery = callDelivery();
    const call = broker.dispatch(MACHINE, delivery, { ...options(), replyWithinMs: 60_000 });
    await broker.next(MACHINE, live());
    await vi.advanceTimersByTimeAsync(30_000);
    broker.reply(MACHINE, resultReply(idOf(delivery)));
    await expect(call).resolves.toMatchObject({ kind: "result" });
  });

  it("refuses a signal already aborted, without sending", async () => {
    await markPresent(broker);
    await expect(broker.dispatch(MACHINE, callDelivery(), options(AbortSignal.abort()))).rejects.toMatchObject({
      code: "not_sent",
      sent: false,
    });
    await expectEmptyQueue();
  });

  it("reports an abort before pickup as not sent, and drops the delivery from the queue", async () => {
    await markPresent(broker);
    const controller = new AbortController();
    const call = broker.dispatch(MACHINE, callDelivery(), options(controller.signal));
    controller.abort();
    await expect(call).rejects.toMatchObject({ code: "not_sent", sent: false });
    await expectEmptyQueue();
  });

  it("reports an abort after pickup as a timeout that was sent", async () => {
    await markPresent(broker);
    const controller = new AbortController();
    const delivery = callDelivery();
    const call = broker.dispatch(MACHINE, delivery, options(controller.signal));
    await broker.next(MACHINE, live());
    controller.abort();
    await expect(call).rejects.toMatchObject({
      code: "timeout",
      sent: true,
      message: "The call was stopped before the local gateway answered it.",
    });
    expect(broker.reply(MACHINE, resultReply(idOf(delivery)))).toEqual({ accepted: false, reason: "unknown_id" });
  });

  it("refuses a second delivery with an id already waiting", async () => {
    await markPresent(broker);
    const delivery = callDelivery();
    void broker.dispatch(MACHINE, delivery, options()).catch(() => undefined);
    await expect(broker.dispatch(MACHINE, delivery, options())).rejects.toMatchObject({
      code: "not_sent",
      sent: false,
      message: `A delivery with id ${idOf(delivery)} is already waiting for a reply.`,
    });
  });

  it("sends a discovery and resolves with the machine's tools", async () => {
    const poll = broker.next(MACHINE, live());
    const delivery = discoverDelivery();
    const discovery = broker.dispatch(MACHINE, delivery, options());
    await poll;
    const answer = toolsReply(idOf(delivery));
    expect(broker.reply(MACHINE, answer)).toEqual({ accepted: true });
    await expect(discovery).resolves.toEqual(answer);
  });
});

describe("reply", () => {
  async function taken(delivery: Delivery = callDelivery()): Promise<{ delivery: Delivery; call: Promise<unknown> }> {
    await markPresent(broker);
    const call = broker.dispatch(MACHINE, delivery, options());
    void call.catch(() => undefined);
    await broker.next(MACHINE, live());
    return { delivery, call };
  }

  it("refuses a body that is not a reply", async () => {
    await taken();
    expect(broker.reply(MACHINE, { kind: "result" })).toEqual({ accepted: false, reason: "invalid" });
    expect(broker.reply(MACHINE, "not json")).toEqual({ accepted: false, reason: "invalid" });
  });

  it("refuses a reply that names another machine than the one that sent it", async () => {
    const { delivery } = await taken();
    expect(broker.reply(OTHER, resultReply(idOf(delivery)))).toEqual({ accepted: false, reason: "wrong_machine" });
  });

  it("refuses a machine's reply to a delivery it was not sent", async () => {
    const { delivery } = await taken();
    expect(broker.reply(OTHER, resultReply(idOf(delivery), OTHER))).toEqual({ accepted: false, reason: "unknown_id" });
  });

  it("refuses a reply to a delivery no poll took yet", async () => {
    await markPresent(broker);
    const delivery = callDelivery();
    void broker.dispatch(MACHINE, delivery, options()).catch(() => undefined);
    expect(broker.reply(MACHINE, resultReply(idOf(delivery)))).toEqual({ accepted: false, reason: "unknown_id" });
  });

  it("refuses an id it never sent", () => {
    expect(broker.reply(MACHINE, resultReply(newNonce()))).toEqual({ accepted: false, reason: "unknown_id" });
  });

  it("settles once, so a replayed reply is refused", async () => {
    const { delivery, call } = await taken();
    expect(broker.reply(MACHINE, resultReply(idOf(delivery)))).toEqual({ accepted: true });
    expect(broker.reply(MACHINE, resultReply(idOf(delivery)))).toEqual({ accepted: false, reason: "unknown_id" });
    await expect(call).resolves.toMatchObject({ kind: "result" });
  });

  it("refuses a tools list for a call and a result for a discovery", async () => {
    const call = await taken();
    expect(broker.reply(MACHINE, toolsReply(idOf(call.delivery)))).toEqual({ accepted: false, reason: "wrong_kind" });
    const discovery = await taken(discoverDelivery());
    expect(broker.reply(MACHINE, resultReply(idOf(discovery.delivery)))).toEqual({
      accepted: false,
      reason: "wrong_kind",
    });
  });

  it("takes a refusal for either kind", async () => {
    const call = await taken();
    expect(broker.reply(MACHINE, refusedReply(idOf(call.delivery)))).toEqual({ accepted: true });
    await expect(call.call).resolves.toMatchObject({ kind: "refused", refusal: { code: "digest_mismatch" } });
    const discovery = await taken(discoverDelivery());
    expect(broker.reply(MACHINE, refusedReply(idOf(discovery.delivery)))).toEqual({ accepted: true });
  });
});

describe("next", () => {
  it("returns undefined when nothing arrives within the wait", async () => {
    const poll = broker.next(MACHINE, live());
    await vi.advanceTimersByTimeAsync(LONG_POLL_WAIT_MS);
    await expect(poll).resolves.toBeUndefined();
    expect(broker.connected(MACHINE)).toBe(true);
  });

  it("returns undefined when the poll is aborted, and stops waiting", async () => {
    const controller = new AbortController();
    const poll = broker.next(MACHINE, controller.signal);
    controller.abort();
    await expect(poll).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(PRESENCE_MS + 1);
    expect(broker.connected(MACHINE)).toBe(false);
  });

  it("takes nothing from the queue for a poll whose machine already hung up", async () => {
    await markPresent(broker);
    const delivery = callDelivery();
    void broker.dispatch(MACHINE, delivery, options()).catch(() => undefined);
    await expect(broker.next(MACHINE, AbortSignal.abort())).resolves.toBeUndefined();
    expect(broker.connected(MACHINE)).toBe(true);
    await expect(broker.next(MACHINE, live())).resolves.toBe(delivery);
  });

  it("hands one delivery to one poll when two machines poll", async () => {
    const mine = broker.next(MACHINE, live(), 1_000);
    const theirs = broker.next(OTHER, live(), 1_000);
    const delivery = callDelivery();
    void broker.dispatch(MACHINE, delivery, options()).catch(() => undefined);
    await expect(mine).resolves.toBe(delivery);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(theirs).resolves.toBeUndefined();
  });
});

describe("release", () => {
  it("puts a taken delivery back at the front of the queue, and the next poll takes it", async () => {
    await markPresent(broker);
    const first = callDelivery();
    const second = callDelivery();
    const call = broker.dispatch(MACHINE, first, options());
    void broker.dispatch(MACHINE, second, options()).catch(() => undefined);
    await expect(broker.next(MACHINE, live())).resolves.toBe(first);
    expect(broker.release(MACHINE, first)).toBe(true);
    await expect(broker.next(MACHINE, live())).resolves.toBe(first);
    await expect(broker.next(MACHINE, live())).resolves.toBe(second);
    expect(broker.reply(MACHINE, resultReply(idOf(first)))).toEqual({ accepted: true });
    await expect(call).resolves.toMatchObject({ kind: "result" });
  });

  it("hands a released delivery straight to a poll that waits", async () => {
    await markPresent(broker);
    const delivery = callDelivery();
    void broker.dispatch(MACHINE, delivery, options()).catch(() => undefined);
    await broker.next(MACHINE, live());
    const waiting = broker.next(MACHINE, live());
    expect(broker.release(MACHINE, delivery)).toBe(true);
    await expect(waiting).resolves.toBe(delivery);
  });

  it("refuses a reply to a released delivery until a poll takes it again", async () => {
    await markPresent(broker);
    const delivery = callDelivery();
    void broker.dispatch(MACHINE, delivery, options()).catch(() => undefined);
    await broker.next(MACHINE, live());
    broker.release(MACHINE, delivery);
    expect(broker.reply(MACHINE, resultReply(idOf(delivery)))).toEqual({ accepted: false, reason: "unknown_id" });
  });

  it("runs the pickup clock again, so a released delivery no poll takes fails as disconnected", async () => {
    await markPresent(broker);
    const delivery = callDelivery();
    const call = broker.dispatch(MACHINE, delivery, { ...options(), replyWithinMs: 60_000 });
    await broker.next(MACHINE, live());
    broker.release(MACHINE, delivery);
    const settled = expect(call).rejects.toMatchObject({ code: "disconnected", sent: false });
    await vi.advanceTimersByTimeAsync(10_000);
    await settled;
    await expectEmptyQueue();
  });

  it("fails a released delivery at once when its envelope expired while the machine held it", async () => {
    await markPresent(broker);
    const delivery = callDelivery();
    const call = broker.dispatch(MACHINE, delivery, { ...options(), replyWithinMs: 60_000 });
    await broker.next(MACHINE, live());
    await vi.advanceTimersByTimeAsync(12_000);
    broker.release(MACHINE, delivery);
    const settled = expect(call).rejects.toMatchObject({ code: "disconnected", sent: false });
    await vi.advanceTimersByTimeAsync(0);
    await settled;
  });

  it("reports a caller's abort after a release as not sent", async () => {
    await markPresent(broker);
    const controller = new AbortController();
    const delivery = callDelivery();
    const call = broker.dispatch(MACHINE, delivery, options(controller.signal));
    await broker.next(MACHINE, live());
    broker.release(MACHINE, delivery);
    controller.abort();
    await expect(call).rejects.toMatchObject({ code: "not_sent", sent: false });
    await expectEmptyQueue();
  });

  it("takes back only a delivery this machine took and has not answered", async () => {
    await markPresent(broker);
    await markPresent(broker, OTHER);
    const delivery = callDelivery();
    void broker.dispatch(MACHINE, delivery, options()).catch(() => undefined);
    expect(broker.release(MACHINE, delivery)).toBe(false);
    await expect(broker.next(MACHINE, live())).resolves.toBe(delivery);
    expect(broker.release(OTHER, delivery)).toBe(false);
    expect(broker.release(MACHINE, callDelivery())).toBe(false);
    expect(broker.reply(MACHINE, resultReply(idOf(delivery)))).toEqual({ accepted: true });
    expect(broker.release(MACHINE, delivery)).toBe(false);
  });
});
