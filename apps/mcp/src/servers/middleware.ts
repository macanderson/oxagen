import { trackRequestWork } from "@oxagen/config/request-work";
import type { OutgoingHttpHeader, OutgoingHttpHeaders } from "node:http";
// middleware.ts: the served tools inside Oxagen's MCP endpoint (lane M15;
// mcp-studio-spec, Call path).
//
// xmcp answers /mcp with Oxagen's own tools. This middleware runs after the
// auth gate and before the transport. For tools/list it lets the transport
// answer, holds that answer, and adds the run's served tools to it. For a
// tools/call that names a published server's tool, it answers the call
// itself, in the framing the client accepts. Every other request goes on to
// the transport before any database read.
//
// The request, response, and next types are structural. xmcp types its
// middleware with Express. These interfaces name only the fields this
// middleware needs and preserve Node's response overloads.
import type { CallToolResult, EffectiveDefinition } from "@oxagen/mcp-studio";
import type { CapabilityContext } from "@oxagen/oxagen/types";
import { callServed } from "./call";
import { listServed } from "./list";
import { servedView, type ServedCache, type ServedView } from "./snapshot";
import { frameReply, rpcRequest, spliceTools, type RpcRequest } from "./splice";
import type { PublishedTools, ServedLog, ServedPorts, ServedRun } from "./types";

type HeaderValue = string | string[] | undefined;
export type ServedHeaders = Record<string, HeaderValue>;

/** The fields of an express request the middleware reads. */
export interface ServedRequest {
  method?: string;
  body?: unknown;
  headers: ServedHeaders;
}

/** The fields of a node response the middleware reads, writes, or holds. */
export interface ServedResponse {
  statusCode: number;
  writeHead(status: number, message?: string, headers?: OutgoingHttpHeaders | OutgoingHttpHeader[]): unknown;
  writeHead(status: number, headers?: OutgoingHttpHeaders | OutgoingHttpHeader[]): unknown;
  write(chunk: unknown, callback?: (error: Error | null | undefined) => void): boolean;
  write(chunk: unknown, encoding: BufferEncoding, callback?: (error: Error | null | undefined) => void): boolean;
  end(callback?: () => void): unknown;
  end(chunk: unknown, callback?: () => void): unknown;
  end(chunk: unknown, encoding: BufferEncoding, callback?: () => void): unknown;
  flushHeaders?: () => void;
  setHeader: (name: string, value: string | number | readonly string[]) => unknown;
  getHeader: (name: string) => unknown;
  removeHeader: (name: string) => void;
}

export type ServedNext = (error?: unknown) => void;

export type ServedMiddleware = (req: ServedRequest, res: ServedResponse, next: ServedNext) => void;

/** What the middleware reads through. Production binds Postgres and the request's key. */
export interface ServedMiddlewareDeps {
  /** The request's principal. Throws when the key does not resolve. */
  context(headers: ServedHeaders): Promise<CapabilityContext>;
  /** The run the principal's gateway key belongs to, or null. */
  run(ctx: CapabilityContext): Promise<ServedRun | null>;
  /** The workspace's published tools, or null. */
  published(scope: { orgId: string; workspaceId: string }): Promise<PublishedTools | null>;
  ports(run: ServedRun): ServedPorts;
  cache: ServedCache;
  log: ServedLog;
}

interface Loaded {
  view: ServedView;
  ports: ServedPorts;
}

function firstHeader(value: HeaderValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

/**
 * The run's view of the published tools, or null when the request belongs
 * to no run. A key that does not resolve belongs to none: the transport
 * answers it as it answers any other request.
 */
async function load(deps: ServedMiddlewareDeps, headers: ServedHeaders): Promise<Loaded | null> {
  let ctx: CapabilityContext;
  try {
    ctx = await deps.context(headers);
  } catch {
    return null;
  }
  const run = await deps.run(ctx);
  if (run === null) return null;
  const published = await deps.published({ orgId: run.orgId, workspaceId: run.workspaceId });
  if (published === null) return null;
  const ports = deps.ports(run);
  return { view: await servedView(published, run, ports, deps.cache), ports };
}

/** The run's served tools. A request that belongs to no run, or a read that fails, lists none. */
async function servedList(deps: ServedMiddlewareDeps, headers: ServedHeaders): Promise<EffectiveDefinition[]> {
  try {
    const loaded = await load(deps, headers);
    return loaded === null ? [] : listServed(loaded.view);
  } catch (error) {
    // Only the name: a failed read can quote the row it read.
    deps.log.warn("Oxagen could not read the served tools, so tools/list lists only its own.", { error: errorName(error) });
    return [];
  }
}

function bufferOf(chunk: unknown, encoding: unknown): Buffer | null {
  if (typeof chunk === "string") return Buffer.from(chunk, Buffer.isEncoding(String(encoding)) ? (encoding as BufferEncoding) : "utf8");
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return null;
}

interface Head {
  status: number;
  message?: string;
  headers?: OutgoingHttpHeaders;
}

function isHeaderValue(value: unknown): value is OutgoingHttpHeader | undefined {
  return value === undefined || typeof value === "string" || typeof value === "number"
    || (Array.isArray(value) && value.every((item) => typeof item === "string"));
}

function outgoingHeaders(value: unknown): OutgoingHttpHeaders | undefined {
  if (Array.isArray(value)) {
    if (value.length % 2 !== 0) return undefined;
    const headers = Object.create(null) as OutgoingHttpHeaders;
    for (let i = 0; i < value.length; i += 2) {
      const name: unknown = value[i];
      const entry: unknown = value[i + 1];
      if (typeof name !== "string" || !isHeaderValue(entry)) return undefined;
      headers[name] = entry;
    }
    return headers;
  }
  if (!isRecord(value)) return undefined;
  const headers = Object.create(null) as OutgoingHttpHeaders;
  for (const [name, entry] of Object.entries(value)) {
    if (!isHeaderValue(entry)) return undefined;
    headers[name] = entry;
  }
  return headers;
}

function headerIn(headers: Record<string, unknown> | undefined, name: string): unknown {
  if (headers === undefined) return undefined;
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
}

/** The head to send for a rewritten body: a Content-Length the transport set is recomputed. */
function headFor(head: Head, body: string): OutgoingHttpHeaders | undefined {
  if (head.headers === undefined) return undefined;
  const kept = Object.fromEntries(Object.entries(head.headers).filter(([key]) => key.toLowerCase() !== "content-length"));
  const sized = headerIn(head.headers, "content-length") === undefined ? kept : { ...kept, "content-length": Buffer.byteLength(body) };
  return sized;
}

/**
 * Hold the transport's answer until it ends, rewrite its body, then send it
 * with the status and headers the transport wrote. A body the rewrite cannot
 * read goes out as the transport wrote it.
 */
function holdAnswer(
  res: ServedResponse,
  rewrite: (body: string, contentType: string | undefined) => Promise<string>,
  log: ServedLog,
): void {
  const writeHead = res.writeHead.bind(res);
  const end = res.end.bind(res);
  const chunks: Buffer[] = [];
  let head: Head | null = null;

  const hold = (chunk: unknown, encoding: unknown): void => {
    const buffer = bufferOf(chunk, encoding);
    if (buffer !== null) chunks.push(buffer);
  };

  res.writeHead = (status: number, ...rest: unknown[]) => {
    const message = rest.find((arg): arg is string => typeof arg === "string");
    const headers = rest.map(outgoingHeaders).find((value) => value !== undefined);
    head = { status, ...(message === undefined ? {} : { message }), ...(headers === undefined ? {} : { headers: { ...headers } }) };
    return res;
  };
  res.write = (chunk: unknown, ...rest: unknown[]) => {
    hold(chunk, rest[0]);
    const done = rest.find((arg): arg is () => void => typeof arg === "function");
    if (done !== undefined) queueMicrotask(done);
    return true;
  };
  res.flushHeaders = () => {};
  res.end = (...args: unknown[]) => {
    const done = args.find((arg): arg is () => void => typeof arg === "function");
    if (typeof args[0] !== "function") hold(args[0], args[1]);
    const held = Buffer.concat(chunks).toString("utf8");
    const written: Head | null = head;
    const typed = headerIn(written?.headers, "content-type") ?? res.getHeader("content-type");
    void trackRequestWork(() => rewrite(held, typeof typed === "string" ? typed : undefined)
      .catch(() => held)
      .then((body) => {
        if (res.getHeader("content-length") !== undefined) res.setHeader("content-length", Buffer.byteLength(body));
        if (written !== null) {
          const headers = headFor(written, body);
          if (written.message === undefined) writeHead(written.status, headers);
          else writeHead(written.status, written.message, headers);
        }
        end(body, done);
      }))
      .catch((error: unknown) => {
        log.warn("Oxagen could not send the tools/list answer.", { error: errorName(error) });
      });
    return res;
  };
}

/** Send one served tools/call's answer in the framing the client accepts. */
function reply(res: ServedResponse, request: RpcRequest, result: CallToolResult, accept: string | undefined): void {
  const framed = frameReply(request.id, result, accept);
  res.statusCode = 200;
  res.setHeader("content-type", framed.contentType);
  res.end(framed.body);
}

function failure(name: string): CallToolResult {
  return {
    content: [{ type: "text", text: `Oxagen could not finish the call to ${name}. Call it again in a minute, and ask an Oxagen operator if it fails again.` }],
    isError: true,
  };
}

async function answerCall(
  deps: ServedMiddlewareDeps,
  req: ServedRequest,
  res: ServedResponse,
  next: ServedNext,
  request: RpcRequest,
  name: string,
): Promise<void> {
  let loaded: Loaded | null;
  try {
    loaded = await load(deps, req.headers);
  } catch (error) {
    deps.log.warn("Oxagen could not read the served tools, so the call went to its own tools.", { error: errorName(error) });
    next();
    return;
  }
  if (loaded === null) {
    next();
    return;
  }
  const args = isRecord(request.params["arguments"]) ? request.params["arguments"] : {};
  let result: CallToolResult | null;
  try {
    result = await callServed(loaded.view, loaded.ports, name, args);
  } catch (error) {
    deps.log.warn("A served call failed before it finished.", { tool: name, error: errorName(error) });
    result = failure(name);
  }
  if (result === null) {
    next();
    return;
  }
  reply(res, request, result, firstHeader(req.headers["accept"]));
}

/** The middleware that serves the published tools, over the ports it is given. */
export function createServedToolsMiddleware(deps: ServedMiddlewareDeps): ServedMiddleware {
  return (req, res, next) => {
    const request = req.method === "POST" ? rpcRequest(req.body) : null;
    if (request === null) {
      next();
      return;
    }
    if (request.method === "tools/list") {
      const served = trackRequestWork(() => servedList(deps, req.headers)).catch((error: unknown) => {
        deps.log.warn("Oxagen could not read the served tools.", { error: errorName(error) });
        return [];
      });
      holdAnswer(res, async (body, contentType) => spliceTools(body, contentType, request.id, await served), deps.log);
      next();
      return;
    }
    const name = request.params["name"];
    // Oxagen's own tool names hold no double underscore. A served name always does.
    if (request.method !== "tools/call" || typeof name !== "string" || !name.includes("__")) {
      next();
      return;
    }
    // answerCall guards every read and the call itself. Only writing the
    // answer can reject here, and the response is spent by then.
    trackRequestWork(() => answerCall(deps, req, res, next, request, name)).catch((error: unknown) => {
      deps.log.warn("Oxagen could not send a served call's answer.", { tool: name, error: errorName(error) });
    });
  };
}
