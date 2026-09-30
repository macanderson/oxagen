// Write-back runs only for the switches the collector file turns on.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  WRITE_BACK_DEFAULTS,
  WRITE_BACK_SWITCHES,
  type WriteBackSwitches,
  readCollectorFile,
  resolveWriteBack,
} from "../file";
import type { CollectorHealth } from "../health";
import type { WriteBackTarget } from "../types";
import { type WriteBackCollector, type WriteBackRequest, runWriteBack } from "../writeback";
import { createFakeCollector, erased, fakeConnection } from "./fake";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(here, "../../../../work/fixtures/collectors");

const target: WriteBackTarget = {
  ref: { providerId: "101", kind: "item" },
  conn: fakeConnection(),
};

/** One request for each switch, in the spec's order. */
const REQUESTS: readonly WriteBackRequest[] = [
  { switch: "certify_note", text: "Oxagen certified the fix in the done record." },
  { switch: "send_note", text: "Oxagen sent the fix for review." },
  { switch: "status", status: "solved" },
  { switch: "close" },
  { switch: "labels", labels: { priority: "P1", type: "bug" } },
];

function collectorWith(
  switches: WriteBackSwitches,
  options: { health?: CollectorHealth; withWriteBack?: boolean } = {},
) {
  const fake = createFakeCollector({ withWriteBack: options.withWriteBack });
  const collector: WriteBackCollector = {
    definition: erased(fake),
    switches,
    health: options.health ?? "healthy",
  };
  return { fake, collector };
}

async function runAll(collector: WriteBackCollector) {
  const outcomes: string[] = [];
  for (const request of REQUESTS) outcomes.push(await runWriteBack(collector, target, request));
  return outcomes;
}

describe("runWriteBack", () => {
  it("writes the two notes and nothing else under the defaults", async () => {
    const { fake, collector } = collectorWith({ ...WRITE_BACK_DEFAULTS });
    expect(await runAll(collector)).toEqual(["written", "written", "off", "off", "off"]);
    expect(fake.writeBackCalls).toEqual([
      { method: "note", providerId: "101", value: "Oxagen certified the fix in the done record." },
      { method: "note", providerId: "101", value: "Oxagen sent the fix for review." },
    ]);
  });

  it("makes every write when every switch is on", async () => {
    const allOn = Object.fromEntries(WRITE_BACK_SWITCHES.map((name) => [name, true])) as WriteBackSwitches;
    const { fake, collector } = collectorWith(allOn);
    expect(await runAll(collector)).toEqual(["written", "written", "written", "written", "written"]);
    expect(fake.writeBackCalls.map((call) => call.method)).toEqual([
      "note",
      "note",
      "status",
      "close",
      "labels",
    ]);
    expect(fake.writeBackCalls[2]).toEqual({ method: "status", providerId: "101", value: "solved" });
    expect(fake.writeBackCalls[4]).toEqual({
      method: "labels",
      providerId: "101",
      value: { priority: "P1", type: "bug" },
    });
  });

  it("makes no write when every switch is off", async () => {
    const allOff = Object.fromEntries(WRITE_BACK_SWITCHES.map((name) => [name, false])) as WriteBackSwitches;
    const { fake, collector } = collectorWith(allOff);
    expect(await runAll(collector)).toEqual(["off", "off", "off", "off", "off"]);
    expect(fake.writeBackCalls).toEqual([]);
  });

  it("writes only the one switch a file turns on", async () => {
    const { fake, collector } = collectorWith(resolveWriteBack("zendesk", { certify_note: false, send_note: false, close: true }));
    expect(await runAll(collector)).toEqual(["off", "off", "off", "written", "off"]);
    expect(fake.writeBackCalls).toEqual([{ method: "close", providerId: "101" }]);
  });

  it("makes no write while the collector is paused", async () => {
    const { fake, collector } = collectorWith({ ...WRITE_BACK_DEFAULTS }, { health: "paused" });
    expect(await runAll(collector)).toEqual(["paused", "paused", "off", "off", "off"]);
    expect(fake.writeBackCalls).toEqual([]);
  });

  it("reports unsupported for a module with no write-back", async () => {
    const { collector } = collectorWith({ ...WRITE_BACK_DEFAULTS }, { withWriteBack: false });
    expect(await runWriteBack(collector, target, { switch: "send_note", text: "Sent." })).toBe("unsupported");
  });

  it("lets a module error reach the caller", async () => {
    const { fake, collector } = collectorWith({ ...WRITE_BACK_DEFAULTS });
    const writeBack = fake.definition.writeBack;
    if (!writeBack) throw new Error("the fake has write-back");
    writeBack.note = async () => {
      throw new Error("fake provider: the note was refused");
    };
    await expect(runWriteBack(collector, target, { switch: "certify_note", text: "Certified." })).rejects.toThrow(
      "fake provider: the note was refused",
    );
  });

  it("follows the spec's Zendesk file: notes on, the rest off", async () => {
    const path = "work/collectors/support-zendesk.toml";
    const text = readFileSync(resolve(FIXTURES, "support-zendesk.toml"), "utf8");
    const read = readCollectorFile(path, text);
    if (!read.ok) throw new Error(read.errors.join("; "));
    const { fake, collector } = collectorWith(read.file.writeBack);
    expect(await runAll(collector)).toEqual(["written", "written", "off", "off", "off"]);
    expect(fake.writeBackCalls.map((call) => call.method)).toEqual(["note", "note"]);
  });
});
