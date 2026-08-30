/**
 * Regression guard for the REPL's render *mode*.
 *
 * On a real TTY, `launchRepl` now takes over the alternate screen buffer:
 * ReplApp renders a full-screen dashboard (header/viewport/dock) with its OWN
 * in-app scroll (see scroll.ts, fullscreen-chrome.tsx), so it no longer needs
 * the terminal's native scrollback the way the classic inline mode does. Off a
 * TTY (tests, pipes) `useTerminalSize` reports `fullscreen: false` and ReplApp
 * falls back to the inline render — finished output committed via Ink's
 * `<Static>` into the terminal's own scrollback — so `launchRepl` must never
 * touch the alternate screen there.
 *
 * This test locks the contract deterministically by driving `process.stdout`'s
 * `isTTY` and capturing writes, rather than scraping Ink's frames (which
 * couples to Ink's global TTY/CI heuristics and flakes). `ink.render` is
 * mocked, so ReplApp's actual component tree never renders here — only
 * launchRepl's own terminal setup/teardown is exercised.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

// DECSET/DECRST 1049 — switch to / restore from the alternate screen buffer.
// Hardcoded here (rather than imported) so this test proves the literal bytes
// launchRepl writes, independent of alt-screen.ts's own implementation.
const ENTER_ALT_SCREEN = "\x1b[?1049h";
const LEAVE_ALT_SCREEN = "\x1b[?1049l";

// Ink's render is mocked so launchRepl exercises only the terminal setup/teardown
// around it — no real component render, no real Ink stdout writes.
const renderSpy = vi.fn((_node?: unknown, _options?: unknown) => ({
  waitUntilExit: async () => undefined,
}));

vi.mock("ink", () => ({
  render: renderSpy,
}));

const { launchRepl } = await import("../interactive.js");

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

describe("launchRepl render mode", () => {
  const originalIsTTY = process.stdout.isTTY;

  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalIsTTY,
      configurable: true,
    });
    renderSpy.mockClear();
    vi.restoreAllMocks();
    process.removeAllListeners("exit");
  });

  it("enters the alternate screen on a real TTY, and leaves it again on exit", async () => {
    setTTY(true);
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    await launchRepl({ session: TEST_SESSION });

    const joined = writes.join("");
    expect(joined).toContain(ENTER_ALT_SCREEN);
    expect(joined).toContain(LEAVE_ALT_SCREEN);
    // Entered before it was left.
    expect(joined.indexOf(ENTER_ALT_SCREEN)).toBeLessThan(
      joined.indexOf(LEAVE_ALT_SCREEN),
    );
    expect(renderSpy).toHaveBeenCalledTimes(1);
  });

  it("never enters the alternate screen off a TTY (pipes / tests)", async () => {
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
