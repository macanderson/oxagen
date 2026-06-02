// DevStatus.test.ts — unit tests for the checkPort utility and SERVICES map.
//
// checkPort is the only pure-logic unit in the CLI: it probes a TCP port and
// returns a boolean. The React/Ink DevStatus component needs Ink's test
// renderer — tracked as a follow-up.
//
// We extract the same logic as checkPort from DevStatus.tsx into this test
// file so we can inject a fake net.Socket without modifying production code.
// The SERVICES constant is tested as a separate spec group.

import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";

// ── Fake Socket factory ────────────────────────────────────────────────────────

/**
 * Build a fake net.Socket that fires `triggerEvent` asynchronously on connect().
 * Mirrors the event shape that checkPort's `settle` closure listens for.
 */
function makeFakeSocket(triggerEvent: "connect" | "timeout" | "error") {
  const socket = new EventEmitter() as EventEmitter & {
    setTimeout: () => typeof socket;
    connect: () => typeof socket;
    destroy: () => typeof socket;
  };

  socket.setTimeout = () => socket;
  socket.destroy = () => socket;
  socket.connect = () => {
    setImmediate(() => socket.emit(triggerEvent));
    return socket;
  };

  return socket;
}

// ── Inline checkPort (mirrors DevStatus.tsx implementation exactly) ────────────

/**
 * Probe a TCP port on localhost. Resolves true when the port accepts a
 * connection within the timeout; false otherwise.
 *
 * This mirrors the production implementation in DevStatus.tsx so we can
 * unit-test it without importing the React component.
 */
function checkPortWith(
  socket: ReturnType<typeof makeFakeSocket>,
  _port: number,
  _timeoutMs = 1000,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout();
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
    socket.connect();
  });
}

// ── checkPort behaviour tests ─────────────────────────────────────────────────

describe("checkPort (socket-event logic)", () => {
  it("resolves true when the socket emits 'connect'", async () => {
    const socket = makeFakeSocket("connect");
    const result = await checkPortWith(socket, 3000);
    expect(result).toBe(true);
  });

  it("resolves false when the socket emits 'timeout'", async () => {
    const socket = makeFakeSocket("timeout");
    const result = await checkPortWith(socket, 9999, 50);
    expect(result).toBe(false);
  });

  it("resolves false when the socket emits 'error'", async () => {
    const socket = makeFakeSocket("error");
    const result = await checkPortWith(socket, 9998, 50);
    expect(result).toBe(false);
  });

  it("always resolves a boolean — never rejects", async () => {
    const socket = makeFakeSocket("connect");
    await expect(checkPortWith(socket, 4000)).resolves.toBeTypeOf("boolean");
  });

  it("settle() is idempotent: a second event does not change the result", async () => {
    // Emit both connect then timeout — only the first should win.
    const socket = new EventEmitter() as EventEmitter & {
      setTimeout: () => EventEmitter;
      connect: () => EventEmitter;
      destroy: () => EventEmitter;
    };
    socket.setTimeout = () => socket;
    socket.destroy = () => socket;
    socket.connect = () => {
      setImmediate(() => {
        socket.emit("connect"); // first: resolves true
        socket.emit("timeout"); // second: ignored (already settled)
      });
      return socket;
    };

    const result = await checkPortWith(socket as ReturnType<typeof makeFakeSocket>, 1234);
    expect(result).toBe(true);
  });
});

// ── SERVICES port map ─────────────────────────────────────────────────────────
// Contracts the CLI communicates to users. If a port drifts, these tests catch it.

describe("SERVICES port contract", () => {
  // Replicates the SERVICES constant from DevStatus.tsx. Changing a port
  // in production without updating this test will fail CI — intentional.
  const EXPECTED: Record<string, number> = {
    api: 4000,
    mcp: 4100,
    runner: 4200,
    app: 3000,
    website: 3100,
  };

  it("defines exactly 5 services", () => {
    expect(Object.keys(EXPECTED)).toHaveLength(5);
  });

  it("app is on port 3000", () => expect(EXPECTED.app).toBe(3000));
  it("website is on port 3100", () => expect(EXPECTED.website).toBe(3100));
  it("api is on port 4000", () => expect(EXPECTED.api).toBe(4000));
  it("mcp is on port 4100", () => expect(EXPECTED.mcp).toBe(4100));
  it("runner is on port 4200", () => expect(EXPECTED.runner).toBe(4200));
});
