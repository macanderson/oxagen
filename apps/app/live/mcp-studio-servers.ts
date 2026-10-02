/**
 * The sample servers for the MCP Studio live test (lane M17, #5139).
 *
 * The workflow starts this file in the background before the suite runs:
 *
 *   tsx live/mcp-studio-servers.ts
 *
 * It serves M0's fixtures in packages/mcp-studio/fixtures/ as four upstreams:
 *
 *   - an MCP server over streamable HTTP at /mcp, from mcp/tools-list.json
 *   - an OpenAPI service at /openapi, from openapi/openapi-3.1.yaml
 *   - a GraphQL service at /graphql, from graphql/schema.graphql
 *   - a gRPC service, a_intel.ledger.v1.Ledger, from grpc/ledger.proto
 *
 * The first three share the upstream port. The workflow exposes that port
 * through a public tunnel, because production refuses a private address, and
 * each request must carry the run's bearer token. The gRPC service listens on
 * 127.0.0.1 only. Production reaches it through a relay (apps/relay), which
 * this process starts when the suite asks.
 *
 * The control port listens on 127.0.0.1 only, and the tunnel never exposes
 * it. Through it the suite reads the calls each upstream received, changes a
 * tool's description on the MCP server, and starts or stops the relay. This
 * process outlives a Playwright worker, so a test that runs after a failed one
 * still finds the servers and the relay.
 *
 * Nothing here logs the bearer token or the relay token.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
// M7's in-process ledger server, which serves grpc/ledger.proto from the same
// descriptor set the gRPC Sender reads. Its own dependencies resolve from
// packages/mcp-studio, so apps/app needs none of them.
import {
  startLedgerServer,
  type LedgerHandlers,
  type LedgerServer,
} from "../../../packages/mcp-studio/src/execute/grpc/__tests__/ledger-server";

/** The fixtures M0 wrote. The servers read them once at start. */
const FIXTURES = new URL("../../../packages/mcp-studio/fixtures/", import.meta.url);
/** The relay bundle `pnpm --filter @oxagen/relay build` writes. */
const DEFAULT_RELAY_BUNDLE = fileURLToPath(new URL("../../relay/dist/relay.cjs", import.meta.url));
/** The largest request body any upstream or the control port reads. */
const MAX_BODY_BYTES = 1_048_576;
/** The relay log lines the control port keeps. */
const MAX_RELAY_EVENTS = 200;

// ── Settings ─────────────────────────────────────────────────────────────────

interface ServerSettings {
  token: string;
  upstreamPort: number;
  controlPort: number;
  relayBundle: string;
}

function port(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = workflowValue(env, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be a port number from 1 to 65535.`);
  }
  return value;
}

/**
 * A value the workflow sets. Like the steering rig, this file reads workflow
 * values by name from the environment, not as deployment settings, so they
 * stay out of the env registry.
 */
function workflowValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
}

function readServerSettings(env: NodeJS.ProcessEnv = process.env): ServerSettings {
  const token = workflowValue(env, "MCP_STUDIO_LIVE_UPSTREAM_TOKEN") ?? "";
  if (token.length < 16) {
    throw new Error(
      "MCP_STUDIO_LIVE_UPSTREAM_TOKEN must hold at least 16 characters. The workflow generates one for each run.",
    );
  }
  return {
    token,
    upstreamPort: port(env, "MCP_STUDIO_LIVE_UPSTREAM_PORT", 8787),
    controlPort: port(env, "MCP_STUDIO_LIVE_CONTROL_PORT", 8788),
    relayBundle: workflowValue(env, "MCP_STUDIO_LIVE_RELAY_BUNDLE") ?? DEFAULT_RELAY_BUNDLE,
  };
}

// ── Call log ─────────────────────────────────────────────────────────────────

/** One call an upstream received. */
interface ReceivedCall {
  upstream: "mcp" | "openapi" | "graphql" | "grpc";
  /** The MCP tool, the OpenAPI method and path, the GraphQL root field, or the gRPC method. */
  name: string;
  at: string;
}

const received: ReceivedCall[] = [];

function record(upstream: ReceivedCall["upstream"], name: string): void {
  received.push({ upstream, name, at: new Date().toISOString() });
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer | string>) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("The request body is larger than 1 MiB.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const text = await readBody(req);
  return text === "" ? null : (JSON.parse(text) as unknown);
}

function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  if (body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/** True when the request carries the run's bearer token. */
function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ── MCP server ───────────────────────────────────────────────────────────────

interface McpTool {
  name: string;
  description?: string;
  [key: string]: unknown;
}

/** The fixture's tools, with no cursor, so one tools/list holds them all. */
function fixtureTools(): McpTool[] {
  const parsed = JSON.parse(readFileSync(new URL("mcp/tools-list.json", FIXTURES), "utf8")) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.tools)) {
    throw new Error("packages/mcp-studio/fixtures/mcp/tools-list.json holds no tools list.");
  }
  const tools: unknown[] = parsed.tools;
  return tools.filter((tool): tool is McpTool => isRecord(tool) && typeof tool.name === "string");
}

const mcpTools = fixtureTools();
/** Descriptions the suite set through the control port, by tool name. */
const describedAs = new Map<string, string>();

function currentTools(): McpTool[] {
  return mcpTools.map((tool) => {
    const description = describedAs.get(tool.name);
    return description === undefined ? tool : { ...tool, description };
  });
}

/** Each tool's answer. The shapes follow the fixture's output schemas. */
function mcpToolResult(name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case "list_repositories": {
      const repositories = [
        { name: "billing-service", private: true },
        { name: "ledger", private: true },
      ];
      return {
        content: [{ type: "text", text: JSON.stringify({ repositories }) }],
        structuredContent: { repositories },
      };
    }
    case "create_issue": {
      const issue = { number: 7, url: "https://example.com/issues/7" };
      return { content: [{ type: "text", text: JSON.stringify(issue) }], structuredContent: issue };
    }
    case "search-code": {
      const query = typeof args.query === "string" ? args.query : "";
      return { content: [{ type: "text", text: `No code matches ${query}.` }] };
    }
    default:
      return { content: [{ type: "text", text: `No tool is named ${name}.` }], isError: true };
  }
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function serveMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === "DELETE") {
    send(res, 200);
    return;
  }
  if (req.method !== "POST") {
    send(res, 405, undefined, { allow: "POST, DELETE" });
    return;
  }
  const message = await readJson(req);
  if (!isRecord(message) || typeof message.method !== "string") {
    send(res, 400, rpcError(null, -32600, "The body is not a JSON-RPC request."));
    return;
  }
  const id = message.id;
  const method = message.method;
  const params = isRecord(message.params) ? message.params : {};
  // A notification has no id and gets no answer.
  if (id === undefined) {
    send(res, 202);
    return;
  }
  switch (method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18";
      send(
        res,
        200,
        {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: asked,
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: "oxagen-live-sample", version: "1" },
          },
        },
        { "mcp-session-id": randomUUID() },
      );
      return;
    }
    case "ping":
      send(res, 200, { jsonrpc: "2.0", id, result: {} });
      return;
    case "tools/list":
      send(res, 200, { jsonrpc: "2.0", id, result: { tools: currentTools() } });
      return;
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const args = isRecord(params.arguments) ? params.arguments : {};
      record("mcp", name);
      send(res, 200, { jsonrpc: "2.0", id, result: mcpToolResult(name, args) });
      return;
    }
    default:
      send(res, 200, rpcError(id, -32601, `The sample server does not answer ${method}.`));
  }
}

// ── OpenAPI service ──────────────────────────────────────────────────────────

/** A payment as openapi-3.1.yaml's Payment schema describes it. */
function payment(id: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    amount: typeof fields.amount === "number" ? fields.amount : 1250,
    currency: typeof fields.currency === "string" ? fields.currency : "USD",
    status: "succeeded",
    method: isRecord(fields.method) ? fields.method : { type: "card", token: "tok_live_sample" },
    note: typeof fields.note === "string" ? fields.note : null,
  };
}

async function serveOpenapi(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const paymentId = /^\/payments\/([^/]+)$/.exec(path)?.[1];
  if (req.method === "GET" && paymentId !== undefined) {
    record("openapi", "GET /payments/{payment_id}");
    send(res, 200, payment(decodeURIComponent(paymentId)));
    return;
  }
  if (req.method === "POST" && path === "/payments") {
    const body = await readJson(req);
    record("openapi", "POST /payments");
    send(res, 201, payment(`pay_${randomUUID().slice(0, 8)}`, isRecord(body) ? body : {}));
    return;
  }
  send(res, 404, { message: `The sample payments service has no ${req.method ?? "GET"} ${path}.` });
}

// ── GraphQL service ──────────────────────────────────────────────────────────

/** An issue as schema.graphql's Issue type describes it. */
function issue(number: number, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    __typename: "Issue",
    id: `Issue:${String(number)}`,
    number,
    title: typeof fields.title === "string" ? fields.title : "The sample issue",
    body: typeof fields.body === "string" ? fields.body : null,
    state: "OPEN",
    priority: typeof fields.priority === "string" ? fields.priority : "NORMAL",
    labels: Array.isArray(fields.labels) ? fields.labels : [],
    createdAt: "2026-10-02T09:00:00Z",
    closedAt: null,
    assignee: null,
    comments: {
      edges: [],
      pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
    },
    urgent: false,
  };
}

/**
 * The first field of the document's selection, such as `issue` or
 * `createIssue`. The executor sends one root field per document, with every
 * argument as a variable (packages/mcp-studio/src/execute/graphql.ts).
 */
function rootField(query: string): string | null {
  const open = query.indexOf("{");
  if (open === -1) return null;
  return /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(query.slice(open + 1))?.[1] ?? null;
}

function graphqlData(field: string, variables: Record<string, unknown>): Record<string, unknown> | null {
  const input = isRecord(variables.input) ? variables.input : {};
  switch (field) {
    case "issue":
      return { issue: issue(typeof variables.number === "number" ? variables.number : 1) };
    case "viewer":
      return { viewer: { id: "User:1", name: "Live Test", email: null } };
    case "createIssue":
      return { createIssue: { issue: issue(42, input) } };
    case "deleteIssue":
      return { deleteIssue: { deletedId: typeof variables.id === "string" ? variables.id : "Issue:1" } };
    default:
      return null;
  }
}

async function serveGraphql(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") {
    send(res, 405, undefined, { allow: "POST" });
    return;
  }
  const body = await readJson(req);
  const query = isRecord(body) && typeof body.query === "string" ? body.query : "";
  const variables = isRecord(body) && isRecord(body.variables) ? body.variables : {};
  const field = rootField(query);
  const data = field === null ? null : graphqlData(field, variables);
  if (field === null || data === null) {
    send(res, 200, { errors: [{ message: `The sample service does not answer ${field ?? "this document"}.` }] });
    return;
  }
  record("graphql", field);
  send(res, 200, { data });
}

// ── gRPC service ─────────────────────────────────────────────────────────────

/** A ledger request and reply, in protobuf's JSON form. */
type LedgerRequest = Parameters<NonNullable<LedgerHandlers["GetEntry"]>>[0];
type LedgerReply = Awaited<ReturnType<NonNullable<LedgerHandlers["GetEntry"]>>>;

/** An entry as ledger.proto's Entry message describes it. */
function entry(id: string, request: LedgerRequest = {}): LedgerReply {
  return {
    id,
    accountId: typeof request.accountId === "string" ? request.accountId : "acct_live",
    kind: typeof request.kind === "string" ? request.kind : "ENTRY_KIND_CREDIT",
    money: { amount: "1250", currency: "USD" },
    postedAt: "2026-10-02T09:00:00Z",
    manualNote: "posted by the MCP Studio live test",
  };
}

async function startLedger(): Promise<LedgerServer> {
  const ledger = await startLedgerServer();
  ledger.handlers = {
    GetEntry: (request) => {
      record("grpc", "GetEntry");
      return entry(typeof request.id === "string" ? request.id : "ent_live");
    },
    PostEntry: (request) => {
      record("grpc", "PostEntry");
      return entry(`ent_${randomUUID().slice(0, 8)}`, request);
    },
  };
  return ledger;
}

// ── Relay ────────────────────────────────────────────────────────────────────

/** What the suite sends to start the relay. Every value comes from Oxagen at run time. */
interface RelayStart {
  brokerUrl: string;
  token: string;
  name: string;
  workspace: string;
  trustedKeys: string;
}

/** One line the relay logged, with only the fields the suite reads. */
interface RelayEvent {
  event: string;
  code?: string | number;
  at: string;
}

const relay: { child: ChildProcess | null; exitCode: number | null; events: RelayEvent[] } = {
  child: null,
  exitCode: null,
  events: [],
};

function parseRelayStart(value: unknown): RelayStart | null {
  if (!isRecord(value)) return null;
  const { brokerUrl, token, name, workspace, trustedKeys } = value;
  if (
    typeof brokerUrl !== "string" ||
    typeof token !== "string" ||
    typeof name !== "string" ||
    typeof workspace !== "string" ||
    typeof trustedKeys !== "string"
  ) {
    return null;
  }
  return { brokerUrl, token, name, workspace, trustedKeys };
}

/** Keeps each JSON line's event name and code. The relay never logs a token, and this keeps nothing else. */
function keepRelayLines(text: string): void {
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || typeof parsed.event !== "string") continue;
    const code = parsed.code;
    relay.events.push({
      event: parsed.event,
      ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
      at: new Date().toISOString(),
    });
    if (relay.events.length > MAX_RELAY_EVENTS) relay.events.shift();
  }
}

function stopRelay(): void {
  relay.child?.kill("SIGTERM");
  relay.child = null;
}

function startRelay(start: RelayStart, ledger: LedgerServer, bundle: string): void {
  stopRelay();
  relay.events = [];
  relay.exitCode = null;
  const child = spawn(process.execPath, [bundle], {
    env: {
      NODE_ENV: "production",
      PATH: process.env.PATH ?? "",
      RELAY_BROKER_URL: start.brokerUrl,
      RELAY_TOKEN: start.token,
      RELAY_NAME: start.name,
      RELAY_WORKSPACE: start.workspace,
      RELAY_TRUSTED_KEYS: start.trustedKeys,
      RELAY_ALLOWED_HOSTS: `127.0.0.1:${String(ledger.port)}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (text: string) => {
    keepRelayLines(text);
  });
  // The relay writes a configuration problem to standard error. Its lines name
  // variables, never values, so the workflow log may show them.
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text: string) => {
    process.stderr.write(`relay: ${text}`);
  });
  child.on("exit", (code) => {
    relay.exitCode = code;
    if (relay.child === child) relay.child = null;
  });
  relay.child = child;
}

// ── Servers ──────────────────────────────────────────────────────────────────

function upstreamHandler(settings: ServerSettings) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = new URL(req.url ?? "/", "http://upstream").pathname;
    if (!authorized(req, settings.token)) {
      send(res, 401, { message: "The sample servers need the run's bearer token." }, { "www-authenticate": "Bearer" });
      return;
    }
    if (path === "/mcp") {
      await serveMcp(req, res);
    } else if (path === "/graphql") {
      await serveGraphql(req, res);
    } else if (path.startsWith("/openapi/")) {
      await serveOpenapi(req, res, path.slice("/openapi".length));
    } else {
      send(res, 404, { message: `The sample servers have no ${path}.` });
    }
  };
}

function controlHandler(settings: ServerSettings, ledger: LedgerServer) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = new URL(req.url ?? "/", "http://control").pathname;
    const route = `${req.method ?? "GET"} ${path}`;
    switch (route) {
      case "GET /status":
        send(res, 200, {
          grpcPort: ledger.port,
          calls: received,
          relay: { running: relay.child !== null, exitCode: relay.exitCode, events: relay.events },
        });
        return;
      case "POST /mcp/description": {
        const body = await readJson(req);
        if (!isRecord(body) || typeof body.tool !== "string" || typeof body.description !== "string") {
          send(res, 400, { message: "Send { tool, description }." });
          return;
        }
        if (!mcpTools.some((tool) => tool.name === body.tool)) {
          send(res, 404, { message: `The sample MCP server has no tool ${body.tool}.` });
          return;
        }
        describedAs.set(body.tool, body.description);
        send(res, 200, { tool: body.tool, description: body.description });
        return;
      }
      case "POST /relay/start": {
        const start = parseRelayStart(await readJson(req));
        if (start === null) {
          send(res, 400, { message: "Send { brokerUrl, token, name, workspace, trustedKeys }." });
          return;
        }
        startRelay(start, ledger, settings.relayBundle);
        send(res, 202, { started: true });
        return;
      }
      case "POST /relay/stop":
        stopRelay();
        send(res, 200, { stopped: true });
        return;
      default:
        send(res, 404, { message: `The control port has no ${route}.` });
    }
  };
}

function listen(
  name: string,
  portNumber: number,
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => {
    handler(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) send(res, 500, { message });
      else res.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // Both ports bind 127.0.0.1. The tunnel reaches the upstream port from
    // the runner itself, and nothing reaches the control port from outside.
    server.listen(portNumber, "127.0.0.1", () => {
      console.log(`${name} listening on 127.0.0.1:${String(portNumber)}`);
      resolve();
    });
  });
}

const settings = readServerSettings();
const ledger = await startLedger();
console.log(`gRPC ledger listening on 127.0.0.1:${String(ledger.port)}`);
await listen("Sample upstreams", settings.upstreamPort, upstreamHandler(settings));
await listen("Control port", settings.controlPort, controlHandler(settings, ledger));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    stopRelay();
    ledger.close();
    process.exit(0);
  });
}
