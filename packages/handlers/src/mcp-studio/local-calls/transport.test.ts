// transport.test.ts: the local path as M15's Transport. The cloud gateway
// checks the machine's group and the lock's digest, signs the call, and
// hands it to the machine. A refusal comes back as a tool result the agent
// reads, with the fix.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TransportError, type LocalCall } from "@oxagen/mcp-studio";
import {
  argumentsHashOf,
  digestMismatch,
  localCallEnvelopeSchema,
  type Delivery,
  type Reply,
} from "@oxagen/tacho/local-servers";
import { createInProcessBroker, type LocalGatewayBroker } from "./broker";
import { createLocalTransport, refusalResult, REPLY_GRACE_MS, type LocalTransportOptions } from "./transport";
import { DEFINITION_HASH, FILES_DIGEST, FILES_LAUNCH, MACHINE, SCOPE, readerOf, testSigner } from "./test-support";

const NOW = new Date("2026-09-27T12:00:00.000Z");
const NONCE = "abcdefghijklmnopqrstuv";
const OK = { content: [{ type: "text", text: "# Today" }] };

function localCall(overrides: Partial<LocalCall> = {}): LocalCall {
  return {
    tool: "files__read_file",
    upstream: "read_file",
    version: 2,
    definition_hash: DEFINITION_HASH,
    package_digest: FILES_DIGEST,
    arguments: { path: "notes/today.md" },
    deadline_ms: 20_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function fakeBroker(answer: (delivery: Delivery) => Promise<Reply>) {
  const dispatch = vi.fn<LocalGatewayBroker["dispatch"]>((_machine, delivery) => answer(delivery));
  const broker: LocalGatewayBroker = {
    connected: () => true,
    dispatch,
    next: () => Promise.resolve(undefined),
    reply: () => ({ accepted: false, reason: "unknown_id" }),
  };
  return { broker, dispatch };
}

function resultFor(delivery: Delivery): Promise<Reply> {
  if (delivery.kind !== "call") throw new Error("expected a call");
  return Promise.resolve({ kind: "result", id: delivery.envelope.nonce, machine: MACHINE, result: OK, redactions: 0 });
}

function transportWith(broker: LocalGatewayBroker, overrides: Partial<LocalTransportOptions> = {}) {
  const signer = testSigner();
  const transport = createLocalTransport({
    scope: SCOPE,
    machine: MACHINE,
    groups: ["dev-laptops"],
    reader: readerOf({ [MACHINE]: ["dev-laptops"] }),
    signer,
    broker,
    launch: FILES_LAUNCH,
    now: () => NOW,
    nonce: () => NONCE,
    ...overrides,
  });
  return { transport, signer };
}

describe("createLocalTransport", () => {
  it("signs the call, hands it to the machine, and returns the screened result", async () => {
    const { broker, dispatch } = fakeBroker(resultFor);
    const { transport, signer } = transportWith(broker);
    const call = localCall();

    await expect(transport.local(call)).resolves.toEqual(OK);

    expect(dispatch).toHaveBeenCalledTimes(1);
    const [machine, delivery, options] = dispatch.mock.calls[0] ?? [];
    expect(machine).toBe(MACHINE);
    expect(delivery).toMatchObject({ kind: "call", arguments: call.arguments, launch: FILES_LAUNCH });
    if (delivery?.kind !== "call") throw new Error("expected a call");
    expect(localCallEnvelopeSchema.safeParse(delivery.envelope).success).toBe(true);
    expect(delivery.envelope).toMatchObject({
      tool: "files__read_file",
      upstream: "read_file",
      version: 2,
      definition_hash: DEFINITION_HASH,
      package_digest: FILES_DIGEST,
      arguments_hash: argumentsHashOf(call.arguments),
      deadline_ms: 20_000,
      machine: MACHINE,
      nonce: NONCE,
      issued_at: NOW.toISOString(),
      expires_at: "2026-09-27T12:00:10.000Z",
    });
    expect(delivery.envelope.signature.key_id).toBe(signer.keyId);
    expect(options).toEqual({
      signal: call.signal,
      pickupBy: Date.parse("2026-09-27T12:00:10.000Z"),
      replyWithinMs: 20_000 + REPLY_GRACE_MS,
    });
  });

  it("refuses a machine outside the group with the spec's error, and sends nothing", async () => {
    const { broker, dispatch } = fakeBroker(resultFor);
    const { transport } = transportWith(broker, { reader: readerOf({ [MACHINE]: ["ci-runners"] }) });

    const result = await transport.local(localCall());

    expect(result).toEqual({
      content: [{ type: "text", text: "This machine is not in group dev-laptops. Ask a workspace admin to add it." }],
      structuredContent: {
        error: {
          code: "not_in_group",
          message: "This machine is not in group dev-laptops.",
          fix: "Ask a workspace admin to add it.",
        },
      },
      isError: true,
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("refuses every machine for a server that names no groups", async () => {
    const { broker, dispatch } = fakeBroker(resultFor);
    const { transport } = transportWith(broker, { groups: [] });
    const result = await transport.local(localCall());
    expect(result.structuredContent).toMatchObject({ error: { code: "not_in_group" } });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("refuses a call whose package digest is not the lock's, and sends nothing", async () => {
    const { broker, dispatch } = fakeBroker(resultFor);
    const { transport } = transportWith(broker);
    const result = await transport.local(localCall({ package_digest: `sha256:${"b".repeat(64)}` }));
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: "launch_mismatch" } });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("returns the machine's refusal as a tool result", async () => {
    const { broker } = fakeBroker((delivery) =>
      Promise.resolve({
        kind: "refused",
        id: delivery.kind === "call" ? delivery.envelope.nonce : delivery.id,
        machine: MACHINE,
        refusal: digestMismatch(),
      }),
    );
    const { transport } = transportWith(broker);
    await expect(transport.local(localCall())).resolves.toEqual(refusalResult(digestMismatch()));
  });

  it("throws when the machine answers a call with a tools list", async () => {
    const { broker } = fakeBroker(() =>
      Promise.resolve({
        kind: "tools",
        id: NONCE,
        machine: MACHINE,
        server: "files",
        tools: [],
        reported_at: NOW.toISOString(),
      }),
    );
    const { transport } = transportWith(broker);
    await expect(transport.local(localCall())).rejects.toMatchObject({ code: "disconnected", sent: true });
  });

  it("passes the broker's TransportError through", async () => {
    const error = new TransportError("disconnected", "The local gateway is not connected.", false);
    const { broker } = fakeBroker(() => Promise.reject(error));
    const { transport } = transportWith(broker);
    await expect(transport.local(localCall())).rejects.toBe(error);
  });

  it("uses the clock and a new nonce when the options give none", async () => {
    const { broker, dispatch } = fakeBroker(resultFor);
    const { transport } = transportWith(broker, { now: undefined, nonce: undefined });
    await transport.local(localCall());
    await transport.local(localCall());
    const nonces = dispatch.mock.calls.map(([, delivery]) => (delivery.kind === "call" ? delivery.envelope.nonce : ""));
    expect(nonces[0]).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(nonces[0]).not.toBe(nonces[1]);
  });

  it("refuses HTTP and gRPC requests", async () => {
    const { broker } = fakeBroker(resultFor);
    const { transport } = transportWith(broker);
    await expect(transport.http({} as never)).rejects.toMatchObject({
      code: "unsupported",
      sent: false,
      message: "A local server takes only local calls, not HTTP requests. Route HTTP tools through the cloud or a relay.",
    });
    await expect(transport.grpc({} as never)).rejects.toMatchObject({ code: "unsupported", sent: false });
  });
});

describe("createLocalTransport with the in-process broker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers the call to the machine's poll and returns its reply", async () => {
    const broker = createInProcessBroker({ now: () => Date.now() });
    const { transport } = transportWith(broker, { now: undefined, nonce: undefined });
    const poll = broker.next(MACHINE, new AbortController().signal);

    const result = transport.local(localCall());
    const delivery = await poll;
    if (delivery?.kind !== "call") throw new Error("expected a call");
    expect(broker.reply(MACHINE, { kind: "result", id: delivery.envelope.nonce, machine: MACHINE, result: OK, redactions: 0 })).toEqual({
      accepted: true,
    });
    await expect(result).resolves.toEqual(OK);
  });

  it("fails closed when the machine's local gateway is not connected", async () => {
    const broker = createInProcessBroker({ now: () => Date.now() });
    const { transport } = transportWith(broker);
    await expect(transport.local(localCall())).rejects.toMatchObject({ code: "disconnected", sent: false });
  });

  it("fails as disconnected when the machine does not take the call before the envelope expires", async () => {
    const broker = createInProcessBroker({ now: () => Date.now() });
    await broker.next(MACHINE, AbortSignal.abort());
    const { transport } = transportWith(broker, { now: undefined });
    const result = transport.local(localCall());
    const settled = expect(result).rejects.toMatchObject({ code: "disconnected", sent: false });
    await vi.advanceTimersByTimeAsync(10_000);
    await settled;
  });
});
