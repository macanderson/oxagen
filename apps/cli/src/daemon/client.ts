/**
 * Daemon client — CLI processes use this to communicate with the
 * persistent context daemon over a Unix socket.
 *
 * If the daemon isn't running, falls back to inline execution (slow path).
 */
import * as net from "node:net";
import * as fs from "node:fs";
import type { DaemonRequest, DaemonResponse } from "./protocol";

export class DaemonClient {
  private socketPath: string;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  /**
   * Check if the daemon is running (socket file exists and is connectable).
   */
  async isRunning(): Promise<boolean> {
    if (!fs.existsSync(this.socketPath)) return false;
    try {
      const result = await this.send({
        id: "ping",
        method: "health",
        params: {},
      });
      return result?.result !== undefined;
    } catch {
      return false;
    }
  }

  /**
   * Send a request to the daemon and wait for a response.
   * Throws if the daemon is unreachable.
   */
  async send(request: DaemonRequest): Promise<DaemonResponse> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let buffer = "";

      socket.on("connect", () => {
        socket.write(JSON.stringify(request) + "\n");
      });

      socket.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const response = JSON.parse(line) as DaemonResponse;
            socket.destroy();
            resolve(response);
            return;
          } catch {
            /* incomplete line */
          }
        }
      });

      socket.on("error", (err) => {
        reject(new Error(`Daemon connection failed: ${err.message}`));
      });

      // Timeout after 30s
      socket.setTimeout(30000, () => {
        socket.destroy();
        reject(new Error("Daemon request timed out"));
      });
    });
  }

  /**
   * Compile context via the daemon.
   */
  async compile(taskFrame: unknown, budget?: unknown): Promise<unknown> {
    const response = await this.send({
      id: crypto.randomUUID(),
      method: "compile",
      params: { taskFrame: taskFrame as never, budget: budget as never },
    });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  }

  /**
   * Query memories via the daemon.
   */
  async query(
    namespace: { org: string; workspace: string },
    limit = 50,
  ): Promise<unknown> {
    const response = await this.send({
      id: crypto.randomUUID(),
      method: "query",
      params: { namespace, limit },
    });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  }

  /**
   * Incrementally (re)build + persist the code graph for `root` (defaults to the
   * daemon's workspace root). Returns the index delta + totals.
   */
  async buildCodeGraph(root?: string): Promise<unknown> {
    const response = await this.send({
      id: crypto.randomUUID(),
      method: "graph.build",
      params: root ? { root } : {},
    });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  }

  /** Fuzzy symbol search across the persisted code graph. */
  async searchCodeGraph(
    pattern: string,
    limit = 20,
    root?: string,
  ): Promise<unknown> {
    const response = await this.send({
      id: crypto.randomUUID(),
      method: "search_graph",
      params: { pattern, limit, ...(root ? { root } : {}) },
    });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  }

  /** k-hop neighborhood of a code node from the persisted code graph. */
  async queryCodeGraph(
    nodeId: string,
    opts: { hops?: number; edgeTypes?: string[]; root?: string } = {},
  ): Promise<unknown> {
    const response = await this.send({
      id: crypto.randomUUID(),
      method: "graph.query",
      params: { nodeId, ...opts },
    });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  }

  /**
   * Fork a recorded session at a given event index. Sessions are populated
   * in-memory as `compile()` is called with a `taskFrame.sessionId`; forking
   * creates a new session sharing that prefix, returned as
   * `{ sessionId, parentId, forkPoint, status }`.
   */
  async forkSession(sessionId: string, forkPoint: number): Promise<unknown> {
    const response = await this.send({
      id: crypto.randomUUID(),
      method: "session.fork",
      params: { sessionId, forkPoint },
    });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  }

  /**
   * Analyze a recorded session for determinism and extract its per-turn
   * metrics (compile time, tokens, cache hit rate, tool calls, outcome).
   */
  async replaySession(sessionId: string): Promise<unknown> {
    const response = await this.send({
      id: crypto.randomUUID(),
      method: "session.replay",
      params: { sessionId },
    });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  }

  /** List every session (root or forked) recorded by this daemon instance. */
  async listSessions(): Promise<unknown> {
    const response = await this.send({
      id: crypto.randomUUID(),
      method: "session.list",
      params: {},
    });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  }

  /**
   * Ask the daemon to shut down gracefully.
   */
  async shutdown(): Promise<void> {
    await this.send({
      id: crypto.randomUUID(),
      method: "shutdown",
      params: {},
    });
  }
}
