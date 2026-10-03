/**
 * Unit tests for src/shutdown.ts: the API finishes its requests when a deploy
 * replaces it (#5318).
 */

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { drainOnSignal, type SignalSource } from "../shutdown";

function fakeServer() {
  let closed: ((error?: Error) => void) | undefined;
  return {
    close: vi.fn((callback?: (error?: Error) => void) => {
      closed = callback;
    }),
    closeIdleConnections: vi.fn(),
    /** The last open connection ends, so Node calls the close callback. */
    finish: (error?: Error) => closed?.(error),
  };
}

function setup() {
  const server = fakeServer();
  const log = { info: vi.fn(), error: vi.fn() };
  const exit = vi.fn();
  const signals = new EventEmitter();
  drainOnSignal(server, log, exit, signals as unknown as SignalSource);
  return { server, log, exit, signals };
}

describe("drainOnSignal", () => {
  it("closes the port on SIGTERM and exits 0 only once the open requests finish", () => {
    const { server, log, exit, signals } = setup();
    signals.emit("SIGTERM", "SIGTERM");
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(server.closeIdleConnections).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      { signal: "SIGTERM" },
      "api closing its port and finishing the requests in progress",
    );
    expect(exit).not.toHaveBeenCalled();
    server.finish();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("drains the same way on SIGINT", () => {
    const { server, exit, signals } = setup();
    signals.emit("SIGINT", "SIGINT");
    expect(server.close).toHaveBeenCalledTimes(1);
    server.finish();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("closes the server once when a second signal arrives during the drain", () => {
    const { server, signals } = setup();
    signals.emit("SIGTERM", "SIGTERM");
    signals.emit("SIGINT", "SIGINT");
    expect(server.close).toHaveBeenCalledTimes(1);
  });

  it("does nothing before a signal arrives (negative)", () => {
    const { server, exit } = setup();
    expect(server.close).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("exits 1 and logs the error when the close fails (negative)", () => {
    const { server, log, exit, signals } = setup();
    signals.emit("SIGTERM", "SIGTERM");
    const error = new Error("Server is not running.");
    server.finish(error);
    expect(log.error).toHaveBeenCalledWith({ err: error }, "api closed with an error");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("works with a server that has no idle-connection close, such as HTTP/2", () => {
    const close = vi.fn((callback?: (error?: Error) => void) => callback?.());
    const exit = vi.fn();
    const signals = new EventEmitter();
    drainOnSignal({ close }, { info: vi.fn(), error: vi.fn() }, exit, signals as unknown as SignalSource);
    signals.emit("SIGTERM", "SIGTERM");
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
