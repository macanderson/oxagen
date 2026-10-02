// Routing a GitHub App delivery to work collectors (P1-03, #5103), over fakes:
// each collector that reads the repository runs the doorbell in its own
// tenant scope, and one event goes out per stored, unpaused delivery.
import { describe, expect, it, vi } from "vitest";
import type { CollectorRecord, DeliveryResult } from "@oxagen/ingestion/collectors";

vi.mock("../../logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { WORK_DELIVERY_EVENTS, routeGithubWorkDelivery } = await import("./delivery");

const ORG = "00000000-0000-4000-8000-000000000001";
const WS_A = "00000000-0000-4000-8000-0000000000a1";
const WS_B = "00000000-0000-4000-8000-0000000000b2";

function collector(id: string, workspaceId: string, health: CollectorRecord["health"] = "healthy"): CollectorRecord {
  return {
    id,
    orgId: ORG,
    workspaceId,
    name: id,
    type: "github",
    connectionId: "conn-1",
    scope: { repos: ["acme/web"] },
    health,
    cursor: null,
    createdAt: "2026-10-01T00:00:00.000Z",
  };
}

const input = {
  installationId: "555",
  repository: "acme/web",
  request: { headers: {}, body: new Uint8Array(), receivedAt: "2026-10-02T00:00:00.000Z" },
  secret: "s",
};

describe("routeGithubWorkDelivery", () => {
  it("handles issue and issue comment deliveries", () => {
    expect([...WORK_DELIVERY_EVENTS].sort()).toEqual(["issue_comment", "issues"]);
  });

  it("stores the delivery for each collector, and sends one event per stored, unpaused one", async () => {
    const results: DeliveryResult[] = [
      { kind: "stored", inboundEventId: "ie-a", deliveryId: "d", paused: false },
      { kind: "stored", inboundEventId: "ie-b", deliveryId: "d", paused: true },
      { kind: "duplicate", deliveryId: "d" },
      { kind: "rejected", reason: "bad signature" },
      { kind: "no_module" },
    ];
    const receive = vi.fn(async () => results.shift()!);
    const ports = vi.fn((scope: { orgId: string; workspaceId: string }) => ({ scope }) as never);
    const send = vi.fn(async () => undefined);
    const collectorsFor = vi.fn(async () => [
      collector("a", WS_A),
      collector("b", WS_B, "paused"),
      collector("c", WS_A),
      collector("d", WS_A),
      collector("e", WS_A),
    ]);
    const routing = await routeGithubWorkDelivery(input, { collectorsFor, receive, ports, send });

    expect(collectorsFor).toHaveBeenCalledWith("555", "acme/web");
    expect(ports).toHaveBeenNthCalledWith(2, { orgId: ORG, workspaceId: WS_B });
    expect(receive).toHaveBeenCalledTimes(5);
    expect(routing).toMatchObject({ stored: 2, duplicates: 1, rejected: 1 });
    const event = {
      name: "work/event.received",
      id: "work-event-ie-a",
      data: { org_id: ORG, workspace_id: WS_A, inbound_event_id: "ie-a" },
    };
    expect(routing.events).toEqual([event]);
    expect(send).toHaveBeenCalledWith([event]);
  });

  it("sends nothing when no collector reads the repository", async () => {
    const send = vi.fn(async () => undefined);
    const routing = await routeGithubWorkDelivery(input, {
      collectorsFor: async () => [],
      receive: vi.fn(),
      ports: vi.fn(),
      send,
    });
    expect(routing).toEqual({ events: [], stored: 0, duplicates: 0, rejected: 0 });
    expect(send).not.toHaveBeenCalled();
  });
});
