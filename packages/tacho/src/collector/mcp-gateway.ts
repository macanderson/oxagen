/**
 * The local MCP gateway (ADR-069, connected tier).
 *
 * Any MCP client on this machine connects to `http://127.0.0.1:<port>/mcp`
 * and gets the workspace's toolbelt, without ever holding an Oxagen
 * credential. The gateway holds it. A non-developer will not paste a token
 * into a JSON file, and asking them to would put the credential on the least
 * protected surface on the machine; the app *is* the credential.
 *
 * It is a **proxy, not a second materialiser.** `@oxagen/tacho` is a leaf
 * package with no `@oxagen/*` runtime dependency, so nothing here imports
 * `materializeTools`, `mcp-rbac` or `tool-budget` — and that constraint
 * pushes toward the right shape anyway. The JSON-RPC envelope is forwarded to
 * the workspace MCP endpoint with the host's own API key, which is already a
 * first-class Oxagen API key bound to the enrolling org and workspace, and
 * already resolves through the remote MCP context path. So there is exactly
 * one tool materialiser, one RBAC evaluation, one entitlement gate and one
 * meter, and they are the ones that already exist on the control plane.
 *
 * ADR-043 holds with no exception: this serves tools and records evidence. It
 * never runs a turn, never calls a model and never spawns a worker.
 *
 * What the gateway adds on top of the forward:
 *
 *   1. **Attribution.** A call that cannot be attributed to an org and a
 *      workspace is refused, never defaulted. Attribution rides the host key,
 *      so a daemon with no loadable enrollment has nothing to present and says
 *      so rather than guessing.
 *   2. **A tool ceiling.** When the mandate's bundle names one, a `tools/list`
 *      that would materialise past it fails with a message naming the model,
 *      the limit and the count — the shape `TooManyToolsForProviderError` uses
 *      on the control plane — rather than a gateway error about a number
 *      nobody can inspect.
 *   3. **Evidence.** Every proxied call is sealed on this connection's chain
 *      with `enforcement_tier: "gateway"`, so the record says what it is: a
 *      call Oxagen served and could refuse, not a step it merely observed.
 *
 * The browser guard lives in `loopback-guard.ts` and runs for every request on
 * the TCP listener, not only these.
 */
import type { PolicyBundle } from "../wire";

/** JSON-RPC 2.0, the subset MCP uses. */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

/**
 * JSON-RPC reserved codes, plus the two MCP adds for an unknown method and a
 * refused call. `-32002` is MCP's "request refused"; we use it for every
 * governance refusal so a client renders it as a decision rather than a bug.
 */
export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INTERNAL_ERROR = -32603;
export const RPC_REFUSED = -32002;

/** The org and workspace a call is billed and recorded against. */
export interface GatewayAttribution {
  organizationId: string;
  workspaceId: string;
  orgSlug: string;
  workspaceSlug: string;
  apiKey: string;
  hostEnrollmentId: string;
}

/**
 * What the mandate says about how many tools may be advertised. Absent means
 * *no ceiling this build has been told about*, which is not the same as no
 * ceiling — the same reading `PROVIDER_TOOL_LIMITS` documents for a provider
 * missing from its table.
 */
export interface ToolCeiling {
  modelId: string;
  maxTools: number;
  /** Where the number comes from, quoted into the refusal. */
  source: string;
}

/** The response shape the gateway's HTTP caller needs. */
export interface GatewayHttpResponse {
  status: number;
  body: unknown;
}

export type GatewayFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface McpGatewayDeps {
  /**
   * Attribution for this host, or undefined when there is none to be had —
   * no enrollment, a revoked one, or a host file that does not parse. The
   * gateway asks on every call rather than caching, so a revoke takes effect
   * on the next call rather than the next restart.
   */
  attribution: () => GatewayAttribution | undefined;
  /** The workspace MCP endpoint, e.g. `https://mcp.oxagen.sh/mcp`. */
  endpoint: string;
  fetch: GatewayFetch;
  /** The current policy bundle, for the tool ceiling. */
  bundle?: () => PolicyBundle | undefined;
  /**
   * Seal an event on the connection's chain. The daemon supplies this; the
   * gateway does not know what a recorder is.
   */
  record?: (event: GatewayCallRecord) => void;
  log?: (line: string) => void;
  timeoutMs?: number;
  /** Injected in tests. */
  now?: () => number;
}

/** One proxied call, as the daemon needs it to seal an event. */
export interface GatewayCallRecord {
  /** The MCP session the call arrived on, which is the chain it lands on. */
  sessionId: string;
  /** The connected app, from the `initialize` handshake. */
  client: string;
  toolName: string;
  status: "ok" | "error" | "rejected";
  durationMs: number;
  /** Set when the control plane refused the call. */
  refusedReason?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** The protocol revision the gateway speaks; forwarded verbatim otherwise. */
export const GATEWAY_SERVER_INFO = {
  name: "oxagen",
  version: "2.1.1",
} as const;

export function rpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

/**
 * Parse one JSON-RPC request. Batches are refused rather than forwarded: MCP
 * removed batching in the 2025-06-18 revision, and a gateway that silently
 * half-supported it would record one event for several calls.
 */
export function parseJsonRpc(
  body: unknown,
): { ok: true; request: JsonRpcRequest } | { ok: false; error: JsonRpcError } {
  if (Array.isArray(body)) {
    return {
      ok: false,
      error: {
        code: RPC_INVALID_REQUEST,
        message:
          "this gateway does not accept JSON-RPC batches; MCP removed them in revision 2025-06-18",
      },
    };
  }
  if (body === null || typeof body !== "object") {
    return {
      ok: false,
      error: { code: RPC_INVALID_REQUEST, message: "expected a JSON object" },
    };
  }
  const message = body as Partial<JsonRpcRequest>;
  if (message.jsonrpc !== "2.0") {
    return {
      ok: false,
      error: {
        code: RPC_INVALID_REQUEST,
        message: 'expected "jsonrpc": "2.0"',
      },
    };
  }
  if (typeof message.method !== "string" || message.method.length === 0) {
    return {
      ok: false,
      error: { code: RPC_INVALID_REQUEST, message: "expected a method" },
    };
  }
  return { ok: true, request: message as JsonRpcRequest };
}

/**
 * The refusal for a toolbelt that will not fit. Worded as
 * `TooManyToolsForProviderError` words it, because the operator who reads this
 * in Claude Desktop and the one who reads it in a server log are looking at
 * the same problem and should be able to search for the same sentence.
 */
export function tooManyToolsMessage(
  ceiling: ToolCeiling,
  toolCount: number,
): string {
  return `this mandate materialises ${toolCount} tools, and ${ceiling.modelId} accepts at most ${ceiling.maxTools} (${ceiling.source}). The tool list was not served, because the provider would refuse it. Narrow the mandate's toolbelt, or pin the workspace to a model without this limit.`;
}

/** The tool ceiling a bundle declares, or undefined when it declares none. */
export function ceilingOf(
  bundle: PolicyBundle | undefined,
): ToolCeiling | undefined {
  const declared = (bundle as { tool_ceiling?: unknown } | undefined)
    ?.tool_ceiling;
  if (declared === null || typeof declared !== "object") return undefined;
  const {
    model_id: modelId,
    max_tools: maxTools,
    source,
  } = declared as {
    model_id?: unknown;
    max_tools?: unknown;
    source?: unknown;
  };
  if (typeof modelId !== "string" || typeof maxTools !== "number")
    return undefined;
  return {
    modelId,
    maxTools,
    source: typeof source === "string" ? source : "the workspace mandate",
  };
}

/**
 * A streamable-HTTP response may be `application/json` or an SSE stream. We
 * ask for JSON, but a server is free to answer with a stream anyway, so a
 * body that looks like SSE is reduced to its last `data:` payload — which for
 * a single request/response exchange is the response.
 */
export function readRpcBody(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  if (!/^(event|id|retry|data):/m.test(trimmed)) {
    return JSON.parse(trimmed) as unknown;
  }
  let last: string | undefined;
  for (const line of trimmed.split(/\r?\n/)) {
    if (line.startsWith("data:")) last = line.slice(5).trim();
  }
  if (last === undefined) return undefined;
  return JSON.parse(last) as unknown;
}

/** How many tools a `tools/list` result carries, or undefined if not one. */
export function toolCountOf(result: unknown): number | undefined {
  if (result === null || typeof result !== "object") return undefined;
  const tools = (result as { tools?: unknown }).tools;
  return Array.isArray(tools) ? tools.length : undefined;
}

export interface McpGateway {
  /**
   * Handle one JSON-RPC message. `sessionId` is the MCP session the transport
   * assigned; `enrollmentId` is the one carried in the path, when the client
   * used the scoped URL.
   */
  handle: (
    body: unknown,
    context: { sessionId: string; enrollmentId?: string },
  ) => Promise<GatewayHttpResponse>;
  /** The app on a session, once `initialize` has named it. */
  clientOf: (sessionId: string) => string | undefined;
  /** Forget a session's client name when the connection closes. */
  forget: (sessionId: string) => void;
}

export function createMcpGateway(deps: McpGatewayDeps): McpGateway {
  const clients = new Map<string, string>();
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => undefined);

  async function forward(
    request: JsonRpcRequest,
    attribution: GatewayAttribution,
  ): Promise<{ status: number; body: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    try {
      const response = await deps.fetch(deps.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${attribution.apiKey}`,
          "Content-Type": "application/json",
          // JSON only: the gateway answers one request at a time and has no
          // stream to hand a client. A server that streams anyway is handled
          // by `readRpcBody`.
          Accept: "application/json",
          "User-Agent": "oxagen-local-gateway",
          "X-Tacho-Host": attribution.hostEnrollmentId,
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      const text = await response.text();
      return { status: response.status, body: readRpcBody(text) };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    clientOf: (sessionId) => clients.get(sessionId),
    forget: (sessionId) => {
      clients.delete(sessionId);
    },
    handle: async (body, context) => {
      const parsed = parseJsonRpc(body);
      if (!parsed.ok) {
        return {
          status: 400,
          body: {
            jsonrpc: "2.0",
            id: null,
            error: parsed.error,
          } satisfies JsonRpcResponse,
        };
      }
      const request = parsed.request;
      const id = request.id ?? null;

      const attribution = deps.attribution();
      if (attribution === undefined) {
        // Never defaulted. A call Oxagen cannot attribute is a call it cannot
        // govern, meter or record, and serving it would put an ungoverned
        // action in the ledger under nobody's name.
        log("mcp gateway refused a call: this machine has no enrollment");
        return {
          status: 403,
          body: rpcError(
            id,
            RPC_REFUSED,
            "this machine is not enrolled, so a call cannot be attributed to an organization and workspace. Sign in and enroll in the Oxagen app, then restart this app.",
          ),
        };
      }

      if (
        context.enrollmentId !== undefined &&
        context.enrollmentId !== attribution.hostEnrollmentId
      ) {
        // A config file left behind by a previous enrollment. Refusing is the
        // honest answer: the tools that entry expected belonged to another
        // workspace.
        return {
          status: 403,
          body: rpcError(
            id,
            RPC_REFUSED,
            "this entry was written by an earlier enrollment of this machine. Reconnect the app in Oxagen to refresh it.",
          ),
        };
      }

      if (request.method === "initialize") {
        const name = clientNameOf(request.params);
        if (name !== undefined) clients.set(context.sessionId, name);
      }

      const startedAt = now();
      let response: { status: number; body: unknown };
      try {
        response = await forward(request, attribution);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`mcp gateway forward failed: ${message}`);
        recordCall(request, context, "error", now() - startedAt, message);
        return {
          status: 502,
          body: rpcError(
            id,
            RPC_INTERNAL_ERROR,
            `the Oxagen control plane could not be reached: ${message}`,
          ),
        };
      }

      const rpc = response.body as JsonRpcResponse | undefined;

      // A `tools/list` that overflows the mandate's ceiling is refused here,
      // with the provider's own numbers, rather than served and refused later
      // by a provider the user cannot see.
      if (request.method === "tools/list" && rpc?.result !== undefined) {
        const ceiling = ceilingOf(deps.bundle?.());
        const count = toolCountOf(rpc.result);
        if (
          ceiling !== undefined &&
          count !== undefined &&
          count > ceiling.maxTools
        ) {
          log(
            `mcp gateway refused tools/list: ${count} tools exceeds ${ceiling.maxTools} for ${ceiling.modelId}`,
          );
          recordCall(
            request,
            context,
            "rejected",
            now() - startedAt,
            "tool ceiling",
          );
          return {
            status: 200,
            body: rpcError(
              id,
              RPC_REFUSED,
              tooManyToolsMessage(ceiling, count),
              {
                modelId: ceiling.modelId,
                maxTools: ceiling.maxTools,
                toolCount: count,
              },
            ),
          };
        }
      }

      recordCall(
        request,
        context,
        rpc?.error === undefined ? "ok" : "rejected",
        now() - startedAt,
        rpc?.error?.message,
      );
      return response;
    },
  };

  function recordCall(
    request: JsonRpcRequest,
    context: { sessionId: string },
    status: GatewayCallRecord["status"],
    durationMs: number,
    refusedReason?: string,
  ): void {
    if (deps.record === undefined) return;
    // Only calls are evidence. `initialize`, `tools/list` and the ping
    // methods are protocol traffic, not actions, and filing them as tool
    // calls would inflate the record with steps nobody took. A refused
    // `tools/list` is the exception: a refusal is a decision.
    const isCall = request.method === "tools/call";
    if (!isCall && status !== "rejected") return;
    deps.record({
      sessionId: context.sessionId,
      client: clients.get(context.sessionId) ?? "unknown",
      toolName: isCall ? toolNameOf(request.params) : request.method,
      status,
      durationMs,
      ...(refusedReason === undefined ? {} : { refusedReason }),
    });
  }
}

function clientNameOf(
  params: Record<string, unknown> | undefined,
): string | undefined {
  const info = params?.["clientInfo"];
  if (info === null || typeof info !== "object") return undefined;
  const name = (info as { name?: unknown }).name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

function toolNameOf(params: Record<string, unknown> | undefined): string {
  const name = params?.["name"];
  return typeof name === "string" && name.length > 0 ? name : "unknown";
}
