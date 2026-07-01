/**
 * Regression guard for the REPL's render *mode*.
 *
 * A long-standing bug ran the REPL as a full-screen *alternate-screen* Ink app:
 * it re-rendered the whole conversation on every stream delta, which (a) garbled
 * output above the viewport on redraw and (b) left no terminal scrollback. The
 * fix renders the REPL INLINE in the normal terminal buffer (Ink's default —
 * `alternateScreen: false`) and commits finalized messages to <Static>.
 *
 * This test locks the production launch path: `launchRepl` must never opt into
 * Ink's alternate screen. Asserting Ink's render OPTIONS is deterministic —
 * unlike scraping rendered frames for the `?1049h` DECSET, which couples the
 * assertion to Ink's global TTY/CI-driven alternate-screen heuristics and so
 * flakes across environments. The alternate-screen buffer is the only thing that
 * emits `?1049h`; refusing to enable it is the invariant that matters.
 */
import { describe, it, expect, vi } from "vitest";

// Typed params so `mock.calls[n]` is a two-arg tuple (Ink's `render(node,
// options)`), letting the test read the options argument at index 1.
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

describe("launchRepl render mode", () => {
  it("renders the REPL inline — never enables Ink's alternate screen", async () => {
    await launchRepl({ session: TEST_SESSION });

    expect(renderSpy).toHaveBeenCalledTimes(1);
    const options = renderSpy.mock.calls[0]?.[1] as
      | { alternateScreen?: boolean }
      | undefined;
    // Inline mode is Ink's default: `launchRepl` must not flip the alternate
    // screen on. `undefined` (no options) and an explicit `false` both satisfy
    // the invariant; anything truthy would disable native scrollback.
    expect(options?.alternateScreen ?? false).toBe(false);
  });
});
