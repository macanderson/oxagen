/**
 * A short-lived MCP client over stdio for local servers (mcp-studio-spec,
 * Local servers).
 *
 * The local gateway starts a server for each delivery, runs the MCP
 * handshake, sends one tools/call or the pages of one tools/list, and stops
 * the server. Nothing stays running between calls, so a server that wedges
 * costs one call, and every call runs the package the lock pins.
 *
 * The server's stdout carries JSON-RPC, one message per line. A line that is
 * not JSON is a server logging to the wrong stream, and the client skips it.
 * The server's stderr is kept only as a short tail for the failure message,
 * with every credential the redactor recognises taken out.
 */
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { redactText } from "../../evidence/redaction";
import { TACHO_VERSION } from "../../version";
import { deadlinePassed, LocalServerError, serverFailed } from "./errors";
import type { PreparedLaunch } from "./launch";
import { callToolResultSchema, mcpToolSchema, type CallToolResult, type McpTool } from "./wire";

/** The MCP revision the client speaks in initialize. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** The longest line the client buffers from a server's stdout. */
export const DEFAULT_MAX_LINE_CHARS = 16 * 1024 * 1024;

/** How much of a server's stderr a failure message quotes. The refusal's message holds 2048 characters. */
const STDERR_TAIL_CHARS = 1024;

/** How much of a server's JSON-RPC error message a failure quotes. */
const ERROR_MESSAGE_CHARS = 512;

/** The most tools/list pages the client follows before it treats the server as broken. */
export const MAX_TOOL_PAGES = 20;

const METHOD_NOT_FOUND = -32601;

const STOPPED = "the local gateway stopped before it answered";

export interface StdioReadable {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
}

/** The part of a Node ChildProcess the client uses. */
export interface StdioChild {
  stdin: {
    write(chunk: string): unknown;
    end(): unknown;
    on(event: "error", listener: (error: Error) => void): unknown;
  };
  stdout: StdioReadable;
  stderr: StdioReadable;
  on(event: "close", listener: (code: number | null, signal: string | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(): unknown;
}

export interface StdioSpawnOptions {
  env: Record<string, string>;
  stdio: ["pipe", "pipe", "pipe"];
  windowsHide: boolean;
}

/** Starts a server. Node's `child_process.spawn` fits it. */
export type StdioSpawn = (command: string, args: string[], options: StdioSpawnOptions) => StdioChild;

export interface StdioSessionOptions {
  spawn: StdioSpawn;
  launch: Pick<PreparedLaunch, "server" | "command" | "args" | "env">;
  /** How long the whole session may run, handshake included. */
  deadlineMs: number;
  /** Aborted when the local gateway stops. */
  signal?: AbortSignal;
  maxLineChars?: number;
}

export interface ListedTools {
  tools: McpTool[];
  /** The version the server reported in initialize, when it reported one. */
  serverVersion?: string;
}

interface Pending {
  method: string;
  resolve(result: unknown): void;
  reject(error: LocalServerError): void;
}

interface Session {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  /** The server's initialize result. */
  initialized: unknown;
}

const toolListSchema = z.array(mcpToolSchema);

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withSession<T>(options: StdioSessionOptions, work: (session: Session) => Promise<T>): Promise<T> {
  const { server } = options.launch;
  const maxLineChars = options.maxLineChars ?? DEFAULT_MAX_LINE_CHARS;
  const failed = (reason: string): LocalServerError => new LocalServerError(serverFailed(server, reason));
  if (options.signal?.aborted === true) throw failed(STOPPED);

  let child: StdioChild;
  try {
    child = options.spawn(options.launch.command, [...options.launch.args], {
      env: { ...options.launch.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    throw failed(`it could not start (${errorText(error)})`);
  }

  const pending = new Map<number, Pending>();
  const decoder = new StringDecoder("utf8");
  let failure: LocalServerError | undefined;
  let nextId = 1;
  let buffer = "";
  let stderrTail = "";

  function withStderr(reason: string): string {
    const tail = redactText(stderrTail.trim());
    return tail.length === 0 ? reason : `${reason}. Its stderr ends with: ${tail}`;
  }

  function fail(error: LocalServerError): void {
    if (failure !== undefined) return;
    failure = error;
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  }

  function send(message: Record<string, unknown>): void {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  function receive(message: Record<string, unknown>): void {
    if (typeof message.method === "string") {
      // A notification needs no answer. The client answers a ping and
      // refuses every other request, since it offers the server nothing.
      if (!("id" in message)) return;
      send(
        message.method === "ping"
          ? { id: message.id, result: {} }
          : { id: message.id, error: { code: METHOD_NOT_FOUND, message: `The client does not offer ${message.method}.` } },
      );
      return;
    }
    const entry = typeof message.id === "number" ? pending.get(message.id) : undefined;
    if (entry === undefined) return;
    pending.delete(message.id as number);
    const error = objectOf(message.error);
    if (error === undefined) {
      entry.resolve(message.result);
      return;
    }
    const text = redactText(String(error.message)).slice(0, ERROR_MESSAGE_CHARS);
    entry.reject(failed(`it answered ${entry.method} with error ${String(error.code)}: ${text}`));
  }

  function receiveLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch {
      return;
    }
    const body = objectOf(message);
    if (body !== undefined) receive(body);
  }

  child.stdout.on("data", (chunk) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) receiveLine(line);
      newline = buffer.indexOf("\n");
    }
    if (buffer.length > maxLineChars) fail(failed(`it wrote a line longer than ${maxLineChars} characters`));
  });
  child.stderr.on("data", (chunk) => {
    stderrTail = (stderrTail + String(chunk)).slice(-STDERR_TAIL_CHARS);
  });
  child.on("close", (code, signal) => {
    const how = code === null ? `it stopped on signal ${String(signal)}` : `it exited with code ${code}`;
    fail(failed(withStderr(`${how} before it answered`)));
  });
  child.on("error", (error) => fail(failed(withStderr(`it could not start (${error.message})`))));
  child.stdin.on("error", (error) => fail(failed(withStderr(`its stdin closed (${error.message})`))));

  const timer = setTimeout(
    () => fail(new LocalServerError(deadlinePassed(server, options.deadlineMs))),
    options.deadlineMs,
  );
  const onAbort = (): void => fail(failed(STOPPED));
  options.signal?.addEventListener("abort", onAbort, { once: true });

  function request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (failure !== undefined) return Promise.reject(failure);
    const id = nextId;
    nextId += 1;
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { method, resolve, reject });
      send({ id, method, params });
    });
  }

  try {
    const initialized = await request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "oxagen-local-gateway", version: TACHO_VERSION },
    });
    send({ method: "notifications/initialized" });
    return await work({ request, initialized });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    child.stdin.end();
    child.kill();
  }
}

/** The version a server reported in its initialize result, when it fits the reply. */
function serverVersionOf(initialized: unknown): string | undefined {
  const version = objectOf(objectOf(initialized)?.serverInfo)?.version;
  return typeof version === "string" && version.length > 0 && version.length <= 64 ? version : undefined;
}

/** Start the server, call one tool by the name the server knows it by, and stop the server. */
export function callTool(
  options: StdioSessionOptions,
  upstream: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  return withSession(options, async ({ request }) => {
    const parsed = callToolResultSchema.safeParse(await request("tools/call", { name: upstream, arguments: args }));
    if (!parsed.success) {
      throw new LocalServerError(
        serverFailed(options.launch.server, "it answered tools/call with a result that is not an MCP CallToolResult"),
      );
    }
    return parsed.data;
  });
}

/** Start the server, read every page of its tools/list, and stop the server. */
export function listTools(options: StdioSessionOptions): Promise<ListedTools> {
  return withSession(options, async ({ request, initialized }) => {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const body = objectOf(await request("tools/list", cursor === undefined ? {} : { cursor }));
      const listed = toolListSchema.safeParse(body?.tools);
      if (!listed.success) {
        throw new LocalServerError(
          serverFailed(options.launch.server, "it answered tools/list with a result that is not an MCP tool list"),
        );
      }
      tools.push(...listed.data);
      const next = body?.nextCursor;
      if (typeof next !== "string" || next.length === 0) {
        return { tools, serverVersion: serverVersionOf(initialized) };
      }
      cursor = next;
    }
    throw new LocalServerError(
      serverFailed(options.launch.server, `its tools/list ran past ${MAX_TOOL_PAGES} pages`),
    );
  });
}
