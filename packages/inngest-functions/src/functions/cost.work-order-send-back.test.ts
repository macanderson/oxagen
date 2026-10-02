// cost.work-order-send-back (R3, #5108): the hourly job finds each
// workspace's sends to go back and posts one note per streak through
// write-back, with a fake collector that supports write-back.
//
//   - one streak gets exactly one note, however many passes find it
//   - a new run starts a fresh count, and a second streak of 3 posts a second
//     note
//   - a pass with send_note off records nothing, and the next pass with it on
//     posts the note
//   - one workspace's failed pass does not stop the sweep
import type { WorkOrderSendBack } from "@oxagen/billing";
import {
  type AnyCollectorDefinition,
  type CollectorHealth,
  type SendBackPorts,
  WRITE_BACK_DEFAULTS,
  type WriteBackSwitches,
} from "@oxagen/ingestion/collectors";
import { getScope } from "@oxagen/tenancy";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listWorkspacesForOutcomes: vi.fn(),
  findWorkOrderSendBacks: vi.fn(),
  createFunction: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@oxagen/billing", () => ({
  listWorkspacesForOutcomes: mocks.listWorkspacesForOutcomes,
  findWorkOrderSendBacks: mocks.findWorkOrderSendBacks,
}));
vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: mocks.warn, error: vi.fn() },
}));
vi.mock("../create-function", () => ({ createFunction: mocks.createFunction }));

type Handler = (ctx: {
  step: { run: (name: string, fn: () => Promise<unknown>) => Promise<unknown> };
}) => Promise<unknown>;
const registered = new Map<
  string,
  { config: Record<string, unknown>; trigger: unknown; handler: Handler }
>();
mocks.createFunction.mockImplementation(
  (config: { id: string }, trigger: unknown, handler: Handler) => {
    registered.set(config.id, { config, trigger, handler });
    return [{}];
  },
);

await import("./cost.work-order-send-back");
const { setWorkOrderSendBackPorts } = await import(
  "../lib/work-order-send-back-ports"
);

const steps: string[] = [];
const step = {
  run: (name: string, fn: () => Promise<unknown>) => {
    steps.push(name);
    return fn();
  },
};

const WS_A = {
  orgId: "0192a6f0-0000-7000-8000-00000000000a",
  workspaceId: "0192a6f0-0000-7000-8000-0000000000a1",
};
const WS_B = {
  orgId: "0192a6f0-0000-7000-8000-00000000000a",
  workspaceId: "0192a6f0-0000-7000-8000-0000000000b1",
};
const ORDER = "0192a6f0-0000-7000-8000-0000000000c1";
const ITEM = "0192a6f0-0000-7000-8000-0000000000d1";

const hourly = () => {
  const found = registered.get("cost.work-order-send-back-hourly");
  if (!found) throw new Error("hourly send-back function not registered");
  return found;
};

/** The send whose newest runs, newest first, each ended with nothing kept. */
function streak(...runIds: string[]): WorkOrderSendBack {
  return {
    orderId: ORDER,
    orderPublicId: "wo_r3send",
    itemId: ITEM,
    agentKey: "acme.core.builder",
    runs: runIds.map((runId, i) => ({
      runId,
      startedAt: new Date(Date.UTC(2026, 9, 1, 12 - i)),
      reason: "closed_unmerged" as const,
      cost: { micros: 2_500_000n, currency: "USD", basis: "gateway_observed" as const },
    })),
  };
}

/**
 * A provider whose collector supports write-back, an in-memory record, and
 * the ports the job reads. Tests flip the switches and the health between
 * passes.
 */
function provider() {
  const notes: Array<{ providerId: string; text: string }> = [];
  const recorded = new Set<string>();
  const portScopes: unknown[] = [];
  const state: { switches: WriteBackSwitches; health: CollectorHealth } = {
    switches: { ...WRITE_BACK_DEFAULTS },
    health: "healthy",
  };
  const refuse = async () => {
    throw new Error("A send-back writes a note and nothing else.");
  };
  const definition = {
    type: "github",
    writeBack: {
      note: async (target: { ref: { providerId: string } }, text: string) => {
        notes.push({ providerId: target.ref.providerId, text });
      },
      status: refuse,
      close: refuse,
      labels: refuse,
    },
  } as unknown as AnyCollectorDefinition;
  const ports: SendBackPorts = {
    async resolve(itemId) {
      portScopes.push(getScope());
      return {
        collector: { definition, switches: state.switches, health: state.health },
        target: {
          ref: { providerId: `issue:node:${itemId}` },
          conn: { id: "conn-1", auth: { scheme: "public" } },
        },
      };
    },
    record: {
      async has(key) {
        portScopes.push(getScope());
        return recorded.has(`${key.orderId}:${key.lastRunId}`);
      },
      async add(key) {
        recorded.add(`${key.orderId}:${key.lastRunId}`);
      },
    },
  };
  const installed = vi.fn(async () => ports);
  setWorkOrderSendBackPorts(installed);
  return { notes, recorded, portScopes, state, installed };
}

/** Run the hourly job once with the sends the finder returns this pass. */
async function pass(...found: WorkOrderSendBack[]) {
  mocks.findWorkOrderSendBacks.mockResolvedValueOnce(found);
  return hourly().handler({ step });
}

beforeEach(() => {
  steps.length = 0;
  mocks.listWorkspacesForOutcomes.mockReset();
  mocks.listWorkspacesForOutcomes.mockResolvedValue([WS_A]);
  mocks.findWorkOrderSendBacks.mockReset();
  mocks.warn.mockReset();
  setWorkOrderSendBackPorts(null);
});

describe("cost.work-order-send-back-hourly", () => {
  it("runs hourly at 45 past, after the outcome refresh at 15 past, one run at a time", () => {
    expect(hourly().config).toMatchObject({
      id: "cost.work-order-send-back-hourly",
      concurrency: { limit: 1 },
    });
    expect(hourly().trigger).toEqual({ cron: "45 * * * *" });
  });

  it("posts one note with the spend attached, and the record keeps later passes from posting it again", async () => {
    const p = provider();
    const first = await pass(streak("tse_c", "tse_b", "tse_a"));
    expect(first).toEqual({ workspaces: 1, passed: 1, found: 1, written: 1 });
    expect(p.notes).toHaveLength(1);
    expect(p.notes[0]!.providerId).toBe(`issue:node:${ITEM}`);
    expect(p.notes[0]!.text).toContain(
      "Oxagen sent work order wo_r3send back to this work item. Agent acme.core.builder ran it 3 times in a row",
    );
    expect(p.notes[0]!.text).toContain("Unproductive spend: $7.50 across 3 runs.");
    for (const runId of ["tse_c", "tse_b", "tse_a"])
      expect(p.notes[0]!.text).toContain(`- ${runId}: $2.50, pull request closed unmerged`);
    expect([...p.recorded]).toEqual([`${ORDER}:tse_c`]);

    for (let i = 0; i < 3; i += 1) {
      const again = await pass(streak("tse_c", "tse_b", "tse_a"));
      expect(again).toEqual({ workspaces: 1, passed: 1, found: 1, written: 0 });
    }
    expect(p.notes).toHaveLength(1);
    expect([...p.recorded]).toEqual([`${ORDER}:tse_c`]);
  });

  it("starts a fresh count after a note, so a second streak of 3 posts a second note", async () => {
    const p = provider();
    await pass(streak("tse_c", "tse_b", "tse_a"));
    expect(p.notes).toHaveLength(1);

    // One and then two new runs still share a run with the first note.
    expect(await pass(streak("tse_d", "tse_c", "tse_b"))).toMatchObject({ written: 0 });
    expect(await pass(streak("tse_e", "tse_d", "tse_c"))).toMatchObject({ written: 0 });
    expect(p.notes).toHaveLength(1);

    // Three new runs in a row make a second streak.
    expect(await pass(streak("tse_f", "tse_e", "tse_d"))).toMatchObject({ written: 1 });
    expect(p.notes).toHaveLength(2);
    expect(p.notes[1]!.text).toContain("- tse_f: $2.50");
    expect(p.notes[1]!.text).not.toContain("tse_c");
    expect([...p.recorded]).toEqual([`${ORDER}:tse_c`, `${ORDER}:tse_f`]);

    // The second streak posts once too.
    expect(await pass(streak("tse_f", "tse_e", "tse_d"))).toMatchObject({ written: 0 });
    expect(p.notes).toHaveLength(2);
  });

  it("records nothing while send_note is off, and posts the note on the next pass with it on", async () => {
    const p = provider();
    p.state.switches = { ...WRITE_BACK_DEFAULTS, send_note: false };
    expect(await pass(streak("tse_c", "tse_b", "tse_a"))).toEqual({
      workspaces: 1,
      passed: 1,
      found: 1,
      written: 0,
    });
    expect(p.notes).toHaveLength(0);
    expect(p.recorded.size).toBe(0);

    p.state.switches = { ...WRITE_BACK_DEFAULTS };
    expect(await pass(streak("tse_c", "tse_b", "tse_a"))).toMatchObject({ written: 1 });
    expect(p.notes).toHaveLength(1);
    expect([...p.recorded]).toEqual([`${ORDER}:tse_c`]);
  });

  it("records nothing while the collector is paused, and posts once it resumes", async () => {
    const p = provider();
    p.state.health = "paused";
    expect(await pass(streak("tse_c", "tse_b", "tse_a"))).toMatchObject({ written: 0 });
    expect(p.recorded.size).toBe(0);

    p.state.health = "healthy";
    expect(await pass(streak("tse_c", "tse_b", "tse_a"))).toMatchObject({ written: 1 });
    expect(p.notes).toHaveLength(1);
  });

  it("runs one pass per workspace, each in its own step and its own tenant scope", async () => {
    mocks.listWorkspacesForOutcomes.mockResolvedValue([WS_A, WS_B]);
    const p = provider();
    mocks.findWorkOrderSendBacks
      .mockResolvedValueOnce([streak("tse_c", "tse_b", "tse_a")])
      .mockResolvedValueOnce([]);
    const out = await hourly().handler({ step });
    expect(out).toEqual({ workspaces: 2, passed: 2, found: 1, written: 1 });
    expect(steps).toEqual([
      "list-workspaces",
      `send-back-${WS_A.workspaceId}`,
      `send-back-${WS_B.workspaceId}`,
    ]);
    expect(mocks.findWorkOrderSendBacks.mock.calls.map(([scope]) => scope)).toEqual([WS_A, WS_B]);
    // A workspace with nothing to send back asks for no ports.
    expect(p.installed.mock.calls).toEqual([[WS_A]]);
    expect(p.portScopes.length).toBeGreaterThan(0);
    for (const scope of p.portScopes) expect(scope).toMatchObject(WS_A);
  });

  it("goes on past a workspace whose pass fails", async () => {
    mocks.listWorkspacesForOutcomes.mockResolvedValue([WS_A, WS_B]);
    const p = provider();
    mocks.findWorkOrderSendBacks
      .mockRejectedValueOnce(new Error("Postgres is unreachable"))
      .mockResolvedValueOnce([streak("tse_c", "tse_b", "tse_a")]);
    const out = await hourly().handler({ step });
    expect(out).toEqual({ workspaces: 2, passed: 1, found: 1, written: 1 });
    expect(p.notes).toHaveLength(1);
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(mocks.warn.mock.calls[0]![0]).toMatchObject({ workspaceId: WS_A.workspaceId });
  });

  it("fails the pass, and posts nothing, in a process that installed no ports", async () => {
    const out = await pass(streak("tse_c", "tse_b", "tse_a"));
    expect(out).toEqual({ workspaces: 1, passed: 0, found: 0, written: 0 });
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(String((mocks.warn.mock.calls[0]![0] as { err: Error }).err.message)).toContain(
      "no send-back ports are installed",
    );
  });
});
