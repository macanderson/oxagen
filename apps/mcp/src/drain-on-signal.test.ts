import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { installDrain } from "../drain-on-signal.cjs";

/**
 * Guards the preload that lets the MCP server finish its requests when a
 * deploy replaces it (#5318). xmcp's server handles no signal of its own.
 */

type Fake = {
  closed: ((error?: Error) => void) | undefined;
  close: ReturnType<typeof vi.fn>;
  closeIdleConnections: ReturnType<typeof vi.fn>;
  listen(...args: unknown[]): unknown;
};

function setup() {
  // A class of its own per test, so each install wraps a fresh listen.
  class FakeServer {
    closed: ((error?: Error) => void) | undefined;
    close = vi.fn((callback?: (error?: Error) => void) => {
      this.closed = callback;
    });
    closeIdleConnections = vi.fn();
    listen(..._args: unknown[]): unknown {
      return this;
    }
  }
  const signals = new EventEmitter();
  const exit = vi.fn();
  const log = vi.fn();
  const { servers } = installDrain({ net: { Server: FakeServer }, signals: signals as never, exit, log });
  const server = (): Fake => new FakeServer();
  return { signals, exit, log, servers, server };
}

describe("drain-on-signal", () => {
  it("records each server that listens, and closes it on SIGTERM", () => {
    const { signals, exit, servers, server: make } = setup();
    const server = make();
    server.listen(4100);
    expect(servers.has(server as never)).toBe(true);
    signals.emit("SIGTERM", "SIGTERM");
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(server.closeIdleConnections).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    server.closed?.();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("exits only once every server has closed", () => {
    const { signals, exit, server: make } = setup();
    const first = make();
    const second = make();
    first.listen(4100);
    second.listen(4101);
    signals.emit("SIGINT", "SIGINT");
    first.closed?.();
    expect(exit).not.toHaveBeenCalled();
    second.closed?.();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("closes once when a second signal arrives during the drain", () => {
    const { signals, server: make } = setup();
    const server = make();
    server.listen(4100);
    signals.emit("SIGTERM", "SIGTERM");
    signals.emit("SIGINT", "SIGINT");
    expect(server.close).toHaveBeenCalledTimes(1);
  });

  it("exits 1 when a server closes with an error (negative)", () => {
    const { signals, exit, log, server: make } = setup();
    const server = make();
    server.listen(4100);
    signals.emit("SIGTERM", "SIGTERM");
    server.closed?.(new Error("Server is not running."));
    expect(exit).toHaveBeenCalledWith(1);
    expect(log).toHaveBeenCalledWith("mcp: a server closed with an error: Server is not running.");
  });

  it("exits at once when nothing is listening", () => {
    const { signals, exit } = setup();
    signals.emit("SIGTERM", "SIGTERM");
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("does nothing before a signal arrives (negative)", () => {
    const { exit, server: make } = setup();
    const server = make();
    server.listen(4100);
    expect(server.close).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});
