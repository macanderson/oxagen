/**
 * Context daemon server — persistent local service that maintains
 * warm context-engine indexes, code graph state, and session state across
 * CLI invocations.
 *
 * Communicates via Unix socket using the JSON-RPC protocol defined
 * in protocol.ts. Auto-shuts down after configurable idle timeout.
 */
import * as net from "node:net";
import * as fs from "node:fs";
import {
  startRssWatchdog,
  resolveBoundBytes,
  type BoundHandle,
} from "@oxagen/agent-engine";
import type { DaemonRequest, DaemonResponse, DaemonConfig } from "./protocol";
import { DAEMON_ERRORS } from "./protocol";
import type { CodeGraph, CodeEdgeType } from "./code-graph/types";
import type { Session, TaskFrame } from "@oxagen/engram";
import type { ContextWindow } from "@oxagen/engram";

/**
 * In-memory session registry cap. Sessions are recorded per `compile` call
 * and the daemon can live for days — without a cap the Map grows without
 * limit. Insertion order == recording order, so evicting the oldest entry is
 * an LRU-by-creation policy; a forked/replayed session older than the window
 * reports SESSION_NOT_FOUND, exactly as after a daemon restart.
 */
const MAX_RECORDED_SESSIONS = 200;

/**
 * Per-connection line-buffer cap, in JS string units (UTF-16 code units, not
 * bytes — the buffer is decoded text). A client that streams data without a
 * newline would otherwise grow `buffer` forever; 8M chars comfortably exceeds
 * any legitimate single JSON-RPC request (compile taskFrames are KBs).
 */
const MAX_SOCKET_BUFFER_CHARS = 8 * 1024 * 1024;

/** Default daemon RSS ceiling (2 GB); override via OXAGEN_DAEMON_MAX_RSS_MB. */
const DEFAULT_DAEMON_MAX_RSS_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * RPC-level error carrying a JSON-RPC error code (see DAEMON_ERRORS). Thrown
 * by handlers that need a specific code (e.g. SESSION_NOT_FOUND) rather than
 * the generic INTERNAL_ERROR every other thrown Error maps to.
 */
class DaemonRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export class ContextDaemon {
  private server: net.Server | null = null;
  private config: DaemonConfig;
  private lastActivity: number = Date.now();
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Sessions recorded via `compile` calls that carry a `taskFrame.sessionId`.
   * In-memory only — resets on daemon restart. Backs the session.fork /
   * session.replay / session.list RPCs (@oxagen/engram's event-sourced
   * Session model — see session/fork.ts and session/replay.ts).
   */
  private readonly sessions = new Map<string, Session>();
  private rssWatchdog: BoundHandle | null = null;

  constructor(config: DaemonConfig) {
    this.config = config;
  }

  /** Register a session, evicting the oldest once the registry is full. */
  private recordSession(session: Session): void {
    while (this.sessions.size >= MAX_RECORDED_SESSIONS) {
      const oldest = this.sessions.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    this.sessions.set(session.id, session);
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

    // RSS watchdog: the daemon is the CLI's one always-on process. Warn at
    // 80% of the ceiling, shut down gracefully at 100% — a restart with cold
    // caches beats an OOM-killed daemon holding the DuckDB write lock.
    const maxRssBytes =
      this.config.maxRssBytes ??
      resolveBoundBytes(
        "OXAGEN_DAEMON_MAX_RSS_MB",
        DEFAULT_DAEMON_MAX_RSS_BYTES,
      );
    this.rssWatchdog = startRssWatchdog({
      maxRssBytes,
      onWarn: (rss, max) => {
        console.error(
          `[oxagen-daemon] rss ${Math.round(rss / 1024 / 1024)} MB is above 80% of the ` +
            `${Math.round(max / 1024 / 1024)} MB ceiling (OXAGEN_DAEMON_MAX_RSS_MB to raise).`,
        );
      },
      onLimit: (rss, max) => {
        console.error(
          `[oxagen-daemon] rss ${Math.round(rss / 1024 / 1024)} MB reached the ` +
            `${Math.round(max / 1024 / 1024)} MB ceiling — shutting down gracefully. ` +
            `It restarts on the next CLI call; raise OXAGEN_DAEMON_MAX_RSS_MB if this recurs.`,
        );
        process.exitCode = 1;
        void this.shutdown();
      },
    });
  }

  /**
   * Graceful shutdown.
   */
  async shutdown(): Promise<void> {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.rssWatchdog?.stop();
    this.rssWatchdog = null;
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    // Clean up socket and PID files
    try {
      fs.unlinkSync(this.config.socketPath);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(this.config.pidFile);
    } catch {
      /* ignore */
    }
  }

  private handleConnection(socket: net.Socket): void {
    this.lastActivity = Date.now();
    let buffer = "";

    socket.on("data", (data) => {
      buffer += data.toString();
      // A newline-free flood must not grow the buffer without limit: reject
      // the oversized request and drop the connection (protocol violation).
      if (buffer.length > MAX_SOCKET_BUFFER_CHARS) {
        buffer = "";
        // Stop reading first so continued flood bytes can't re-buffer, then
        // flush the error and half-close; end() (unlike destroy()) lets the
        // reply reach the client before the FIN.
        socket.removeAllListeners("data");
        socket.pause();
        this.sendResponse(socket, {
          id: "unknown",
          error: {
            code: DAEMON_ERRORS.PARSE_ERROR,
            message: `Request exceeds ${MAX_SOCKET_BUFFER_CHARS} characters without a newline`,
          },
        });
        socket.end();
        // Backstop: a client mid-flood can't complete the half-close (its
        // queued writes never drain once we stop reading) — force-drop the
        // connection shortly after the reply has had time to flush.
        const killTimer = setTimeout(() => socket.destroy(), 500);
        killTimer.unref?.();
        socket.once("close", () => clearTimeout(killTimer));
        return;
      }
      // Process complete lines (newline-delimited JSON)
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        this.handleRequest(line.trim(), socket);
      }
    });

    socket.on("error", () => {
      /* client disconnected */
    });
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
          code:
            err instanceof DaemonRpcError
              ? err.code
              : DAEMON_ERRORS.INTERNAL_ERROR,
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
        // Delegate to the Oxagen context engine compile()
        return this.handleCompile(request.params);
      case "query":
        return this.handleQuery(request.params);
      case "recall":
        return this.handleRecall(request.params);
      case "graph.build":
        return this.handleGraphBuild(request.params);
      case "graph.query":
        return this.handleGraphQuery(request.params);
      case "search_graph":
        return this.handleGraphSearch(request.params);
      case "session.fork":
        return this.handleSessionFork(request.params);
      case "session.replay":
        return this.handleSessionReplay(request.params);
      case "session.list":
        return this.handleSessionList();
      default:
        throw new Error(`Method not found: ${request.method}`);
    }
  }

  private async handleCompile(params: {
    taskFrame: unknown;
    budget: unknown;
  }): Promise<unknown> {
    // Lazy import to avoid loading at daemon startup
    const { compile, computeBudget, createStore, TemporalRetrievalEngine } =
      await import("@oxagen/engram");
    const store = createStore({
      adapter: "duckdb",
      duckdbPath: this.config.dbPath,
    });
    const engines = [new TemporalRetrievalEngine(store)];
    const taskFrame = params.taskFrame as Parameters<typeof compile>[0];
    const budget = (params.budget ??
      computeBudget(taskFrame.modelId)) as Parameters<typeof compile>[1];
    const window = await compile(taskFrame, budget, { engines, store });
    await store.close();
    // Record this compile as one turn of the taskFrame's session, if it names
    // one. This is what actually populates the session registry that
    // session.fork / session.replay / session.list operate on.
    if (taskFrame.sessionId) {
      await this.recordCompileTurn(taskFrame.sessionId, taskFrame, window);
    }
    return window;
  }

  /**
   * Append a session_start (on first use)/turn_start/context_compiled/turn_end
   * sequence to the named session's in-memory event log. Each `compile` RPC
   * call is treated as one turn — the daemon has no visibility into the model
   * call that happens after compile(), so turn_end is recorded immediately
   * with an optimistic "success" outcome.
   */
  private async recordCompileTurn(
    sessionId: string,
    taskFrame: TaskFrame,
    window: ContextWindow,
  ): Promise<void> {
    const { createSession, appendEvent } = await import("@oxagen/engram");
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = createSession(sessionId, taskFrame.namespace);
      this.recordSession(session);
    }
    const turnId = crypto.randomUUID();
    appendEvent(session, "turn_start", turnId, { taskFrame });
    appendEvent(session, "context_compiled", turnId, {
      candidatesRetrieved: window.metadata.candidatesRetrieved,
      candidatesPacked: window.metadata.candidatesPacked,
      candidatesEvicted: window.metadata.candidatesEvicted,
      totalTokens: window.tokenUsage.total,
      cacheHitRate: window.cachePrefix.hitRate,
      compileMs: window.metadata.totalMs,
    });
    appendEvent(session, "turn_end", turnId, {
      outcome: "success",
      totalTokens: window.tokenUsage.total,
      durationMs: window.metadata.totalMs,
    });
  }

  /**
   * Fork a recorded session at a given event index (session/fork.ts's
   * forkSession). The new session is registered so it can itself be listed,
   * replayed, or forked again.
   */
  private async handleSessionFork(params: {
    sessionId: string;
    forkPoint: number;
  }): Promise<unknown> {
    const parent = this.sessions.get(params.sessionId);
    if (!parent) {
      throw new DaemonRpcError(
        DAEMON_ERRORS.SESSION_NOT_FOUND,
        `Session not found: ${params.sessionId}`,
      );
    }
    const { forkSession } = await import("@oxagen/engram");
    const newSessionId = crypto.randomUUID();
    const forked = forkSession(parent, params.forkPoint, newSessionId);
    this.recordSession(forked);
    return {
      sessionId: forked.id,
      parentId: forked.parentId ?? null,
      forkPoint: forked.forkPoint ?? null,
      status: forked.status,
    };
  }

  /**
   * Analyze a recorded session's determinism (session/replay.ts's
   * analyzeReplay) and extract its per-turn metrics (extractTurnMetrics),
   * including the parent-prefix history if the session was forked
   * (getFullHistory).
   */
  private async handleSessionReplay(params: {
    sessionId: string;
  }): Promise<unknown> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new DaemonRpcError(
        DAEMON_ERRORS.SESSION_NOT_FOUND,
        `Session not found: ${params.sessionId}`,
      );
    }
    const { analyzeReplay, extractTurnMetrics, getFullHistory } = await import(
      "@oxagen/engram"
    );
    const replay = analyzeReplay(session);
    const turns = extractTurnMetrics(session);
    const history = getFullHistory(
      session,
      (id) => this.sessions.get(id) ?? null,
    );
    return { replay, turns, inheritedEventCount: history.inherited };
  }

  /** List every session (root or forked) recorded by this daemon instance. */
  private handleSessionList(): unknown {
    return {
      sessions: [...this.sessions.values()].map((s) => ({
        sessionId: s.id,
        parentId: s.parentId ?? null,
        forkPoint: s.forkPoint ?? null,
        status: s.status,
        eventCount: s.events.length,
        createdAt: s.createdAt,
      })),
    };
  }

  private async handleQuery(params: {
    namespace: { org: string; workspace: string };
    kinds?: string[];
    limit?: number;
  }): Promise<unknown> {
    const { createStore } = await import("@oxagen/engram");
    const store = createStore({
      adapter: "duckdb",
      duckdbPath: this.config.dbPath,
    });
    const records = await store.query({
      namespace: params.namespace,
      kinds: params.kinds as never,
      limit: params.limit ?? 50,
    });
    await store.close();
    return { records };
  }

  private async handleRecall(params: { recordId: string }): Promise<unknown> {
    const { createStore } = await import("@oxagen/engram");
    const store = createStore({
      adapter: "duckdb",
      duckdbPath: this.config.dbPath,
    });
    const record = await store.getById(params.recordId);
    await store.close();
    return { record };
  }

  /**
   * Open the persistent code-graph store, ensure `root` is indexed (building it
   * on first use so even the very first query after a cold daemon start
   * answers), load the graph, run `fn`, and always close the store. Opening
   * per-request — like the engram handlers above — keeps the DuckDB write lock
   * short so a co-located `oxagen` agent process can use the same store between
   * requests instead of being starved.
   */
  private async withCodeGraph<T>(
    root: string,
    fn: (graph: CodeGraph) => T,
  ): Promise<T> {
    const { createCodeGraphStore } = await import("./code-graph/store.js");
    const { buildAndPersistCodeGraph } = await import(
      "./code-graph/builder.js"
    );
    const store = createCodeGraphStore({
      duckdbPath: this.config.codeGraphDbPath,
    });
    try {
      if ((await store.stats(root)).files === 0) {
        await buildAndPersistCodeGraph(root, store);
      }
      return fn(await store.loadGraph(root));
    } finally {
      await store.close();
    }
  }

  /** Incrementally (re)build + persist the code graph; report the delta + totals. */
  private async handleGraphBuild(params: { root?: string }): Promise<unknown> {
    const root = params.root ?? this.config.workspaceRoot;
    const { createCodeGraphStore } = await import("./code-graph/store.js");
    const { buildAndPersistCodeGraph } = await import(
      "./code-graph/builder.js"
    );
    const store = createCodeGraphStore({
      duckdbPath: this.config.codeGraphDbPath,
    });
    try {
      const delta = await buildAndPersistCodeGraph(root, store);
      return { root, ...delta, ...(await store.stats(root)) };
    } finally {
      await store.close();
    }
  }

  private async handleGraphQuery(params: {
    nodeId: string;
    hops?: number;
    edgeTypes?: string[];
    root?: string;
  }): Promise<unknown> {
    const root = params.root ?? this.config.workspaceRoot;
    const { neighbors } = await import("./code-graph/query.js");
    return this.withCodeGraph(root, (graph) =>
      neighbors(
        graph,
        params.nodeId,
        params.hops ?? 1,
        params.edgeTypes as CodeEdgeType[] | undefined,
      ),
    );
  }

  private async handleGraphSearch(params: {
    pattern: string;
    limit?: number;
    root?: string;
  }): Promise<unknown> {
    const root = params.root ?? this.config.workspaceRoot;
    const { searchSymbols } = await import("./code-graph/query.js");
    return this.withCodeGraph(root, (graph) => ({
      results: searchSymbols(graph, params.pattern, params.limit ?? 20),
    }));
  }

  private sendResponse(socket: net.Socket, response: DaemonResponse): void {
    try {
      socket.write(JSON.stringify(response) + "\n");
    } catch {
      /* client may have disconnected */
    }
  }
}
