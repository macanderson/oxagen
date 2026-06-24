// apps/cli/src/tui/__tests__/app.test.tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { Command } from "commander";
import { App } from "../app.js";

function program(): Command {
  const p = new Command("oxagen").description("Oxagen developer CLI");
  const auth = p.command("auth").description("Authentication");
  auth.command("login").description("Authenticate").option("--email <e>", "Email").action(() => {});
  auth.command("logout").description("Sign out").action(() => {});
  p.command("chat").description("Chat & messaging");
  return p;
}

// ink 7 keyboard constants.
// Note: React state updates from useInput flush asynchronously — await a
// Promise.resolve() (or setImmediate in real-timer tests) after each write
// to let the scheduler flush before asserting lastFrame().
const ENTER = "\r";
// ESC has a ~20ms debounce in ink 7: a bare \x1b is parked until the timer
// fires to confirm it is not the start of a longer escape sequence.
// Use vi.useFakeTimers() + vi.advanceTimersByTime(25) to flush it.
const ESC = "\x1b";

describe("App", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders banner + top-level groups", () => {
    const { lastFrame } = render(<App program={program()} version="0.4.0" />);
    const frame = lastFrame() ?? "";
    expect(frame.toLowerCase()).toContain("oxagen");
    expect(frame).toContain("auth");
    expect(frame).toContain("chat");
  });

  it("drills into a group and back out", async () => {
    const { lastFrame, stdin } = render(<App program={program()} version="0.4.0" />);

    // ENTER drills into "auth" (first item). useInput state update is async —
    // await Promise.resolve() to let the scheduler flush before asserting.
    stdin.write(ENTER);
    await Promise.resolve();
    expect(lastFrame()).toContain("login");
    expect(lastFrame()).toContain("logout");

    // ESC goes back to groups. ink 7 debounces bare ESC for 20ms.
    // Switch to fake timers, write ESC, advance past debounce, then flush
    // the React state update with Promise.resolve().
    vi.useFakeTimers();
    stdin.write(ESC);
    vi.advanceTimersByTime(25);
    await Promise.resolve();
    expect(lastFrame()).toContain("chat");
  });

  it("filters the current list as you type", async () => {
    const { lastFrame, stdin } = render(<App program={program()} version="0.4.0" />);
    stdin.write("ch");
    // Two characters → two sequential state updates. Await twice to let both
    // schedule and flush through the React scheduler.
    await Promise.resolve();
    await Promise.resolve();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("chat");
    expect(frame).not.toContain("auth");
  });
});
