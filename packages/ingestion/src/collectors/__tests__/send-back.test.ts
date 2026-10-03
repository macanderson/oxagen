// Sending a work order back to its work item (F34): one send note per work
// order, with its runs and their spend, through runWriteBack. The record keeps
// a later pass from posting the same streak twice. Nothing else on the
// provider is called, and nothing starts a run. The note links to the work
// order in Oxagen, and shows what the runs cost only on a private item.
import { describe, expect, it } from "vitest";
import { WRITE_BACK_DEFAULTS, type WriteBackSwitches } from "../file";
import type { CollectorHealth } from "../health";
import {
  type SendBackKey,
  type SendBackPorts,
  type WorkOrderToSendBack,
  sendBackNoteText,
  sendBackWorkOrders,
} from "../send-back";
import type { ItemVisibility } from "../types";
import { renderWriteBackSpend } from "../writeback";
import { createFakeCollector, erased, fakeConnection } from "./fake";

const usd = (cents: number) => ({ micros: BigInt(cents) * 10_000n, currency: "USD" });

const orderUrl = (itemId: string) => `https://app.oxagen.sh/acme/core/work/${itemId}`;

function order(name: string, over: Partial<WorkOrderToSendBack> = {}): WorkOrderToSendBack {
  return {
    orderId: `order-${name}`,
    orderPublicId: `wo_${name}`,
    itemId: `item-${name}`,
    agentKey: "acme.core.builder",
    runs: [
      { runId: `tse_${name}3`, reason: "closed_unmerged", cost: usd(300) },
      { runId: `tse_${name}2`, reason: "reverted", cost: usd(200) },
      { runId: `tse_${name}1`, reason: "abandoned", cost: null },
    ],
    ...over,
  };
}

function memoryRecord(held: SendBackKey[] = []) {
  const keys = held.map((k) => `${k.orderId}:${k.lastRunId}`);
  return {
    keys,
    async has(key: SendBackKey) {
      return keys.includes(`${key.orderId}:${key.lastRunId}`);
    },
    async add(key: SendBackKey) {
      keys.push(`${key.orderId}:${key.lastRunId}`);
    },
  };
}

function setup(
  options: {
    switches?: WriteBackSwitches;
    health?: CollectorHealth;
    held?: SendBackKey[];
    collectorless?: string[];
    unlinked?: string[];
    visibility?: ItemVisibility;
  } = {},
) {
  const fake = createFakeCollector();
  fake.visibility = options.visibility ?? "private";
  const record = memoryRecord(options.held);
  const ports: SendBackPorts = {
    async resolve(itemId) {
      if (options.collectorless?.includes(itemId)) return null;
      return {
        collector: {
          definition: erased(fake),
          switches: options.switches ?? { ...WRITE_BACK_DEFAULTS },
          health: options.health ?? "healthy",
        },
        target: { ref: { providerId: `p-${itemId}`, kind: "item" }, conn: fakeConnection() },
        orderUrl: options.unlinked?.includes(itemId) ? null : orderUrl(itemId),
      };
    },
    record,
  };
  return { fake, record, ports };
}

describe("sendBackWorkOrders", () => {
  it("returns a work order with 3 runs in a row and no outcome to its work item, with the spend attached", async () => {
    const { fake, record, ports } = setup();
    const wo = order("a");
    expect(await sendBackWorkOrders([wo], ports)).toEqual([{ orderId: "order-a", outcome: "written" }]);
    expect(fake.writeBackCalls).toEqual([
      {
        method: "note",
        providerId: "p-item-a",
        value: `${sendBackNoteText(wo, orderUrl("item-a"))}\n\n${renderWriteBackSpend({ runs: wo.runs }, { figures: true })}`,
      },
    ]);
    const note = String(fake.writeBackCalls[0]!.value);
    expect(note).toContain("Oxagen sent work order wo_a back to this work item.");
    expect(note).toContain("Agent acme.core.builder ran it 3 times in a row");
    expect(note).toContain("Unproductive spend: $5.00 across 3 runs.");
    expect(note).toContain("- tse_a3: $3.00, pull request closed unmerged");
    expect(note).toContain("Read why each run ended before you send the work again: https://app.oxagen.sh/acme/core/work/item-a");
    expect(record.keys).toEqual(["order-a:tse_a3"]);
  });

  it("on a public item, names the runs and their outcome, links to the work order, and shows no dollar figure", async () => {
    const { fake, record, ports } = setup({ visibility: "public" });
    expect(await sendBackWorkOrders([order("a")], ports)).toEqual([{ orderId: "order-a", outcome: "written" }]);
    const note = String(fake.writeBackCalls[0]!.value);
    expect(note).toContain("Oxagen sent work order wo_a back to this work item.");
    expect(note).toContain("https://app.oxagen.sh/acme/core/work/item-a");
    expect(note).toContain("- tse_a3: pull request closed unmerged");
    expect(note).toContain("- tse_a2: pull request merged, then reverted");
    expect(note).toContain("- tse_a1: run abandoned before it opened a pull request");
    expect(note).not.toContain("$");
    expect(note).not.toContain("Unproductive spend");
    expect(record.keys).toEqual(["order-a:tse_a3"]);
  });

  it("leaves the link out when Oxagen cannot name the work order's page", async () => {
    const { fake, ports } = setup({ unlinked: ["item-a"] });
    await sendBackWorkOrders([order("a")], ports);
    const note = String(fake.writeBackCalls[0]!.value);
    expect(note).toContain("Read why each run ended before you send the work again.");
    expect(note).not.toContain("https://");
  });

  it("makes the note and nothing else: no status, no close, no labels", async () => {
    const allOn = { certify_note: true, send_note: true, status: true, close: true, labels: true };
    const { fake, ports } = setup({ switches: allOn });
    await sendBackWorkOrders([order("a"), order("b")], ports);
    expect(fake.writeBackCalls.map((call) => call.method)).toEqual(["note", "note"]);
  });

  it("posts a streak once: a later pass that finds it again writes nothing", async () => {
    const { fake, ports } = setup();
    await sendBackWorkOrders([order("a")], ports);
    expect(await sendBackWorkOrders([order("a")], ports)).toEqual([{ orderId: "order-a", outcome: "already_sent" }]);
    expect(fake.writeBackCalls).toHaveLength(1);
  });

  it("posts again when a new run starts a new streak", async () => {
    const { fake, ports } = setup({ held: [{ orderId: "order-a", lastRunId: "tse_a3" }] });
    const next = order("a", {
      runs: [
        { runId: "tse_a4", reason: "closed_unmerged", cost: usd(100) },
        ...order("a").runs.slice(0, 2),
      ],
    });
    expect(await sendBackWorkOrders([next], ports)).toEqual([{ orderId: "order-a", outcome: "written" }]);
    expect(fake.writeBackCalls).toHaveLength(1);
  });

  it("records nothing when the send note is off or the collector is paused, so a later pass tries again", async () => {
    const off = setup({ switches: { ...WRITE_BACK_DEFAULTS, send_note: false } });
    expect(await sendBackWorkOrders([order("a")], off.ports)).toEqual([{ orderId: "order-a", outcome: "off" }]);
    expect(off.record.keys).toEqual([]);
    expect(off.fake.writeBackCalls).toEqual([]);

    const paused = setup({ health: "paused" });
    expect(await sendBackWorkOrders([order("a")], paused.ports)).toEqual([{ orderId: "order-a", outcome: "paused" }]);
    expect(paused.record.keys).toEqual([]);
  });

  it("skips a work item with no collector", async () => {
    const { fake, ports } = setup({ collectorless: ["item-a"] });
    expect(await sendBackWorkOrders([order("a"), order("b")], ports)).toEqual([
      { orderId: "order-a", outcome: "no_collector" },
      { orderId: "order-b", outcome: "written" },
    ]);
    expect(fake.writeBackCalls).toHaveLength(1);
  });

  it("tries every work order, then throws the first provider error", async () => {
    const { fake, record, ports } = setup();
    const writeBack = fake.definition.writeBack;
    if (!writeBack) throw new Error("the fake has write-back");
    const note = writeBack.note;
    writeBack.note = async (target, text) => {
      if (target.ref.providerId === "p-item-a") throw new Error("fake provider: the note was refused");
      await note(target, text);
    };
    await expect(sendBackWorkOrders([order("a"), order("b")], ports)).rejects.toThrow(
      "fake provider: the note was refused",
    );
    expect(record.keys).toEqual(["order-b:tse_b3"]);
  });

  it("names the work order alone when the run named no agent", () => {
    expect(sendBackNoteText(order("a", { agentKey: null }), null)).toBe(
      "Oxagen sent work order wo_a back to this work item. The work order ran 3 times in a row, and each run ended with nothing kept. Read why each run ended before you send the work again.",
    );
  });

  it("refuses a work order with no runs", async () => {
    const { ports } = setup();
    await expect(sendBackWorkOrders([order("a", { runs: [] })], ports)).rejects.toThrow("has no runs");
  });
});
