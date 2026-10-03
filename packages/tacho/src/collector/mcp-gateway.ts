/**
 * The local MCP gateway (ADR-078, connected tier).
 *
 * Any MCP client on this machine connects to `http://127.0.0.1:<port>/mcp`
 * and gets the workspace's toolbelt, without ever holding an Oxagen
 * credential. The gateway holds it. A non-developer will not paste a token
 * into a JSON file, and asking them to would put the credential on the least
 * protected surface on the machine; the app *is* the credential.
 *
 * It is a **proxy, not a second materialiser.** `@oxagen/recorder` is a leaf
 * package with no `@oxagen/*` runtime dependency, so nothing here imports
 * `materializeTools`, `mcp-rbac` or `tool-budget` — and that constraint
 * pushes toward the right shape anyway. The JSON-RPC envelope is forwarded to
 * the workspace MCP endpoint over HTTPS, so there is exactly one tool
 * materialiser, one RBAC evaluation, one entitlement gate and one meter, and
 * they are the ones that already exist on the control plane.
 *
 * It forwards with a credential minted for exactly this job — **never the
 * host key** (ADR-078 §4). The host key reports events and fetches the
 * mandate; its principal is an API key, which has no `org_users` row, so
 * `assertCallerRole` returns early for it and `checkIAM` takes the tier
 * fast-path. A connected app forwarding under it would hold owner authority
 * over the workspace. Enrollment therefore mints a second key with purpose
 * `tacho_gateway_v1`, whose mandate is a rule rather than a list — an `mcp`
 * capability that does not mutate and is not high-sensitivity — and
 * `machineKeyDenial` enforces that purpose in the kernel's IAM adapter,
 * ahead of the fast-path. A host with no gateway key serves no tools and
 * never falls back to the host key.
 *
 * ADR-043 holds with no exception: this serves tools and records evidence. It
 * never runs a turn, never calls a model and never spawns a worker.
 *
 * What the gateway adds on top of the forward:
 *
 *   1. **Attribution.** A call that cannot be attributed to an org and a
 *      workspace is refused, never defaulted. Attribution rides the gateway
 *      key, so a daemon with no loadable enrollment — or one enrolled before
 *      the gateway key existed — has nothing to present and says so rather
 *      than guessing.
 *   2. **A tool ceiling.** When the mandate's bundle names one, a `tools/list`
 *      that would materialise past it fails with a message naming the model,
 *      the limit and the count — the shape `TooManyToolsForProviderError` uses
 *      on the control plane — rather than a gateway error about a number
 *      nobody can inspect.
 *   3. **Evidence.** Every proxied call is sealed with
 *      `enforcement_tier: "gateway"`, so the record says what it is: a call
 *      Oxagen served and could refuse, not a step it merely observed. It
 *      lands on the daemon's chain, or on the session chain of the hooked
 *      agent that asked for it when the client names the call's
 *      `tool_use_id` (ADR-189).
 *
 * The browser guard lives in `loopback-guard.ts` and runs for every request on
 * the TCP listener, not only these.
 */
import {
  digestBytes,
  jcs,
  jsonByteLength,
  type JsonValue,
  type Sha256Digest,
} from "../digest";
import { type DraftContent, jsonContent } from "../evidence/frame-body";
import { TACHO_VERSION } from "../version";
import {
  MCP_STREAMABLE_HTTP_ACCEPT,
  TACHO_GATEWAY_GENESIS_HEADER,
  TACHO_GATEWAY_SESSION_HEADER,
  type PolicyBundle,
} from "../wire";

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
  /**
   * The `tacho_gateway_v1` key, never the host key (ADR-078 §4). The daemon
   * reads it from `host.gateway_api_key` and returns no attribution at all
   * when it is absent, so there is no path by which the host key reaches
   * this field.
   */
  apiKey: string;
  hostEnrollmentId: string;
  /**
   * The daemon's own chain — the `tachod-*` session every gateway call is
   * sealed onto — named on the forwarded request so the control plane can
   * file its record of the call against it (#3221).
   *
   * Undefined when the daemon has no chain yet, and then the call is
   * forwarded without the header. That is the honest answer: the control
   * plane records an invocation it cannot attribute to a chain rather than
   * one attributed to a guess, and the tier stays on the host's own mode.
   */
  chainSessionUuid?: string;
  /**
   * The hash of the daemon chain's first sealed event — the one thing about
   * the chain a forger holding only the host's ingest key cannot produce,
   * because a different chain has a different genesis hash and matching one
   * would be a preimage attack.
   *
   * Undefined until the chain has a genesis, and then the call is forwarded
   * without the header and the session stays on the host's own mode. That is
   * the startup window only, and the honest answer for it.
   */
  chainGenesisHash?: string;
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

/**
 * The `_meta` key Claude Code puts a tool call's `tool_use_id` under in every
 * MCP `tools/call` request it sends. Read from the 2.1.283 binary, which
 * spreads `{"claudecode/toolUseId": <id>}` into the request's `_meta`. A
 * request 2.1.287 sent over stdio carries it too:
 * `fixtures/claude-code/mcp/tools-call-2.1.287.json` (#4355).
 */
export const CLAUDE_CODE_TOOL_USE_ID_META = "claudecode/toolUseId";

/** The longest `tool_use_id` the envelope accepts. */
const MAX_TOOL_USE_ID_LENGTH = 512;

/** One proxied call, as the daemon needs it to seal an event. */
export interface GatewayCallRecord {
  /** The MCP session the call arrived on, sealed as `oxagen.mcp_session`. */
  sessionId: string;
  /** The connected app, from the `initialize` handshake. */
  client: string;
  toolName: string;
  /**
   * The harness's own id for this call, when the client sent one in the
   * request's `_meta` (Claude Code does). The daemon seals the call on the
   * session that requested it, as that call's one `tool_call` (ADR-189).
   */
  toolUseId?: string;
  status: "ok" | "error" | "rejected";
  durationMs: number;
  /**
   * What the control plane said when it refused the call or the call failed:
   * a JSON-RPC error's message, or a failed tool result's text. Only a
   * refusal seals it, as a digest.
   */
  refusedReason?: string;
  /**
   * The rules that refused it, from a -32002 refusal's `error.data.ruleIds`,
   * at most 64 of at most 512 characters each (#3971). The daemon seals them
   * as `policy_rules` on the `policy_decision` frame.
   */
  ruleIds?: string[];
  /** JCS digest of the call's arguments, for `tool_input_digest`. */
  inputDigest?: Sha256Digest;
  inputBytes?: number;
  /** JCS digest of what came back, for `tool_output_digest`. */
  outputDigest?: Sha256Digest;
  outputBytes?: number;
  /**
   * The arguments and the result in one frame body, so a gateway-observed
   * call replays rather than only counting. Absent when the call carried
   * neither, or when neither could be canonicalised.
   */
  content?: DraftContent;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** The protocol revision the gateway speaks; forwarded verbatim otherwise. */
export const GATEWAY_SERVER_INFO = {
  name: "oxagen",
  version: TACHO_VERSION,
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

/**
 * The tool ceiling a bundle declares, or undefined when it declares none.
 *
 * Reads `bundle.tool_ceiling` as the type, with no cast. It used to reach the
 * field through `as { tool_ceiling?: unknown }`, which compiled only because
 * `policyBundleSchema` did not have the field — and because the schema is
 * `.strict()`, a real signed bundle carrying one was rejected outright, so
 * every bundle that ever reached here declared no ceiling and the refusal
 * below could not fire. The cast is what hid that; the schema now names the
 * field, so the type answers the question instead.
 *
 * **Why the control plane does not populate this yet, and should not be
 * "fixed" by wiring the workspace's model in.** The cap this refusal is about
 * belongs to the provider the *connected app* sends its turn to — Claude
 * Desktop's, Cursor's — and MCP tells a server nothing about that: the
 * `initialize` handshake carries a client name and version, not a model. The
 * workspace's own agent model is a different number for a different path; it
 * governs turns Oxagen composes, not turns a connected app composes.
 *
 * Emitting the workspace model here would enforce one provider's cap on
 * another provider's request, which is worse than enforcing none — it would
 * refuse a list the client would have accepted, naming a model the operator
 * never chose. So the wire carries the field, the host enforces it the moment
 * a bundle declares one, and a bundle declares one when there is a defensible
 * source for the number.
 */
export function ceilingOf(
  bundle: PolicyBundle | undefined,
): ToolCeiling | undefined {
  const declared = bundle?.tool_ceiling;
  if (declared === undefined) return undefined;
  return {
    modelId: declared.model_id,
    maxTools: declared.max_tools,
    source: declared.source,
  };
}

/**
 * The JSON-RPC message in an upstream body, or undefined when the body is
 * empty.
 *
 * A streamable-HTTP server answers a POST with `application/json` or with an
 * event stream (SSE, `text/event-stream`). The hosted server streams: xmcp
 * leaves the MCP SDK transport's `enableJsonResponse` unset, so each message
 * arrives as an `event: message` with a `data:` line, and the stream closes
 * after the response.
 *
 * A body that looks like a stream is read event by event, as the SSE standard
 * reads it. An event's `data:` lines join with newlines. An event with no
 * data, such as the SDK's priming event or a keep-alive comment, carries no
 * message. The last message is the response, because the server sends any
 * notification about a request before the response and closes the stream
 * after it.
 *
 * Throws when the body, or the last event's data, is not JSON. The caller
 * decides what the client is told.
 */
export function readRpcBody(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  if (!/^(event|id|retry|data):/m.test(trimmed)) {
    return JSON.parse(trimmed) as unknown;
  }
  let last: string | undefined;
  for (const event of trimmed.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(line.startsWith("data: ") ? 6 : 5));
    const payload = data.join("\n");
    if (payload.trim().length > 0) last = payload;
  }
  if (last === undefined) return undefined;
  return JSON.parse(last) as unknown;
}

/** What the gateway read back from the hosted server for one forward. */
export interface UpstreamAnswer {
  status: number;
  /** The JSON-RPC message, or undefined when the body was empty or not JSON. */
  body: unknown;
  /** The raw body, quoted to the client when it is not a JSON-RPC answer. */
  text: string;
}

/** The longest stretch of a raw upstream body an error message quotes. */
const UPSTREAM_EXCERPT_MAX = 200;

function isRpcErrorObject(value: unknown): value is JsonRpcError {
  if (value === null || typeof value !== "object") return false;
  const error = value as Record<string, unknown>;
  return (
    typeof error["code"] === "number" && typeof error["message"] === "string"
  );
}

/**
 * The answer a client can match to its request, whatever the hosted server
 * sent back.
 *
 * A client waits for a reply that carries its own request id. Nothing else
 * ends that wait except the client's own timeout. So a request with an id
 * always gets an answer with that id (#5356):
 *
 *   - A JSON-RPC error keeps its code, message and data, and takes the
 *     request's id. The MCP SDK transport refuses a bad POST before it reads
 *     the body, so its refusal carries `id: null`. The 406 for a missing
 *     `text/event-stream` was one. Passed through as it was, that refusal
 *     matched no request, and the client waited 30 seconds for an answer.
 *   - A non-2xx status with no JSON-RPC error becomes an internal error that
 *     names the status and quotes the start of the body. So does a body that
 *     is not a JSON-RPC answer to this request: empty, not JSON, an object
 *     with neither `result` nor `error`, or a `result` for another id.
 *   - A 2xx `result` with the request's id passes through unchanged.
 *
 * The HTTP status stays the hosted server's when it was not 2xx. It becomes
 * 502 when a 2xx carried no answer. A notification has no id and wants no
 * answer, so the gateway never passes one here.
 */
export function answerFor(
  id: string | number,
  upstream: UpstreamAnswer,
): GatewayHttpResponse {
  const { status, body } = upstream;
  const ok = status >= 200 && status < 300;
  const message =
    body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  const error = message?.["error"];
  if (isRpcErrorObject(error)) {
    if (message?.["id"] === id) return { status, body };
    return {
      status,
      body: { jsonrpc: "2.0", id, error } satisfies JsonRpcResponse,
    };
  }
  if (ok && message !== undefined && "result" in message) {
    if (message["id"] === id) return { status, body };
  }
  const flat = upstream.text.replace(/\s+/g, " ").trim();
  const what =
    flat.length === 0
      ? "with no body"
      : `with a body that is not a JSON-RPC answer to this request: ${flat.slice(0, UPSTREAM_EXCERPT_MAX)}`;
  return {
    status: ok ? 502 : status,
    body: rpcError(
      id,
      RPC_INTERNAL_ERROR,
      `the Oxagen control plane answered HTTP ${status} ${what}`,
    ),
  };
}

/**
 * The start of each message the kernel throws when an IAM decision refuses a
 * call, in `packages/oxagen/src/kernel.ts`: the deny (`IAM denied "<name>" for
 * principal: ...`, which is also how a gateway key's `machineKeyDenial`
 * arrives) and `pending_approval` (`IAM requires approval for "<name>" ...`).
 * The kernel records both as a deny, because the call did not run. Its other
 * `authz_denied` messages are not decisions about the call, such as an IAM
 * check that errored and failed closed, so they stay `error`.
 */
const KERNEL_REFUSAL_PREFIXES = [
  'IAM denied "',
  'IAM requires approval for "',
] as const;

/**
 * The text of a `tools/call` result that reports a failure (`isError: true`),
 * its text blocks joined by newlines, or undefined when the result is not
 * one.
 *
 * MCP puts a tool's failure here, not in a JSON-RPC error. The hosted server's
 * tools throw, and the MCP SDK's `createToolError` answers HTTP 200 with
 * `{ content: [{ type: "text", text: <the error's message> }], isError: true }`.
 */
export function toolErrorTextOf(result: unknown): string | undefined {
  if (result === null || typeof result !== "object") return undefined;
  const { isError, content } = result as {
    isError?: unknown;
    content?: unknown;
  };
  if (isError !== true) return undefined;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block: unknown) => {
      if (block === null || typeof block !== "object") return [];
      const { type, text } = block as { type?: unknown; text?: unknown };
      return type === "text" && typeof text === "string" ? [text] : [];
    })
    .join("\n");
}

/**
 * What a forwarded answer was, in the three words the record uses.
 *
 * `rejected` means **Oxagen refused this call**, because the daemon seals a
 * rejection as a `policy_decision` with `policy_decision: "deny"` and
 * `policy_source: "kernel"` and the desktop counts it as refused. Two answers
 * earn it. One is a JSON-RPC error with `-32002`, the code this gateway uses
 * for its own refusals. The other is a failed tool result whose text is the
 * kernel's IAM refusal. The hosted server sends no `-32002` and marks no
 * refusal: the kernel's message is the only sign of one, so it is read by
 * its first words. A refusal whose wording drifts is recorded as `error`,
 * never as `ok`. A marker the server sets on a refusal would replace this.
 *
 * Every other failure is the tool failing, not the mandate speaking — an
 * unknown tool name, arguments that do not validate, a handler that threw.
 * Filing those as refusals invents governance decisions nobody made and
 * inflates the refused count on the machine's own screen with them. So a
 * JSON-RPC error with any other code is an `error`, and so is a result that
 * reports `isError: true` for any other reason. Reading that result as
 * success recorded every failed call as a call that worked.
 *
 * A non-2xx HTTP status with no JSON-RPC error in the body is an `error` too,
 * and explicitly so: reading "no `error` member" as success recorded a control
 * plane 502 as a tool call that worked.
 */
export function outcomeOf(
  status: number,
  rpc: JsonRpcResponse | undefined,
): GatewayCallRecord["status"] {
  if (rpc?.error !== undefined)
    return rpc.error.code === RPC_REFUSED ? "rejected" : "error";
  if (status < 200 || status >= 300) return "error";
  const failure = toolErrorTextOf(rpc?.result);
  if (failure === undefined) return "ok";
  return KERNEL_REFUSAL_PREFIXES.some((prefix) => failure.startsWith(prefix))
    ? "rejected"
    : "error";
}

/** The most rules one refusal names, and the longest each may be: the envelope's bounds. */
const REFUSAL_RULES_MAX = 64;
const REFUSAL_RULE_MAX = 512;

/**
 * The rules a control-plane refusal names, in evaluation order (#3971,
 * ADR-201): a `-32002` answer's `error.data.ruleIds`, strings only, at most
 * 64 of at most 512 characters each. Undefined for any other answer, and for
 * a refusal that names none, such as the gateway's own tool ceiling.
 */
export function refusalRulesOf(
  rpc: JsonRpcResponse | undefined,
): string[] | undefined {
  const error = rpc?.error;
  if (error === undefined || error.code !== RPC_REFUSED) return undefined;
  const data = error.data;
  if (typeof data !== "object" || data === null) return undefined;
  const listed = (data as { ruleIds?: unknown }).ruleIds;
  if (!Array.isArray(listed)) return undefined;
  const rules = listed
    .filter((rule): rule is string => typeof rule === "string" && rule !== "")
    .slice(0, REFUSAL_RULES_MAX)
    .map((rule) => rule.slice(0, REFUSAL_RULE_MAX));
  return rules.length > 0 ? rules : undefined;
}

/** How many tools a `tools/list` result carries, or undefined if not one. */
export function toolCountOf(result: unknown): number | undefined {
  if (result === null || typeof result !== "object") return undefined;
  const tools = (result as { tools?: unknown }).tools;
  return Array.isArray(tools) ? tools.length : undefined;
}

/**
 * The tools the mandate permits, or undefined when the bundle names none.
 *
 * Undefined is *not told*, not *none permitted*: a bundle signed by a control
 * plane older than `gateway_tools` declares nothing, and filtering everything
 * away on that basis would take a working machine's toolbelt to zero on a
 * field it has never seen. A bundle that declares an empty list is a mandate
 * that permits nothing, and that is served as nothing.
 */
export function gatewayToolsOf(
  bundle: PolicyBundle | undefined,
): ReadonlySet<string> | undefined {
  const declared = bundle?.gateway_tools;
  return declared === undefined ? undefined : new Set(declared);
}

/**
 * A `tools/list` result with everything outside the mandate removed, or the
 * result untouched when there is nothing to filter by.
 *
 * The gateway does not evaluate the mandate — `@oxagen/recorder` takes no
 * `@oxagen/*` runtime dependency, so it cannot read a capability's surfaces,
 * mutation or sensitivity, and a second copy of that rule living here is
 * exactly the drift ADR-078 §4 keeps out. It applies the answer the signed
 * bundle carries.
 *
 * This runs before the ceiling is counted. A toolbelt is measured as it will
 * be served, so a list that fits once the forbidden tools are gone is served
 * rather than refused for a size it never had.
 */
export function filterToolsByMandate(
  result: unknown,
  allowed: ReadonlySet<string> | undefined,
): unknown {
  if (allowed === undefined) return result;
  if (result === null || typeof result !== "object") return result;
  const tools = (result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return result;
  const kept = tools.filter((tool) => {
    const name = (tool as { name?: unknown } | null)?.name;
    return typeof name === "string" && allowed.has(name);
  });
  if (kept.length === tools.length) return result;
  return { ...(result as Record<string, unknown>), tools: kept };
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
  ): Promise<UpstreamAnswer> {
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
          // Both media types, as the MCP transport requires. The hosted
          // server refuses any other Accept with a 406 (#5356). It answers
          // with an event stream, and `readRpcBody` reads the response out of
          // it, so the client still gets one JSON answer.
          Accept: MCP_STREAMABLE_HTTP_ACCEPT,
          "User-Agent": "oxagen-local-gateway",
          "X-Tacho-Host": attribution.hostEnrollmentId,
          // Which chain this call belongs to. The control plane takes the
          // org, the workspace and the HOST from the gateway key's own scope
          // and never from a header; this names the one thing the key cannot,
          // and it is trusted only because the key it arrives with is.
          ...(attribution.chainSessionUuid === undefined
            ? {}
            : {
                [TACHO_GATEWAY_SESSION_HEADER]: attribution.chainSessionUuid,
              }),
          // The chain's genesis hash, which is what makes the name above
          // evidence rather than a claim.
          ...(attribution.chainGenesisHash === undefined
            ? {}
            : {
                [TACHO_GATEWAY_GENESIS_HEADER]: attribution.chainGenesisHash,
              }),
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      const text = await response.text();
      let body: unknown;
      try {
        body = readRpcBody(text);
      } catch {
        // Not JSON, and not a stream that carries JSON: a load balancer's
        // HTML page or a proxy's plain-text error. The server was reached,
        // so this is no transport failure. `answerFor` tells the client
        // what came back.
        body = undefined;
      }
      return { status: response.status, body, text };
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
        log(
          "mcp gateway refused a call: no enrollment, or no gateway credential on it",
        );
        return {
          status: 403,
          body: rpcError(
            id,
            RPC_REFUSED,
            "this machine has no Oxagen mandate to serve tools under. Open the Oxagen app: if it is signed in and connected, reconnect this app to refresh its credential, then restart it.",
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
      let upstream: UpstreamAnswer;
      try {
        upstream = await forward(request, attribution);
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

      // A request gets an answer with its own id, whatever came back. A
      // notification's acknowledgement (202, no body) passes through as it is.
      let response: GatewayHttpResponse =
        typeof request.id === "string" || typeof request.id === "number"
          ? answerFor(request.id, upstream)
          : { status: upstream.status, body: upstream.body };
      if (response.body !== upstream.body) {
        const said = (response.body as JsonRpcResponse).error?.message;
        log(
          `mcp gateway gave ${request.method} an error with the request's id after HTTP ${upstream.status}: ${said ?? "no message"}`,
        );
      } else if (upstream.status < 200 || upstream.status >= 300) {
        // A notification gets no answer, so the log is the only place its
        // failure shows.
        log(
          `mcp gateway: the control plane answered ${request.method} with HTTP ${upstream.status}`,
        );
      }

      const rpc = response.body as JsonRpcResponse | undefined;

      // A `tools/list` is cut down to the mandate before anything else looks
      // at it. The control plane advertises the whole workspace toolbelt to
      // any credential that can reach it, and the gateway key's mandate is
      // narrower than that — read-only, non-sensitive `mcp` capabilities — so
      // an unfiltered list shows a connected app tools that can only fail when
      // selected, and counts tools the mandate forbids against the ceiling.
      if (request.method === "tools/list" && rpc?.result !== undefined) {
        const bundle = deps.bundle?.();
        const allowed = gatewayToolsOf(bundle);
        const served = filterToolsByMandate(rpc.result, allowed);
        if (served !== rpc.result) {
          const before = toolCountOf(rpc.result);
          const after = toolCountOf(served);
          log(
            `mcp gateway filtered tools/list to the mandate: ${after ?? 0} of ${before ?? 0} tools`,
          );
          response = {
            status: response.status,
            body: { ...rpc, result: served } satisfies JsonRpcResponse,
          };
        }
        // A `tools/list` that overflows the mandate's ceiling is refused here,
        // with the provider's own numbers, rather than served and refused
        // later by a provider the user cannot see.
        const ceiling = ceilingOf(bundle);
        const count = toolCountOf(served);
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

      // A failed tool result carries its reason as text, where a JSON-RPC
      // error carries it as a message. A refusal seals only its digest.
      const failure = toolErrorTextOf(rpc?.result);
      recordCall(
        request,
        context,
        outcomeOf(response.status, rpc),
        now() - startedAt,
        rpc?.error?.message ??
          (failure === undefined || failure === "" ? undefined : failure),
        rpc,
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
    rpc?: JsonRpcResponse,
  ): void {
    if (deps.record === undefined) return;
    // Only calls are evidence. `initialize`, `tools/list` and the ping
    // methods are protocol traffic, not actions, and filing them as tool
    // calls would inflate the record with steps nobody took. A refused
    // `tools/list` is the exception: a refusal is a decision.
    const isCall = request.method === "tools/call";
    if (!isCall && status !== "rejected") return;
    const ruleIds = status === "rejected" ? refusalRulesOf(rpc) : undefined;
    const toolUseId = isCall ? toolUseIdOf(request.params) : undefined;
    deps.record({
      sessionId: context.sessionId,
      client: clients.get(context.sessionId) ?? "unknown",
      toolName: isCall ? toolNameOf(request.params) : request.method,
      ...(toolUseId === undefined ? {} : { toolUseId }),
      status,
      durationMs,
      ...(refusedReason === undefined ? {} : { refusedReason }),
      ...(ruleIds === undefined ? {} : { ruleIds }),
      ...exchangeOf(request, rpc, log),
    });
  }
}

/**
 * What the call asked for and what came back, as the frame records it: the two
 * digests `tool_input_digest` and `tool_output_digest` name, and one body
 * carrying both halves.
 *
 * Both halves ride one body because a frame carries at most one. The gateway
 * seals exactly one event per call, and a `tool_call` frame from a hook
 * already holds its input and output together for the same reason
 * (`toolCallContent` in `claude-code/hooks.ts`), so a reader has one shape to
 * learn rather than two.
 *
 * A refused or failed call still records what it has. The arguments are known
 * before the forward and are the whole evidence of what was attempted, so a
 * call the control plane turned down is not a blank row.
 */
function exchangeOf(
  request: JsonRpcRequest,
  rpc: JsonRpcResponse | undefined,
  log: (line: string) => void,
): Pick<
  GatewayCallRecord,
  "inputDigest" | "inputBytes" | "outputDigest" | "outputBytes" | "content"
> {
  const input = canonical(request.params?.["arguments"], log, "arguments");
  // A JSON-RPC answer is a result or an error, never both. An error is as much
  // of an outcome as a result is, and a replay that dropped it would show a
  // call that was made and never answered.
  const output = canonical(rpc?.error ?? rpc?.result, log, "result");
  if (input === undefined && output === undefined) return {};
  return {
    ...(input === undefined
      ? {}
      : {
          inputDigest: digestBytes(input.text),
          inputBytes: jsonByteLength(input.value),
        }),
    ...(output === undefined
      ? {}
      : {
          outputDigest: digestBytes(output.text),
          outputBytes: jsonByteLength(output.value),
        }),
    // The members and the digests are spelled the way a hook spells them, so
    // one reader handles a `tool_call` frame whichever seam produced it.
    content: jsonContent(jcs({ input: input?.value, output: output?.value })),
  };
}

/**
 * One half of a call as its JCS text and the value behind it, or nothing when
 * there is no half and nothing when it has no JCS form.
 *
 * A tool argument or result carrying a value RFC 8785 cannot canonicalise
 * would otherwise throw out of `recordCall` and take the forward's answer
 * with it. The gateway stands in the caller's path, so the call is served and
 * the frame says less, rather than the call failing over its own evidence.
 *
 * A non-finite number is the one that occurs: `JSON.parse` reads `1e400` as
 * `Infinity`. RFC 8785 has no form for it, but `jcs` does not throw on it. It
 * writes `null`, so the digest would name a value the client never sent, and
 * two different calls would share it. So this checks for one first and drops
 * the half, as it does for a value `jcs` throws on.
 */
function canonical(
  value: unknown,
  log: (line: string) => void,
  half: string,
): { value: JsonValue; text: string } | undefined {
  if (value === undefined) return undefined;
  if (holdsNonFiniteNumber(value)) {
    log(
      `mcp gateway recorded a call without its ${half}: it holds a number JSON has no form for`,
    );
    return undefined;
  }
  try {
    return { value: value as JsonValue, text: jcs(value as JsonValue) };
  } catch (error) {
    log(
      `mcp gateway recorded a call without its ${half}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

/** Whether a parsed value holds, at any depth, `Infinity`, `-Infinity` or `NaN`. */
function holdsNonFiniteNumber(value: unknown): boolean {
  if (typeof value === "number") return !Number.isFinite(value);
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(holdsNonFiniteNumber);
  return Object.values(value as Record<string, unknown>).some(
    holdsNonFiniteNumber,
  );
}

function clientNameOf(
  params: Record<string, unknown> | undefined,
): string | undefined {
  const info = params?.["clientInfo"];
  if (info === null || typeof info !== "object") return undefined;
  const name = (info as { name?: unknown }).name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

/**
 * The `tool_use_id` a `tools/call` carries in `_meta`, or undefined when it
 * carries none the envelope would accept.
 */
export function toolUseIdOf(
  params: Record<string, unknown> | undefined,
): string | undefined {
  const meta = params?.["_meta"];
  if (meta === null || typeof meta !== "object") return undefined;
  const id = (meta as Record<string, unknown>)[CLAUDE_CODE_TOOL_USE_ID_META];
  return typeof id === "string" &&
    id.length > 0 &&
    id.length <= MAX_TOOL_USE_ID_LENGTH
    ? id
    : undefined;
}

function toolNameOf(params: Record<string, unknown> | undefined): string {
  const name = params?.["name"];
  return typeof name === "string" && name.length > 0 ? name : "unknown";
}
