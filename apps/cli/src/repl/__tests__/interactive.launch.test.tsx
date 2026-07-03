/**
 * Regression guard for the REPL's render *mode*.
 *
 * The REPL renders INLINE, in the terminal's normal screen buffer: `launchRepl`
 * must never switch to the alternate screen buffer (DECSET/DECRST 1049), on a
 * real TTY or off one. Inline rendering is what lets finished output commit to
 * the terminal's own scrollback (via Ink's `<Static>`) so the user can scroll
 * back with a trackpad/mouse/Shift-PageUp — the alternate buffer has no native
 * scrollback, which is exactly the bug this locks against re-introducing.
 *
 * This test locks that contract deterministically by driving `process.stdout`'s
 * `isTTY` and capturing writes, rather than scraping Ink's frames (which couples
 * to Ink's global TTY/CI heuristics and flakes).
 */
import { describe, it, expect, vi, afterEach } from "vitest";

// DECSET/DECRST 1049 — switch to / restore from the alternate screen buffer.
// Hardcoded here (rather than imported) because the REPL no longer has any
// production code that needs these constants; the test exists solely to prove
// launchRepl never emits them.
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
  });

  it("never enters the alternate screen on a real TTY", async () => {
    setTTY(true);
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
