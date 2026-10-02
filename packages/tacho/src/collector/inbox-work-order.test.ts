/**
 * A `work_order` command (P1-04, ADR-251): the host keeps the order for the
 * person at the machine, acknowledges `received`, and starts nothing. The
 * store is a scratch directory, so nothing here touches a real agent.
 */
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ClaudeCodeContext } from "../claude-code/context";
import { scratchPaths, TEST_ENROLLMENT } from "../host/test-support";
import {
  keepWorkOrder,
  listWorkOrders,
  type PendingWorkOrder,
  readWorkOrder,
  removeWorkOrder,
} from "../host/work-orders";
import {
  BUNDLE_FEATURE_WORK_ORDERS,
  type DeliveredCommand,
  TACHO_BUNDLE_FEATURES,
} from "../wire";
import { applyCommands, HandledCommands, type InboxDeps } from "./inbox";
import { SessionRegistry } from "./registry";

const CONTEXT: ClaudeCodeContext = {
  agent: {
    agent_key: "acme.core.cc-laptop",
    fleet_id: "wrk_1",
    runtime: "claude-code",
    harness: "claude-code",
    wrapper_version: "2.1.1",
    host_enrollment_id: TEST_ENROLLMENT,
  },
};

const PAYLOAD = {
  work_order: "wo_01j9k2m3n4",
  key: "wi_7f3a:r2:s1",
  item: "wi_7f3a",
};

function command(overrides: Partial<DeliveredCommand>): DeliveredCommand {
  return {
    id: "tcmd_1",
    command: "work_order",
    session_uuid: null,
    payload: PAYLOAD,
    requested_mode: null,
    delivery_mode: null,
    degraded_reason: null,
    reason: null,
    issued_at: "2026-10-02T10:00:00.000Z",
    expires_at: null,
    ...overrides,
  };
}

function host(keep?: (order: PendingWorkOrder) => void) {
  const paths = scratchPaths("linux");
  const now = () => Date.parse("2026-10-02T10:00:05.000Z");
  const registry = new SessionRegistry({
    context: CONTEXT,
    scope: TEST_ENROLLMENT,
    now,
  });
  const daemon = registry.ensure("tachod-boot", { pid: process.pid }).record;
  daemon.recorder.sealCollectorEvent("agent_start", {
    session_start_source: "daemon",
  });
  const deps: InboxDeps = {
    registry,
    hostRecorder: () => daemon.recorder,
    kill: () => true,
    refreshBundle: async () => undefined,
    onHostSuspended: () => undefined,
    now,
    keepWorkOrder:
      keep ??
      ((order) => {
        keepWorkOrder(paths, order);
      }),
  };
  return { paths, deps };
}

describe("a work_order command", () => {
  it("keeps the order, acknowledges received, and seals nothing", async () => {
    const h = host();
    const result = await applyCommands([command({})], h.deps);
    expect(result.acknowledgements).toEqual([
      { command_id: "tcmd_1", status: "received" },
    ]);
    expect(result.events).toEqual([]);
    expect(result.applied).toEqual([]);
    expect(readWorkOrder(h.paths, PAYLOAD.work_order)).toEqual({
      command_id: "tcmd_1",
      ...PAYLOAD,
      received_at: "2026-10-02T10:00:05.000Z",
    });
    expect(listWorkOrders(h.paths).map((order) => order.work_order)).toEqual([
      PAYLOAD.work_order,
    ]);
  });

  it("writes the order file at mode 0600", async () => {
    if (process.platform === "win32") return;
    const h = host();
    await applyCommands([command({})], h.deps);
    const [name] = readdirSync(h.paths.workOrders);
    expect(name).toBe(`${PAYLOAD.work_order}.json`);
    const mode = statSync(`${h.paths.workOrders}/${name}`).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("answers a redelivery from the ledger and keeps the first copy", async () => {
    const h = host();
    const kept: PendingWorkOrder[] = [];
    const handled = new HandledCommands();
    const deps: InboxDeps = {
      ...h.deps,
      handled,
      keepWorkOrder: (order) => kept.push(order),
    };
    await applyCommands([command({})], deps);
    const again = await applyCommands([command({})], deps);
    expect(again.acknowledgements).toEqual([
      { command_id: "tcmd_1", status: "received" },
    ]);
    expect(kept).toHaveLength(1);
  });

  it("leaves the file alone when the same command arrives with no ledger", () => {
    const paths = scratchPaths("linux");
    const order: PendingWorkOrder = {
      command_id: "tcmd_1",
      ...PAYLOAD,
      received_at: "2026-10-02T10:00:05.000Z",
    };
    expect(keepWorkOrder(paths, order)).toBe(true);
    expect(
      keepWorkOrder(paths, { ...order, received_at: "2026-10-02T11:00:00Z" }),
    ).toBe(false);
    expect(readWorkOrder(paths, PAYLOAD.work_order)?.received_at).toBe(
      "2026-10-02T10:00:05.000Z",
    );
    removeWorkOrder(paths, PAYLOAD.work_order);
    expect(listWorkOrders(paths)).toEqual([]);
  });

  it.each([
    ["no work order id", { key: PAYLOAD.key, item: PAYLOAD.item }],
    ["a work order id of another shape", { ...PAYLOAD, work_order: "../x" }],
    ["no key", { work_order: PAYLOAD.work_order, item: PAYLOAD.item }],
    ["no item", { work_order: PAYLOAD.work_order, key: PAYLOAD.key }],
  ])("fails a payload with %s and keeps nothing (negative)", async (_, payload) => {
    const h = host();
    const result = await applyCommands([command({ payload })], h.deps);
    expect(result.acknowledgements).toEqual([
      {
        command_id: "tcmd_1",
        status: "failed",
        detail:
          "work_order payload must name work_order (wo_...), key, and item (wi_...)",
      },
    ]);
    expect(listWorkOrders(h.paths)).toEqual([]);
  });

  it("fails when the order cannot be written, with the reason (negative)", async () => {
    const h = host(() => {
      throw new Error("EACCES: permission denied");
    });
    const result = await applyCommands([command({})], h.deps);
    expect(result.acknowledgements).toEqual([
      {
        command_id: "tcmd_1",
        status: "failed",
        detail: "could not keep the work order: EACCES: permission denied",
      },
    ]);
  });

  it("fails on a host with nowhere to keep it (negative)", async () => {
    const h = host();
    const deps: InboxDeps = { ...h.deps };
    delete deps.keepWorkOrder;
    const result = await applyCommands([command({})], deps);
    expect(result.acknowledgements[0]).toMatchObject({
      status: "failed",
      detail: "this host has nowhere to keep a work order",
    });
  });

  it("fails one addressed to a session, since it is a host command (negative)", async () => {
    const h = host();
    const session = h.deps.registry.ensure("sess-1", { pid: 4242 }).record;
    session.recorder.sealCollectorEvent("agent_start", {
      session_start_source: "startup",
    });
    const result = await applyCommands(
      [command({ session_uuid: session.recorder.sessionUuid })],
      h.deps,
    );
    expect(result.acknowledgements[0]).toMatchObject({
      status: "failed",
      detail: "work_order is a host command",
    });
    expect(listWorkOrders(h.paths)).toEqual([]);
  });

  it("acknowledges expired for an order past its deadline (negative)", async () => {
    const h = host();
    const result = await applyCommands(
      [command({ expires_at: "2026-10-02T09:00:00.000Z" })],
      h.deps,
    );
    expect(result.acknowledgements[0]).toMatchObject({ status: "expired" });
    expect(listWorkOrders(h.paths)).toEqual([]);
  });

  it("is a feature this host advertises, so the control plane sends it", () => {
    expect(TACHO_BUNDLE_FEATURES).toContain(BUNDLE_FEATURE_WORK_ORDERS);
  });
});

describe("the work order store", () => {
  it("lists orders oldest first and skips a file that does not read", () => {
    const paths = scratchPaths("linux");
    keepWorkOrder(paths, {
      command_id: "tcmd_2",
      work_order: "wo_b",
      key: "k2",
      item: "wi_2",
      received_at: "2026-10-02T10:00:02.000Z",
    });
    keepWorkOrder(paths, {
      command_id: "tcmd_1",
      work_order: "wo_a",
      key: "k1",
      item: "wi_1",
      received_at: "2026-10-02T10:00:01.000Z",
    });
    writeFileSync(`${paths.workOrders}/wo_c.json`, "{not json");
    writeFileSync(`${paths.workOrders}/notes.txt`, "hello");
    expect(listWorkOrders(paths).map((order) => order.work_order)).toEqual([
      "wo_a",
      "wo_b",
    ]);
  });

  it("refuses an id that could name another path (negative)", () => {
    const paths = scratchPaths("linux");
    expect(() => removeWorkOrder(paths, "../host")).toThrow(
      /is not a work order id/,
    );
    expect(readWorkOrder(paths, "../host")).toBeUndefined();
  });
});
