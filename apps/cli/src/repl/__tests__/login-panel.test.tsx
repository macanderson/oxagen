/**
 * LoginPanel — the REPL's Ink-native `/login` panel.
 *
 * Proves:
 *   - it renders the waiting state (status lines forwarded from
 *     `runBrowserLogin`'s onStatus callback) and never touches
 *     `node:readline`, which conflicts with Ink owning raw mode.
 *   - on success it calls `onLoggedIn` exactly once with the persisted
 *     session and renders a masked token (never the raw value).
 *   - on failure it shows the error state and never calls `onLoggedIn`.
 *   - Esc while a login is pending aborts it (via the AbortSignal
 *     `runBrowserLogin` is called with) and closes the panel.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "ink-testing-library";
import React from "react";

const mockRunBrowserLogin = vi.fn();
vi.mock("../../commands/auth.js", () => ({
  runBrowserLogin: (...args: unknown[]) => mockRunBrowserLogin(...args),
}));

// Regression guard: nothing in this component's tree may import
// node:readline(/promises) or call createInterface — that's exactly the
// conflict this whole Ink-native flow exists to avoid (see login-panel.tsx's
// header). If a future change reintroduces a readline-based prompt here, this
// mock turns that into a loud, immediate test failure instead of a silent
// terminal-corruption bug discovered later in a real REPL session.
const createInterfaceSpy = vi.fn(() => {
  throw new Error(
    "readline.createInterface must never be called from the REPL's Ink tree",
  );
});
vi.mock("node:readline/promises", () => ({
  createInterface: createInterfaceSpy,
}));
vi.mock("node:readline", () => ({
  createInterface: createInterfaceSpy,
}));

const { LoginPanel } = await import("../login-panel.js");

/** Poll until `cond` holds — Ink delivers stdin/state asynchronously (never fixed sleeps). */
async function until(
  cond: () => boolean,
  timeoutMs = 4000,
  stepMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline)
      throw new Error("until(): condition not met before deadline");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

describe("LoginPanel", () => {
  beforeEach(() => {
    mockRunBrowserLogin.mockReset();
    createInterfaceSpy.mockClear();
  });

  it("renders the waiting state with forwarded status lines, never touching readline", async () => {
    let settle!: (v: {
      token: string;
      orgSlug: string;
      workspaceSlug: string;
    }) => void;
    mockRunBrowserLogin.mockImplementation(
      (onStatus: (line: string) => void) => {
        onStatus("Opening browser for authentication...");
        return new Promise((resolve) => {
          settle = resolve;
        });
      },
    );

    const { lastFrame } = render(
      <LoginPanel onClose={() => {}} onLoggedIn={() => {}} />,
    );

    await until(() => (lastFrame() ?? "").includes("Opening browser"));
    expect(lastFrame()).toContain("waiting for the browser callback");
    expect(createInterfaceSpy).not.toHaveBeenCalled();

    // Let the pending promise resolve so it doesn't leak into the next test.
    settle({ token: "tok_cleanup", orgSlug: "o", workspaceSlug: "w" });
  });

  it("calls onLoggedIn exactly once with the result on success, and masks the token on screen", async () => {
    mockRunBrowserLogin.mockResolvedValue({
      token: "tok_1234567890",
      orgSlug: "acme",
      workspaceSlug: "main",
    });
    const onLoggedIn = vi.fn();

    const { lastFrame } = render(
      <LoginPanel onClose={() => {}} onLoggedIn={onLoggedIn} />,
    );

    await until(() => (lastFrame() ?? "").includes("Logged in to Oxagen"));
    expect(onLoggedIn).toHaveBeenCalledTimes(1);
    expect(onLoggedIn).toHaveBeenCalledWith({
      token: "tok_1234567890",
      orgSlug: "acme",
      workspaceSlug: "main",
    });
    expect(lastFrame()).toContain("acme");
    expect(lastFrame()).toContain("main");
    expect(lastFrame()).not.toContain("tok_1234567890");
  });

  it("shows the error state and never calls onLoggedIn when the flow rejects", async () => {
    mockRunBrowserLogin.mockRejectedValue(
      new Error("Login timed out after 5 minutes."),
    );
    const onLoggedIn = vi.fn();

    const { lastFrame } = render(
      <LoginPanel onClose={() => {}} onLoggedIn={onLoggedIn} />,
    );

    await until(() => (lastFrame() ?? "").includes("Login timed out"));
    expect(onLoggedIn).not.toHaveBeenCalled();
  });

  it("Esc while running aborts the pending login (via the AbortSignal) and closes the panel", async () => {
    let sawAbort = false;
    mockRunBrowserLogin.mockImplementation(
      (_onStatus: unknown, signal?: AbortSignal) => {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            sawAbort = true;
            reject(new Error("Login cancelled."));
          });
        });
      },
    );
    const onClose = vi.fn();

    const { stdin, lastFrame } = render(
      <LoginPanel onClose={onClose} onLoggedIn={() => {}} />,
    );
    await until(() => (lastFrame() ?? "").length > 0);

    stdin.write("\x1b"); // Esc
    await until(() => onClose.mock.calls.length > 0);

    expect(sawAbort).toBe(true);
  });
});
