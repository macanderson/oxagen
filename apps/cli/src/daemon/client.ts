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
      const result = await this.send({ id: "ping", method: "health", params: {} });
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
          } catch { /* incomplete line */ }
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
  async query(namespace: { org: string; workspace: string }, limit = 50): Promise<unknown> {
    const response = await this.send({
      id: crypto.randomUUID(),
      method: "query",
      params: { namespace, limit },
    });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  }

  /**
   * Ask the daemon to shut down gracefully.
   */
  async shutdown(): Promise<void> {
    await this.send({ id: crypto.randomUUID(), method: "shutdown", params: {} });
  }
}
