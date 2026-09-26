/**
 * The local MCP gateway (ADR-078, connected tier).
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
 * spreads `{"claudecode/toolUseId": <id>}` into the request's `_meta`.
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
  /** Set when the control plane refused the call. */
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

/**
 * What a forwarded answer was, in the three words the record uses.
 *
 * `rejected` means **Oxagen refused this call**, because the daemon seals a
 * rejection as a `policy_decision` with `policy_decision: "deny"` and
 * `policy_source: "kernel"` and the desktop counts it as refused. So only the
 * refusal code earns it: `-32002` is the code the control plane answers a
 * governance denial with, and the one this gateway uses for its own.
 *
 * Every other JSON-RPC error is the tool failing, not the mandate speaking —
 * an unknown tool name, arguments that do not validate, a handler that threw.
 * Filing those as refusals invents governance decisions nobody made and
 * inflates the refused count on the machine's own screen with them.
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
  return "ok";
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
 * The gateway does not evaluate the mandate — `@oxagen/tacho` takes no
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

      recordCall(
        request,
        context,
        outcomeOf(response.status, rpc),
        now() - startedAt,
        rpc?.error?.message,
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
 * A tool argument or result carrying a value RFC 8785 cannot canonicalise (a
 * non-finite number is the one that occurs) would otherwise throw out of
 * `recordCall` and take the forward's answer with it. The gateway stands in
 * the caller's path, so the call is served and the frame says less, rather
 * than the call failing over its own evidence.
 */
function canonical(
  value: unknown,
  log: (line: string) => void,
  half: string,
): { value: JsonValue; text: string } | undefined {
  if (value === undefined) return undefined;
  try {
    return { value: value as JsonValue, text: jcs(value as JsonValue) };
  } catch (error) {
    log(
      `mcp gateway recorded a call without its ${half}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
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
