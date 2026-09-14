import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/run-record", () => ({ ledgerStore: vi.fn() }));

import {
  compactionCutoff,
  HOT_WINDOW_MONTHS,
} from "./evidence.frame-compaction";

describe("evidence.frame-compaction", () => {
  it("cuts thirteen calendar months before now, so a seal inside the hot window is never compacted", () => {
    expect(HOT_WINDOW_MONTHS).toBe(13);
    expect(
      compactionCutoff(new Date("2026-09-03T04:00:00.000Z")).toISOString(),
    ).toBe("2025-08-03T04:00:00.000Z");
    expect(
      compactionCutoff(new Date("2026-01-31T00:00:00.000Z")).toISOString(),
    ).toBe("2024-12-31T00:00:00.000Z");
  });
});
