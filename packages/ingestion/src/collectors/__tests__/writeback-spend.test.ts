// A send note can carry spend (F34): runWriteBack adds the total and one line
// per run to the note's text, and the module's note receives the whole text.
// The figures go only on an item the module says is private. On a public one,
// and for a module that cannot say, the note lists each run and why it ended,
// with no amount (#4775).
import { describe, expect, it } from "vitest";
import { WRITE_BACK_DEFAULTS } from "../file";
import type { WriteBackTarget } from "../types";
import {
  SPEND_LEFT_OUT,
  type WriteBackCollector,
  type WriteBackSpend,
  formatWriteBackAmount,
  renderWriteBackSpend,
  runWriteBack,
} from "../writeback";
import { createFakeCollector, erased, fakeConnection } from "./fake";

const target: WriteBackTarget = {
  ref: { providerId: "101", kind: "item" },
  conn: fakeConnection(),
};

const usd = (cents: number) => ({ micros: BigInt(cents) * 10_000n, currency: "USD" });

const SPEND: WriteBackSpend = {
  runs: [
    { runId: "tse_c", reason: "abandoned", cost: null },
    { runId: "tse_b", reason: "reverted", cost: usd(824) },
    { runId: "tse_a", reason: "closed_unmerged", cost: usd(410) },
  ],
};

describe("renderWriteBackSpend", () => {
  it("leads with the total, then lists each run with its cost and why it ended", () => {
    expect(renderWriteBackSpend(SPEND, { figures: true })).toBe(
      [
        "Unproductive spend: $12.34 across 3 runs. 1 run is not priced, so the total leaves it out.",
        "- tse_c: not priced, run abandoned before it opened a pull request",
        "- tse_b: $8.24, pull request merged, then reverted",
        "- tse_a: $4.10, pull request closed unmerged",
      ].join("\n"),
    );
  });

  it("says when no run is priced, and never shows a zero total", () => {
    expect(
      renderWriteBackSpend(
        {
          runs: [
            { runId: "tse_a", reason: "closed_unmerged", cost: null },
            { runId: "tse_b", reason: "closed_unmerged", cost: null },
          ],
        },
        { figures: true },
      ).split("\n")[0],
    ).toBe("Unproductive spend: not priced for any of the 2 runs.");
  });

  it("gives one total per currency", () => {
    expect(
      renderWriteBackSpend(
        {
          runs: [
            { runId: "tse_a", reason: "closed_unmerged", cost: usd(100) },
            { runId: "tse_b", reason: "closed_unmerged", cost: { micros: 2_500_000n, currency: "EUR" } },
            { runId: "tse_c", reason: "closed_unmerged", cost: null },
            { runId: "tse_d", reason: "closed_unmerged", cost: null },
          ],
        },
        { figures: true },
      ).split("\n")[0],
    ).toBe("Unproductive spend: €2.50 and $1.00 across 4 runs. 2 runs are not priced, so the total leaves them out.");
  });

  it("shows a currency Intl does not know by its code", () => {
    expect(formatWriteBackAmount({ micros: 1_500_000n, currency: "not-a-code" })).toBe("1.50 not-a-code");
  });

  it("without figures, names each run and why it ended, and no amount", () => {
    const text = renderWriteBackSpend(SPEND, { figures: false });
    expect(text).toBe(
      [
        "- tse_c: run abandoned before it opened a pull request",
        "- tse_b: pull request merged, then reverted",
        "- tse_a: pull request closed unmerged",
        "",
        SPEND_LEFT_OUT,
      ].join("\n"),
    );
    expect(text).not.toMatch(/\$|\d\.\d\d|USD|Unproductive spend/);
  });
});

describe("runWriteBack with spend", () => {
  function collector(switches = { ...WRITE_BACK_DEFAULTS }) {
    const fake = createFakeCollector();
    const c: WriteBackCollector = { definition: erased(fake), switches, health: "healthy" };
    return { fake, collector: c };
  }

  it("posts the send note with its spend lines after the text on a private item", async () => {
    const { fake, collector: c } = collector();
    fake.visibility = "private";
    expect(await runWriteBack(c, target, { switch: "send_note", text: "Oxagen sent it back.", spend: SPEND })).toBe(
      "written",
    );
    expect(fake.writeBackCalls).toEqual([
      {
        method: "note",
        providerId: "101",
        value: `Oxagen sent it back.\n\n${renderWriteBackSpend(SPEND, { figures: true })}`,
      },
    ]);
    expect(String(fake.writeBackCalls[0]!.value)).toContain("$12.34");
  });

  it("posts the runs and their outcome with no dollar figure on a public item", async () => {
    const { fake, collector: c } = collector();
    fake.visibility = "public";
    expect(await runWriteBack(c, target, { switch: "send_note", text: "Oxagen sent it back.", spend: SPEND })).toBe(
      "written",
    );
    const note = String(fake.writeBackCalls[0]!.value);
    expect(note).toBe(`Oxagen sent it back.\n\n${renderWriteBackSpend(SPEND, { figures: false })}`);
    expect(note).toContain("- tse_b: pull request merged, then reverted");
    expect(note).not.toContain("$");
  });

  it("posts no dollar figure through a module that cannot say who reads the item", async () => {
    const { fake, collector: c } = collector();
    const writeBack = fake.definition.writeBack;
    if (!writeBack) throw new Error("the fake has write-back");
    delete writeBack.visibility;
    await runWriteBack(c, target, { switch: "send_note", text: "Oxagen sent it back.", spend: SPEND });
    expect(String(fake.writeBackCalls[0]!.value)).not.toContain("$");
  });

  it("posts nothing when the module cannot read who reads the item", async () => {
    const { fake, collector: c } = collector();
    const writeBack = fake.definition.writeBack;
    if (!writeBack) throw new Error("the fake has write-back");
    writeBack.visibility = async () => {
      throw new Error("fake provider: the repository is gone");
    };
    await expect(
      runWriteBack(c, target, { switch: "send_note", text: "Oxagen sent it back.", spend: SPEND }),
    ).rejects.toThrow("the repository is gone");
    expect(fake.writeBackCalls).toEqual([]);
  });

  it("posts the text alone when the spend lists no run", async () => {
    const { fake, collector: c } = collector();
    await runWriteBack(c, target, { switch: "send_note", text: "Sent.", spend: { runs: [] } });
    expect(fake.writeBackCalls).toEqual([{ method: "note", providerId: "101", value: "Sent." }]);
  });

  it("writes nothing when the send note is off", async () => {
    const { fake, collector: c } = collector({ ...WRITE_BACK_DEFAULTS, send_note: false });
    expect(await runWriteBack(c, target, { switch: "send_note", text: "Sent.", spend: SPEND })).toBe("off");
    expect(fake.writeBackCalls).toEqual([]);
  });
});
