import { describe, it, expect } from "vitest";
import {
  FANOUT_BADGE,
  RUN_BADGE,
  isFanoutLive,
  formatDuration,
  formatBytes,
  progressLabel,
  relativeTime,
} from "./fanout-ui";

describe("fanout-ui badge maps", () => {
  it("maps every fan-out status to a label + variant", () => {
    for (const status of ["pending", "running", "completed", "partial", "timed_out"] as const) {
      expect(FANOUT_BADGE[status].label.length).toBeGreaterThan(0);
      expect(FANOUT_BADGE[status].variant).toBeTruthy();
    }
  });

  it("maps every run status to a label + variant", () => {
    for (const status of ["pending", "running", "completed", "failed"] as const) {
      expect(RUN_BADGE[status].label.length).toBeGreaterThan(0);
      expect(RUN_BADGE[status].variant).toBeTruthy();
    }
  });
});

describe("isFanoutLive", () => {
  it("is true for pending and running", () => {
    expect(isFanoutLive("pending")).toBe(true);
    expect(isFanoutLive("running")).toBe(true);
  });
  it("is false for terminal statuses", () => {
    expect(isFanoutLive("completed")).toBe(false);
    expect(isFanoutLive("partial")).toBe(false);
    expect(isFanoutLive("timed_out")).toBe(false);
  });
});

describe("formatDuration", () => {
  it("returns em dash for null", () => {
    expect(formatDuration(null)).toBe("—");
  });
  it("formats sub-second as ms", () => {
    expect(formatDuration(250)).toBe("250ms");
  });
  it("formats seconds with one decimal", () => {
    expect(formatDuration(2500)).toBe("2.5s");
  });
  it("formats minutes and seconds", () => {
    expect(formatDuration(95_000)).toBe("1m 35s");
  });
});

describe("formatBytes", () => {
  it("handles zero and negatives", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
  });
  it("formats bytes, KB, and MB", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("progressLabel", () => {
  it("renders completed / total", () => {
    expect(progressLabel(1, 3)).toBe("1 / 3");
  });
});

describe("relativeTime", () => {
  const now = new Date("2026-06-16T00:01:00.000Z").getTime();
  it("renders seconds ago", () => {
    expect(relativeTime("2026-06-16T00:00:30.000Z", now)).toBe("30s ago");
  });
  it("renders minutes ago", () => {
    expect(relativeTime("2026-06-15T23:59:00.000Z", now)).toBe("2m ago");
  });
  it("renders hours ago", () => {
    expect(relativeTime("2026-06-15T22:01:00.000Z", now)).toBe("2h ago");
  });
  it("falls back to a date for anything over a day", () => {
    expect(relativeTime("2026-06-10T00:00:00.000Z", now)).toBe("2026-06-10");
  });
  it("returns the raw value for an unparseable input", () => {
    expect(relativeTime("not-a-date", now)).toBe("not-a-date");
  });
});
