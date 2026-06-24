// apps/cli/src/tui/__tests__/app.test.tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { Command } from "commander";
import { App } from "../app.js";

// M4: mock runCommand so form→result works without spawning a real child process.
// assembleArgv is kept real (not mocked) since it is a pure function with no
// side effects — only runCommand spawns a child process.
vi.mock("../runner.js", async () => {
  // Import the real module to re-export assembleArgv unchanged.
  const real = await vi.importActual<typeof import("../runner.js")>("../runner.js");
  return {
    ...real,
    runCommand: vi.fn(() => Promise.resolve({ code: 0 })),
  };
});

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

  // M3: 'q' with an empty filter quits; 'q' typed while a filter is active
  // appends to the filter string instead of quitting.
  it("q quits when filter is empty but appends to filter when active", async () => {
    const onExit = vi.fn();

    // Case A: empty filter → q should call onExit.
    const { stdin: stdinA } = render(<App program={program()} version="0.4.0" onExit={onExit} />);
    stdinA.write("q");
    await Promise.resolve();
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("q appends to filter when filter is active and does not quit", async () => {
    const onExit = vi.fn();
    const { lastFrame, stdin } = render(<App program={program()} version="0.4.0" onExit={onExit} />);

    // Type "c" to activate a filter, then "q" — should append, not quit.
    stdin.write("c");
    await Promise.resolve();
    stdin.write("q");
    await Promise.resolve();
    // The frame should show the filter is active and onExit is not called.
    // "cq" matches nothing in our tree, so "no matches" should render.
    const frame = lastFrame() ?? "";
    expect(frame).toContain("cq");
    expect(onExit).not.toHaveBeenCalled();
  });

  // M4: form → result flow. Selects a runnable leaf (auth → login), submits the
  // form with Enter on the only required field, then asserts the result screen.
  // runCommand is mocked at the module level above to resolve { code: 0 }.
  it("form → result: submitting a leaf command renders the result screen", async () => {
    const { lastFrame, stdin } = render(<App program={program()} version="0.4.0" />);

    // Navigate into the "auth" group (first item, cursor=0).
    stdin.write(ENTER);
    await Promise.resolve();
    expect(lastFrame()).toContain("login");

    // Select "login" (first item under auth, cursor=0).
    stdin.write(ENTER);
    // Flush state updates AND effects (useEffect runs after commit, not in microtasks).
    // setImmediate yields to the macrotask queue where effects are flushed in ink's
    // test environment (using fake-DOM / Node event loop).
    await new Promise((r) => setImmediate(r));
    // Now on the form screen for "login"; its useInput handler is now registered.
    // Verify we're on the form (sanity check before submitting).
    expect(lastFrame()).toContain("--email");

    // Submit the form — login has an --email option but no required args,
    // so Enter on the form submits immediately (active=0 = last field).
    stdin.write(ENTER);
    // runCommand is async; flush the microtask chain then yield to the scheduler:
    // 1) trySubmit() → onSubmit() → awaits runCommand mock (microtask)
    // 2) runCommand resolves → setStack called (microtask continuation)
    // 3) React schedules re-render (in legacy mode, async setState from Promise
    //    callbacks may be scheduled via a macro-task rather than a microtask)
    // 4) setImmediate yields past any pending macro-task scheduler ticks
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await new Promise((r) => setImmediate(r));
    for (let i = 0; i < 3; i++) await Promise.resolve();

    const frame = lastFrame() ?? "";
    // Result screen renders "✓ completed" for code 0.
    expect(frame).toContain("completed");
  });
});
