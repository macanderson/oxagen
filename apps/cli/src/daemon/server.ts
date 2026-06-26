/**
 * Context daemon server — persistent local service that maintains
 * warm Engram indexes, code graph state, and session state across
 * CLI invocations.
 *
 * Communicates via Unix socket using the JSON-RPC protocol defined
 * in protocol.ts. Auto-shuts down after configurable idle timeout.
 */
import * as net from "node:net";
import * as fs from "node:fs";
import type { DaemonRequest, DaemonResponse, DaemonConfig } from "./protocol";
import { DAEMON_ERRORS } from "./protocol";

export class ContextDaemon {
  private server: net.Server | null = null;
  private config: DaemonConfig;
  private lastActivity: number = Date.now();
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: DaemonConfig) {
    this.config = config;
  }

  /**
   * Start the daemon. Binds to Unix socket and begins accepting connections.
   */
  async start(): Promise<void> {
    // Remove stale socket file if it exists
    if (fs.existsSync(this.config.socketPath)) {
      fs.unlinkSync(this.config.socketPath);
    }

    this.server = net.createServer((socket) => {
      this.handleConnection(socket);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.config.socketPath, () => resolve());
      this.server!.on("error", reject);
    });

    // Write PID file
    fs.writeFileSync(this.config.pidFile, String(process.pid));

    // Start idle timer
    this.idleTimer = setInterval(() => {
      if (Date.now() - this.lastActivity > this.config.idleTimeoutMs) {
        this.shutdown();
      }
    }, 60000);
  }

  /**
   * Graceful shutdown.
   */
  async shutdown(): Promise<void> {
    if (this.idleTimer) clearInterval(this.idleTimer);
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    // Clean up socket and PID files
    try { fs.unlinkSync(this.config.socketPath); } catch { /* ignore */ }
    try { fs.unlinkSync(this.config.pidFile); } catch { /* ignore */ }
  }

  private handleConnection(socket: net.Socket): void {
    this.lastActivity = Date.now();
    let buffer = "";

    socket.on("data", (data) => {
      buffer += data.toString();
      // Process complete lines (newline-delimited JSON)
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        this.handleRequest(line.trim(), socket);
      }
    });

    socket.on("error", () => { /* client disconnected */ });
  }

  private async handleRequest(raw: string, socket: net.Socket): Promise<void> {
    this.lastActivity = Date.now();

    let request: DaemonRequest;
    try {
      request = JSON.parse(raw) as DaemonRequest;
    } catch {
      this.sendResponse(socket, {
        id: "unknown",
        error: { code: DAEMON_ERRORS.PARSE_ERROR, message: "Invalid JSON" },
      });
      return;
    }

    try {
      const result = await this.dispatch(request);
      this.sendResponse(socket, { id: request.id, result });
    } catch (err) {
      this.sendResponse(socket, {
        id: request.id,
        error: {
          code: DAEMON_ERRORS.INTERNAL_ERROR,
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  private async dispatch(request: DaemonRequest): Promise<unknown> {
    switch (request.method) {
      case "health":
        return { status: "ok", uptime: process.uptime(), pid: process.pid };
      case "shutdown":
        setImmediate(() => this.shutdown());
        return { status: "shutting_down" };
      case "compile":
        // Delegate to engram compile()
        return this.handleCompile(request.params);
      case "query":
        return this.handleQuery(request.params);
      case "recall":
        return this.handleRecall(request.params);
      case "graph.query":
        return this.handleGraphQuery(request.params);
      case "graph.search":
        return this.handleGraphSearch(request.params);
      default:
        throw new Error(`Method not found: ${request.method}`);
    }
  }

  private async handleCompile(params: { taskFrame: unknown; budget: unknown }): Promise<unknown> {
    // Lazy import to avoid loading at daemon startup
    const { compile, computeBudget, createStore, TemporalRetrievalEngine } = await import("@oxagen/engram");
    const store = createStore({ adapter: "duckdb", duckdbPath: this.config.dbPath });
    const engines = [new TemporalRetrievalEngine(store)];
    const taskFrame = params.taskFrame as Parameters<typeof compile>[0];
    const budget = (params.budget ?? computeBudget(taskFrame.modelId)) as Parameters<typeof compile>[1];
    const window = await compile(taskFrame, budget, { engines, store });
    await store.close();
    return window;
  }

  private async handleQuery(params: { namespace: { org: string; workspace: string }; kinds?: string[]; limit?: number }): Promise<unknown> {
    const { createStore } = await import("@oxagen/engram");
    const store = createStore({ adapter: "duckdb", duckdbPath: this.config.dbPath });
    const records = await store.query({ namespace: params.namespace, kinds: params.kinds as never, limit: params.limit ?? 50 });
    await store.close();
    return { records };
  }

  private async handleRecall(params: { recordId: string }): Promise<unknown> {
    const { createStore } = await import("@oxagen/engram");
    const store = createStore({ adapter: "duckdb", duckdbPath: this.config.dbPath });
    const record = await store.getById(params.recordId);
    await store.close();
    return { record };
  }

  private async handleGraphQuery(_params: { nodeId: string; hops?: number; edgeTypes?: string[] }): Promise<unknown> {
    // Code graph queries will be wired in when the graph builder is complete
    return { nodes: [], edges: [] };
  }

  private async handleGraphSearch(_params: { pattern: string; limit?: number }): Promise<unknown> {
    return { results: [] };
  }

  private sendResponse(socket: net.Socket, response: DaemonResponse): void {
    try {
      socket.write(JSON.stringify(response) + "\n");
    } catch { /* client may have disconnected */ }
  }
}
