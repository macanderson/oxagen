/**
 * Tacho collector P2: an unhandled rejection anywhere in the process — one of
 * the daemon's own fire-and-forget lanes (the git reconciliation lane, the
 * model proxy listener's retrying bind) — used to crash `tachod` outright,
 * turning a bug in one lane into a host that stops recording and shipping
 * until systemd restarts it. `main.ts` now logs and keeps the process alive.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./run", () => ({
  runDaemonProcess: vi.fn().mockResolvedValue(undefined),
}));

describe("tachod unhandled rejection safety net", () => {
  afterEach(() => {
    process.removeAllListeners("unhandledRejection");
    vi.resetModules();
  });

  it("logs an unhandled rejection instead of leaving Node to crash the process", async () => {
    const before = process.listenerCount("unhandledRejection");
    await import("./main");
    expect(process.listenerCount("unhandledRejection")).toBe(before + 1);

    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      process.emit(
        "unhandledRejection",
        new Error("git lane rejected without a catch"),
        Promise.reject(new Error("unused")).catch(() => undefined),
      );
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining(
          "tachod: unhandled rejection: git lane rejected without a catch",
        ),
      );
    } finally {
      stderr.mockRestore();
    }
  });
});
