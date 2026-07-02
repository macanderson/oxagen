/**
 * Regression guard for the REPL's render *mode*.
 *
 * The REPL runs FULL-SCREEN so the prompt bar can stay pinned to the bottom edge
 * of the terminal: `launchRepl` switches to the alternate screen buffer before
 * Ink's first paint (so no frame lands in the normal buffer) and restores the
 * normal buffer on exit (so the user's terminal + scrollback come back intact).
 * The alternate-screen dance must happen ONLY on a real TTY — piped/redirected
 * output and tests must never see the control sequences.
 *
 * This test locks that contract deterministically by driving `process.stdout`'s
 * `isTTY` and capturing writes, rather than scraping Ink's frames (which couples
 * to Ink's global TTY/CI heuristics and flakes).
 */
import { describe, it, expect, vi, afterEach } from "vitest";

// Ink's render is mocked so launchRepl exercises only the terminal setup/teardown
// around it — no real component render, no real Ink stdout writes.
const renderSpy = vi.fn((_node?: unknown, _options?: unknown) => ({
  waitUntilExit: async () => undefined,
}));

vi.mock("ink", () => ({
  render: renderSpy,
}));

const { launchRepl } = await import("../interactive.js");
const { ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN } = await import(
  "../use-terminal-size.js"
);

const TEST_SESSION = {
  token: "test-token",
  orgSlug: "test-org",
  workspaceSlug: "test-ws",
  apiUrl: "http://localhost:4000",
};

/** Replace process.stdout.isTTY for one test, restoring it afterwards. */
function setTTY(value: boolean): void {
  Object.defineProperty(process.stdout, "isTTY", {
    value,
    configurable: true,
  });
}

describe("launchRepl full-screen setup", () => {
  const originalIsTTY = process.stdout.isTTY;

  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalIsTTY,
      configurable: true,
    });
    renderSpy.mockClear();
    vi.restoreAllMocks();
  });

  it("enters the alternate screen before render and restores it on exit (TTY)", async () => {
    setTTY(true);
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    await launchRepl({ session: TEST_SESSION });

    const enterIdx = writes.findIndex((w) => w.includes(ENTER_ALT_SCREEN));
    const leaveIdx = writes.findIndex((w) => w.includes(LEAVE_ALT_SCREEN));
    // Both the enter and the restore happened…
    expect(enterIdx).toBeGreaterThanOrEqual(0);
    expect(leaveIdx).toBeGreaterThanOrEqual(0);
    // …and the alt buffer was entered before it was left.
    expect(enterIdx).toBeLessThan(leaveIdx);
    expect(renderSpy).toHaveBeenCalledTimes(1);
  });

  it("never emits alt-screen control sequences off a TTY (pipes / tests)", async () => {
    setTTY(false);
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    await launchRepl({ session: TEST_SESSION });

    expect(
      writes.some(
        (w) => w.includes(ENTER_ALT_SCREEN) || w.includes(LEAVE_ALT_SCREEN),
      ),
    ).toBe(false);
    expect(renderSpy).toHaveBeenCalledTimes(1);
  });
});
