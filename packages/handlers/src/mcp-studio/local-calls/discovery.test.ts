// discovery.test.ts: a machine in the server's group lists a local server's
// tools for lane M10, and the report names the machine.
import { describe, expect, it, vi } from "vitest";
import { TransportError } from "@oxagen/mcp-studio";
import { digestMismatch, type Delivery, type Reply } from "@oxagen/tacho/local-servers";
import type { LocalGatewayBroker } from "./broker";
import { DISCOVERY_DEADLINE_MS, discoverLocalTools, type DiscoverLocalToolsOptions } from "./discovery";
import { LOCAL_CALL_TTL_MS } from "./envelope";
import { FILES_LAUNCH, MACHINE, SCOPE, readerOf } from "./test-support";
import { REPLY_GRACE_MS } from "./transport";

const NOW = Date.parse("2026-09-27T12:00:00.000Z");

function idOf(delivery: Delivery): string {
  return delivery.kind === "call" ? delivery.envelope.nonce : delivery.id;
}

function brokerAnswering(answer: (delivery: Delivery) => Promise<Reply>) {
  const dispatch = vi.fn<LocalGatewayBroker["dispatch"]>((_machine, delivery) => answer(delivery));
  const broker: LocalGatewayBroker = {
    connected: () => true,
    dispatch,
    next: () => Promise.resolve(undefined),
    reply: () => ({ accepted: false, reason: "unknown_id" }),
  };
  return { broker, dispatch };
}

function optionsWith(
  broker: LocalGatewayBroker,
  overrides: Partial<DiscoverLocalToolsOptions> = {},
): DiscoverLocalToolsOptions {
  return {
    scope: SCOPE,
    machine: MACHINE,
    groups: ["dev-laptops"],
    reader: readerOf({ [MACHINE]: ["dev-laptops"] }),
    broker,
    launch: FILES_LAUNCH,
    signal: new AbortController().signal,
    now: () => NOW,
    ...overrides,
  };
}

function toolsFor(delivery: Delivery): Promise<Reply> {
  return Promise.resolve({
    kind: "tools",
    id: idOf(delivery),
    machine: MACHINE,
    server: "files",
    server_version: "2026.8.1",
    tools: [{ name: "read_file", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
    reported_at: new Date(NOW).toISOString(),
  });
}

describe("discoverLocalTools", () => {
  it("asks a machine in the group for the server's tools and returns its report", async () => {
    const { broker, dispatch } = brokerAnswering(toolsFor);
    const discovery = await discoverLocalTools(optionsWith(broker));

    expect(discovery).toMatchObject({ ok: true, report: { kind: "tools", machine: MACHINE, server: "files" } });
    const [machine, delivery, options] = dispatch.mock.calls[0] ?? [];
    expect(machine).toBe(MACHINE);
    expect(delivery).toMatchObject({ kind: "discover", launch: FILES_LAUNCH, deadline_ms: DISCOVERY_DEADLINE_MS });
    expect(delivery?.kind === "discover" ? delivery.id : "").toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(options).toMatchObject({
      pickupBy: NOW + LOCAL_CALL_TTL_MS,
      replyWithinMs: DISCOVERY_DEADLINE_MS + REPLY_GRACE_MS,
    });
  });

  it("takes a shorter deadline", async () => {
    const { broker, dispatch } = brokerAnswering(toolsFor);
    await discoverLocalTools(optionsWith(broker, { deadlineMs: 5_000 }));
    const [, delivery, options] = dispatch.mock.calls[0] ?? [];
    expect(delivery).toMatchObject({ deadline_ms: 5_000 });
    expect(options?.replyWithinMs).toBe(5_000 + REPLY_GRACE_MS);
  });

  it("refuses a machine outside the group and asks it for nothing", async () => {
    const { broker, dispatch } = brokerAnswering(toolsFor);
    const discovery = await discoverLocalTools(optionsWith(broker, { reader: readerOf({}) }));
    expect(discovery).toEqual({
      ok: false,
      refusal: {
        code: "not_in_group",
        message: "This machine is not in group dev-laptops.",
        fix: "Ask a workspace admin to add it.",
      },
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("returns the machine's refusal", async () => {
    const { broker } = brokerAnswering((delivery) =>
      Promise.resolve({ kind: "refused", id: idOf(delivery), machine: MACHINE, refusal: digestMismatch() }),
    );
    await expect(discoverLocalTools(optionsWith(broker))).resolves.toEqual({ ok: false, refusal: digestMismatch() });
  });

  it("throws when the machine answers with a call result", async () => {
    const { broker } = brokerAnswering((delivery) =>
      Promise.resolve({ kind: "result", id: idOf(delivery), machine: MACHINE, result: { content: [] }, redactions: 0 }),
    );
    await expect(discoverLocalTools(optionsWith(broker))).rejects.toThrow(
      "The local gateway answered a discovery with a call result.",
    );
  });

  it("passes the broker's TransportError through", async () => {
    const error = new TransportError("disconnected", "The local gateway is not connected.", false);
    const { broker } = brokerAnswering(() => Promise.reject(error));
    await expect(discoverLocalTools(optionsWith(broker))).rejects.toBe(error);
  });

  it("reads the clock when the options give none", async () => {
    const { broker, dispatch } = brokerAnswering(toolsFor);
    const before = Date.now();
    await discoverLocalTools(optionsWith(broker, { now: undefined }));
    const pickupBy = dispatch.mock.calls[0]?.[2].pickupBy ?? 0;
    expect(pickupBy).toBeGreaterThanOrEqual(before + LOCAL_CALL_TTL_MS);
  });
});
