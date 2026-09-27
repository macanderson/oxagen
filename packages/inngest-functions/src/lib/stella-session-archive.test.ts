import { describe, expect, it } from "vitest";
import {
  STELLA_ARCHIVE_AFTER_DAYS_DEFAULT,
  STELLA_ARCHIVE_AFTER_DAYS_SETTING,
} from "@oxagen/oxagen/steering-repo/workspace";
import { archiveAfterDays, archiveCutoff } from "./stella-session-archive";

const NOW = new Date("2026-09-26T04:30:00.000Z");

describe("the Stella session archive window (#4435)", () => {
  it("reads the settings key the steering sync writes", () => {
    expect(STELLA_ARCHIVE_AFTER_DAYS_SETTING).toBe("stellaArchiveAfterDays");
  });

  it("uses the days a workspace publishes", () => {
    expect(archiveAfterDays({ stellaArchiveAfterDays: 30 })).toBe(30);
    expect(archiveAfterDays({ stellaArchiveAfterDays: 1 })).toBe(1);
    expect(archiveAfterDays({ stellaArchiveAfterDays: 365 })).toBe(365);
  });

  it("waits 7 days when a workspace publishes none", () => {
    expect(STELLA_ARCHIVE_AFTER_DAYS_DEFAULT).toBe(7);
    expect(archiveAfterDays({})).toBe(7);
    expect(archiveAfterDays({ runEnrichmentEnabled: true })).toBe(7);
    expect(archiveAfterDays(null)).toBe(7);
    expect(archiveAfterDays("not a bag")).toBe(7);
  });

  it.each([
    ["zero", 0],
    ["a negative number", -3],
    ["more than a year", 366],
    ["part of a day", 2.5],
    ["a string", "14"],
    ["a boolean", true],
    ["null", null],
    ["not a number", Number.NaN],
  ])("falls back to 7 days for %s", (_name, value) => {
    expect(archiveAfterDays({ stellaArchiveAfterDays: value })).toBe(7);
  });

  it("puts the cutoff that many whole days before now, per workspace", () => {
    expect(archiveCutoff(NOW, 7)).toEqual(new Date("2026-09-19T04:30:00.000Z"));
    expect(archiveCutoff(NOW, 30)).toEqual(
      new Date("2026-08-27T04:30:00.000Z"),
    );
    expect(archiveCutoff(NOW, 1)).toEqual(new Date("2026-09-25T04:30:00.000Z"));
  });
});
