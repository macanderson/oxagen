/**
 * The loopback model proxy (story sheet item 10): `tachod` grows into the
 * gateway by standing between a wrapped harness and its model vendor.
 *
 * It is a passthrough. The method, path, query, headers and body a harness
 * sends are what the vendor receives, and the vendor's answer streams back as
 * it arrives. The caller's credential crosses untouched, in memory only, and
 * this module never logs a header value.
 *
 * It does record the exchange, and until Phase 5 it did not. The proxy used
 * to seal digests, counts and timings and nothing else, which left a run it
 * observed at replay grade `inspect`: a reader could see that a model was
 * called and what it cost, but never what was asked or answered (Mission
 * Control spec 8.4). So the request the vendor read and the response it sent
 * now ride the `llm_call` frame as its body. Three rules govern those bytes,
 * and none of them is this module's to make:
 *
 *   - Redaction runs on the host before the digest (`evidence/frame-body.ts`),
 *     so a secret is cut out of the body and the digest the chain carries
 *     names the bytes that ship, never the bytes the vendor saw.
 *   - A body over `TACHO_MAX_BODY_BYTES` is never held. The proxy stops
 *     accumulating at the cap rather than buying the agent's memory with
 *     bytes no host could ship, and the frame says why it has none.
 *   - The workspace's retention mode decides whether a body reaches the WAL
 *     at all. The daemon applies it on the way in and the control plane
 *     enforces it again on ingest, so a workspace on `digest_only` gets
 *     exactly what this proxy produced before: digests, counts and timings.
 *
 * Standing in the path is what makes five things possible, and each is here:
 *
 *   1. **Observed metering.** Every model call seals one `llm_call` frame with
 *      the vendor's own usage, a digest of the request and of the response,
 *      the latency and the status, marked `oxagen.metering: observed`.
 *   2. **An enforced budget.** `budget.session_limit_usd` is compared with
 *      the session's observed spend, and `budget.daily_limit_usd` with the
 *      agent's observed spend for the UTC day (ADR-160, `day-spend.ts`),
 *      before a call is forwarded.
 *   3. **A real interrupt.** A paused or cancelled session has its in-flight
 *      calls aborted and its new ones refused until it is resumed.
 *   4. **A model allowlist.** `models.allow` and `models.deny` are checked
 *      against the model the request asks for, before it is forwarded.
 *   5. **The injection seam.** `beforeForward` sees each request before it
 *      leaves and may return a changed one. It is a no-op until the Phase 1
 *      assembler exists.
 *   6. **The cache keep-alive** (lane F32, `cache-keep-alive.ts`). While a
 *      parent waits on a subagent, the proxy resends the parent's last
 *      Anthropic request with `max_tokens: 0` so its cached prompt does not
 *      expire, when the bundle turns the keep-alive on for the agent. Each
 *      one seals an observed `llm_call` frame of its own.
 *
 * The keep-alive is the one place the proxy keeps a request past its call:
 * the last request of each waiting parent, with the headers it went out
 * with, the caller's credential among them, in memory only, for at most one
 * TTL past the parent's last request. It is never written or logged.
 *
 * ## What fails open and what fails closed
 *
 * The proxy is in the agent's critical path, so the rule is: a fault of
 * Oxagen's never stops a call, and a decision of the operator's always does.
 *
 * Open: a model with no price (the call is forwarded and costs the budget
 * nothing), an unreachable control plane (the cached bundle keeps deciding), a
 * response the meter cannot read (forwarded, recorded without usage), a call
 * no session can be found for (still subject to model policy), and
 * a `beforeForward` that throws or stalls (the original request is sent).
 *
 * Closed: a session or an agent's day at its limit under an `enforced` budget, a model the
 * workspace's `models` policy refuses independently, a paused or
 * cancelled session, and a suspended or revoked host. Those are refused with
 * an error in the vendor's own shape and recorded as a `policy_decision`.
 *
 * Three calls are answered by the proxy itself and never forwarded: a request
 * over the bytes it holds for one call (413), a request the harness left
 * before it finished sending, and a call the proxy failed on before it opened
 * the connection to the vendor (502). Each is recorded as an `error` frame
 * marked `oxagen.not_forwarded` (ADR-256).
 *
 * An armed model policy refuses metered requests whose model cannot be read.
 * Non-metered endpoints retain passthrough behavior. Model checks also apply
 * when the request cannot be correlated to a session.
 *
 * The budget is checked when a call is admitted, so calls already in flight
 * finish and a session can end one turn past its limit. It is never checked
 * mid-stream: cutting a response in half to save its last tokens would cost
 * the operator the whole call. A call in flight holds its ceiling against the
 * budget until it settles, so calls admitted side by side see each other
 * rather than all reading the same settled spend.
 *
 * ## Which session a call belongs to
 *
 * Five sources are tried in order. First the `x-oxagen-session` header. Then
 * the harness's own session header (`X-Claude-Code-Session-Id`, or Codex's
 * `session_id` and `conversation_id`). Then the session id inside an
 * Anthropic `metadata.user_id`, or the `prompt_cache_key` Codex sets to its
 * conversation id on a Responses call, taken only when it names a session
 * this host already knows. Last, the one live session of that harness on
 * this host, when there is exactly one. A call that
 * matches none is sealed on the daemon's own chain and says so, because a call
 * filed under the wrong session is worse than one filed under none.
 */
import { createHash } from "node:crypto";
import {
  type ClientRequest,
  type IncomingMessage,
  request as httpRequest,
  type ServerResponse,
  Agent as HttpAgent,
} from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import {
  gunzipSync,
  brotliDecompressSync,
  zstdDecompressSync,
  inflateSync,
} from "node:zlib";
import { digestText } from "../claude-code/context";
import type { SessionRecorder } from "../claude-code/recorder";
import {
  type RequestContext,
  SHARED_SYSTEM_CONTEXT_MEMORY,
} from "../claude-code/system-context";
import {
  CONTEXT_WINDOW_ATTR,
  encodeWindowAttr,
  measureProviderRequest,
} from "../context-window";
import { digestBytes, jcs } from "../digest";
import { toProtocolTimestamp } from "../timestamp";
import type { TachoEvent } from "../envelope";
import {
  type DraftContent,
  type FrameBody,
  jsonContent,
} from "../evidence/frame-body";
import {
  REQUEST_BODY_OMITTED_ATTR,
  RESPONSE_BODY_OMITTED_ATTR,
} from "../evidence/replay-grade";
import { cacheKeepAliveFinding } from "../host/bundle";
import type { HeldCredential } from "../host/credential-store";
import {
  looksLikeRunToken,
  peekRunTokenClaims,
  type RunTokenClaims,
  type RunTokenProvider,
  type RunTokenRefusal,
  type RunTokenVerdict,
} from "../host/run-token";
import {
  type PolicyBundle,
  TACHO_CREDENTIAL_BASIS_ATTR,
  TACHO_CREDENTIAL_GATEWAY_BROKERED,
  TACHO_CREDENTIAL_HARNESS_HELD,
  TACHO_ENFORCEMENT_TIER_ATTR,
  TACHO_GATEWAY_TIER,
  TACHO_METERING_ATTR,
  TACHO_MAX_BODY_BYTES,
  TACHO_METERING_OBSERVED,
  TACHO_MODEL_SESSION_HEADER,
  TACHO_RUN_TOKEN_ATTR,
  type TachoCredentialBasis,
  type TachoHarness,
  defaultHarnessForProvider,
} from "../wire";
import {
  CacheKeepAlive,
  conversationOf,
  KEEP_ALIVE_ATTR,
  KEEP_ALIVE_COUNT_ATTR,
  KEEP_ALIVE_FINDING_ATTR,
  KEEP_ALIVE_TICK_MS,
  KEEP_ALIVE_TTL_ATTR,
  type KeepAliveOutcome,
  keepAliveRequestOf,
  type KeepAliveSnapshot,
} from "./cache-keep-alive";
import { GUARD_MESSAGES, guardLoopbackRequest } from "./loopback-guard";
import {
  createDaySpend,
  type DaySpendDeps,
  nextUtcDayStart,
  utcDay,
} from "./day-spend";
import { modelVerdict } from "./model-allowlist";
import {
  callCeilingMicros,
  priceObservedUsage,
  resolveModelPrice,
  resolveModelPriceMatch,
  usdToMicros,
} from "./model-pricing";
import { RequestPrefixMemory, type RequestShape } from "./request-prefix";
import {
  type AttachedCredential,
  CREDENTIAL_HEADERS,
  DEFAULT_MODEL_UPSTREAMS,
  downstreamResponseHeaders,
  MODEL_PROXY_ROUTES,
  type ModelRoute,
  type ModelUpstreams,
  providerError,
  resolveModelRoute,
  upstreamRequestHeaders,
  upstreamUrlFor,
} from "./model-routes";
import {
  decoderFor,
  estimateCutUsage,
  foldUsageDocument,
  hasTokenCounts,
  type ModelApi,
  type ModelProvider,
  type ObservedUsage,
  UsageMeter,
} from "./model-usage";
import {
  isInternalSession,
  type SessionRecord,
  type SessionRegistry,
} from "./registry";
import {
  onSessionQueue,
  recordOnChain,
  type SessionExclusive,
} from "./chain-write";

/** What `beforeForward` is handed, and what it returns. */
export interface ForwardRequest {
  provider: ModelProvider;
  api: ModelApi;
  method: string;
  /** The upstream path and query. */
  path: string;
  /**
   * The request body as JSON, when it is a JSON object. To change the body,
   * return a request whose `json` is a NEW object. The proxy re-serializes
   * only when the reference changed, so an untouched request is forwarded
   * byte for byte.
   */
  json?: Record<string, unknown>;
  /** The session the call was correlated to, when one was. */
  session?: { harnessSessionId: string; sessionUuid: string };
}

/**
 * The seam for per-turn volatile steering (story sheet item 6, injection
 * point 5). Phase 1's assembler plugs in here. Nothing does today.
 */
export type BeforeForward = (
  request: ForwardRequest,
) => ForwardRequest | Promise<ForwardRequest>;

/** Why a call was refused, as the frame and the `x-oxagen-refusal` header say it. */
export type ModelRefusalCode =
  | "session_budget_exceeded"
  | "daily_budget_exceeded"
  | "model_not_permitted"
  | "model_ambiguous"
  | "session_paused"
  | "session_cancelled"
  | "host_paused"
  | "host_suspended"
  | "host_revoked"
  | CredentialRefusalCode;

/**
 * The credential seam's refusals (ADR-143). The four `run_token_*` codes are
 * the token codec's own. `run_token_required`: the provider is brokered on
 * this host and the call brought no credential at all. `foreign_credential`:
 * the provider is brokered and the call brought a vendor credential of its
 * own, which is the bypass custody exists to close (a key in the shell's
 * environment wins over Claude Code's helper, so this is what a person sees
 * when they export one). `credential_unavailable`: a valid run token, and
 * nothing in custody to spend it with.
 */
export type CredentialRefusalCode =
  | RunTokenRefusal
  | "run_token_required"
  | "foreign_credential"
  | "credential_unavailable";

export interface ModelProxyPolicy {
  bundle: PolicyBundle;
  hostStatus: "active" | "paused" | "suspended" | "revoked";
}

/**
 * The credential seam (ADR-143): what the gateway holds in custody for a
 * provider, and how it checks the run token a harness presents in place of
 * a vendor key. A provider with nothing in custody is `harness_held`, and its
 * calls cross as they always did. A provider with a credential in custody is
 * `gateway_brokered`: its calls must carry a run token, and the proxy swaps
 * the token for the credential on the way out. Absent altogether, every
 * provider is `harness_held`.
 */
export interface CredentialBroker {
  /** Whether the provider is brokered on this host. Reads no secret. */
  brokered: (provider: RunTokenProvider) => boolean;
  /** The custody credential, opened only once a run token has verified. */
  custody: (provider: RunTokenProvider) => HeldCredential | undefined;
  verify: (token: string, provider: RunTokenProvider) => RunTokenVerdict;
}

export interface ModelProxyDeps {
  registry: SessionRegistry;
  /** The daemon's own chain, for a call no session can be found for. */
  hostRecorder: () => SessionRecorder;
  /**
   * Append sealed events, and the bodies of those that carry one, to the WAL;
   * the daemon's `record`. The bodies are drained from the recorder in the
   * same call that takes the events, because the WAL files a body next to its
   * event and the recorder holds it nowhere else.
   */
  record: (
    events: readonly TachoEvent[],
    bodies?: readonly FrameBody[],
  ) => void;
  /**
   * Run a call's frame on its session's queue, where the session's hooks
   * run. The daemon's is the transcript tailer's. Absent, the frame is sealed
   * as the call settles.
   */
  exclusive?: SessionExclusive;
  policy: () => ModelProxyPolicy;
  upstreams?: () => ModelUpstreams;
  /** Observed spend already on a session's chain, read once per session. */
  priorSpendMicros?: (sessionUuid: string) => number;
  /**
   * This host's observed spend on a UTC day (`YYYY-MM-DD`), read from its
   * WAL once per process, for the first day the day budget is asked about
   * (ADR-160). A later day starts at zero (`createDaySpend`).
   */
  priorDaySpendMicros?: DaySpendDeps["priorDaySpendMicros"];
  /** The control plane's latest figures for the agent's day, when it sent any. */
  recordedDaySpend?: DaySpendDeps["recordedDaySpend"];
  beforeForward?: BeforeForward;
  credentials?: CredentialBroker;
  /** How long `beforeForward` may take before the original is sent. */
  beforeForwardTimeoutMs?: number;
  /**
   * How long a refused call waits for its frame on the session's queue
   * before it is answered anyway (`DEFAULT_REFUSAL_FRAME_WAIT_MS`).
   */
  refusalFrameWaitMs?: number;
  /** The most request bytes held for one call. */
  maxRequestBytes?: number;
  /** Abort an upstream that sends nothing for this long. */
  upstreamIdleMs?: number;
  /** Answer 504 when no connection to the vendor is open this long after the call. */
  upstreamConnectMs?: number;
  /** How often the cache keep-alive checks for a keep-alive that is due. */
  keepAliveTickMs?: number;
  /** The port the listener answers on, for the loopback guard. */
  port: () => number | undefined;
  log: (line: string) => void;
  now: () => number;
}

export interface ModelProxyStats {
  callsObserved: number;
  refused: number;
  inFlight: number;
}

export interface ModelProxy {
  handle: (req: IncomingMessage, res: ServerResponse) => void;
  /** Answer a websocket upgrade: the proxy speaks HTTP only. */
  handleUpgrade: (req: IncomingMessage, socket: Duplex) => void;
  /**
   * Abort every in-flight call of a session. Returns how many were cut.
   * `retry` answers the cut call as one the harness retries (see `InFlight`).
   */
  abortSession: (
    sessionUuid: string,
    reason: string,
    retry?: RetryableCut,
  ) => number;
  /** Model calls observed for a session since the daemon started. */
  callsObservedFor: (sessionUuid: string) => number;
  /**
   * Send every cache keep-alive that is due now. The proxy runs this on its
   * own timer (`keepAliveTickMs`); a test runs it with the clock it chose.
   */
  keepAliveTick: () => Promise<void>;
  stats: () => ModelProxyStats;
  close: () => void;
}

const DEFAULT_MAX_REQUEST_BYTES = 64 * 1024 * 1024;

/**
 * Why the proxy answered a model call without forwarding it (ADR-256). The
 * value is the frame's `api_error_class` and its `oxagen.not_forwarded`.
 *
 * - `request_too_large`: the request passed the bytes the proxy holds for
 *   one call, and the harness was answered 413.
 * - `client_aborted`: the harness left, or its connection broke, before the
 *   whole request arrived.
 * - `gateway_error`: the proxy threw before it opened the call to the
 *   vendor, and the harness was answered 502.
 */
type NotForwardedReason =
  | "request_too_large"
  | "client_aborted"
  | "gateway_error";

/** The attr that marks a frame for a call the vendor never received. */
const NOT_FORWARDED_ATTR = "oxagen.not_forwarded";

/**
 * How far one model call got (ADR-256). `forward` fills it in as it goes.
 * When `forward` throws, the request handler reads it to tell a call that
 * was never forwarded, which still owes a frame, from one whose frame is
 * sealed or belongs to `settle`.
 */
interface CallAttempt {
  /** Epoch ms the proxy started reading the request. */
  startedAt: number;
  /** The request bytes read so far. */
  bytesRead: number;
  /** The whole request as it arrived, once it has. */
  request?: Buffer;
  /** The model the request asked for, once read. */
  model?: string;
  /**
   * The session the call was attributed to, when one was, the chain its
   * frame lands on, how, and its frame attrs.
   */
  attribution?: {
    record?: SessionRecord;
    recorder: SessionRecorder;
    how: string;
    attrs: Record<string, string>;
  };
  /** The call's frame is sealed, or `settle` will seal it. */
  done: boolean;
}

/**
 * What a metered call spent, counted the moment it settles. The frame that
 * records it can wait on the session's queue, but the next call's admission
 * reads the spend now.
 */
interface CallMetering {
  usage: ObservedUsage;
  model: string | undefined;
  /** The stream stopped before the vendor's closing count, so `usage` is partly estimated. */
  cut: boolean;
  priced: number | undefined;
  /** Priced by a family row alone, so the figure is the family's. */
  familyPriced: boolean;
  settledAt: number;
  durationMs: number;
  /** The call's error class, or `http_<status>` for a 4xx or 5xx answer. */
  failed: string | undefined;
}
const DEFAULT_UPSTREAM_IDLE_MS = 10 * 60_000;
const DEFAULT_BEFORE_FORWARD_TIMEOUT_MS = 250;
const DEFAULT_UPSTREAM_CONNECT_MS = 30_000;
/**
 * How long a refused call waits for its frame on the session's queue. A hook
 * holds that queue between its seal and its write, usually for less than the
 * 500 ms a prompt gives its recalled memories. Past this the refusal is
 * answered anyway and the frame lands when the queue frees, so a hook that
 * runs long never holds a model call with it.
 */
const DEFAULT_REFUSAL_FRAME_WAIT_MS = 1_000;

/**
 * Whether `landing` settled within `ms`: true when it did, false when the
 * time ran out first. A rejection within the time is thrown. Past it the
 * landing goes on, and its rejection is the caller's to catch.
 */
async function landedWithin(
  landing: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      landing.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
/**
 * How long a pooled upstream connection may sit idle before the proxy closes
 * it. Below the vendors' own keep-alive windows, so the proxy retires a
 * connection before the vendor does: sending a call down one the far end
 * has just closed is what turns a healthy call into an `ECONNRESET`.
 */
const FREE_SOCKET_TIMEOUT_MS = 30_000;
/**
 * How long a cache keep-alive may take. It asks for no output and reads a
 * cached prefix, so it answers in seconds when the prefix is still there.
 */
const KEEP_ALIVE_TIMEOUT_MS = 60_000;
/** The most of a keep-alive's answer the proxy holds: a usage block and no content. */
const KEEP_ALIVE_MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * What the proxy keeps of a parent's last request so it can send the cache
 * keep-alive (`cache-keep-alive.ts`). It holds the caller's credential, so it
 * never reaches a frame, the WAL, or a log line.
 */
interface KeepAlivePayload {
  /** The keep-alive request: the parent's, with `max_tokens: 0` and no `stream`. */
  body: Buffer;
  /** The upstream headers the parent's call went out with, for this body. */
  headers: string[];
  target: URL;
  basis: TachoCredentialBasis;
  /** The run token the parent's call presented, by id. */
  runTokenId?: string;
  /**
   * The shape of the parent's request, when the parent's frame stored that
   * request. The keep-alive's body then stores only what differs from it.
   */
  priorShape?: RequestShape;
}

/**
 * The keep-alive a request would leave behind: the conversation it belongs
 * to and the request to resend. Undefined when the request is not a JSON
 * object, or names a setting `max_tokens: 0` refuses.
 */
function keepAliveCandidateOf(
  request: Record<string, unknown>,
  conversation: string,
): { conversation: string; body: Buffer } | undefined {
  const keep = keepAliveRequestOf(request);
  if (keep === undefined) return undefined;
  return {
    conversation,
    body: Buffer.from(JSON.stringify(keep), "utf8"),
  };
}

/**
 * Why a cut call may be retried. `daemon_stopping`: the service manager
 * starts the daemon again within seconds. `steer`: an operator's interrupt
 * steer cut the call so the steer lands before the step the call would have
 * produced. A refusal there would end the turn in StopFailure, whose answer
 * Claude Code ignores, and the steer would never reach the agent. A retried
 * call reaches the next hook, which delivers it.
 */
export type RetryableCut = "daemon_stopping" | "steer";

interface InFlight {
  /**
   * End the call. An operator's pause, cancel or kill is a refusal the
   * harness must not retry. Every `RetryableCut` is answered as retryable.
   */
  abort: (reason: string, retry?: RetryableCut) => void;
  /**
   * The ceiling the call holds against its session's budget and its agent's
   * day budget until it settles.
   */
  reserved: number;
}

/**
 * Close a pooled connection once it has idled `FREE_SOCKET_TIMEOUT_MS`. The
 * agent's own `free` listener runs first and either hands the socket to a
 * queued call or pools it, and only a pooled one is timed: the agent destroys
 * a pooled socket on its `timeout`, and the next call that takes one from the
 * pool sets its own idle timeout.
 */
export function retireIdleSockets(agent: HttpAgent): void {
  agent.on("free", (socket: Socket) => {
    const pooled = Object.values(agent.freeSockets).some(
      (sockets) => sockets?.includes(socket) === true,
    );
    if (!pooled) return;
    const timeout = socket.timeout ?? 0;
    if (timeout === 0 || timeout > FREE_SOCKET_TIMEOUT_MS)
      socket.setTimeout(FREE_SOCKET_TIMEOUT_MS);
  });
}

function isLoopbackPeer(address: string | undefined): boolean {
  if (address === undefined) return false;
  const bare = address.startsWith("::ffff:") ? address.slice(7) : address;
  return bare === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" && first.length > 0 ? first : undefined;
}

/**
 * One half of an exchange, decoded, held for the frame body and dropped the
 * moment it passes what one body may carry.
 *
 * The cap is not an optimisation. The proxy sits in the agent's critical path
 * and a model response has no ceiling of its own, so buffering one the host
 * could never ship would spend the agent's memory on bytes `prepareContent`
 * would refuse anyway. Past the cap the chunks already held are released and
 * the frame records that it has no body, which reads as a size limit rather
 * than as a proxy that never captured.
 */
class BodyCapture {
  private chunks: Buffer[] = [];
  private held = 0;
  private dropped = false;

  write(chunk: Buffer): void {
    if (this.dropped) return;
    this.held += chunk.length;
    if (this.held > TACHO_MAX_BODY_BYTES) {
      this.dropped = true;
      this.chunks = [];
      return;
    }
    this.chunks.push(chunk);
  }

  /** The bytes as text, or nothing when none came or they were dropped. */
  text(): string | undefined {
    if (this.dropped || this.chunks.length === 0) return undefined;
    return Buffer.concat(this.chunks).toString("utf8");
  }

  get tooLarge(): boolean {
    return this.dropped;
  }
}

/**
 * The call as one frame body: the request the vendor read and the response it
 * sent, both decoded, in one JSON object.
 *
 * They ride together because a frame carries at most one body. `tachoBodySchema`
 * keys bodies by `event_id_idem` and the WAL answers at most one per event,
 * and one model call seals exactly one `llm_call` frame, so either both halves
 * are in that body or neither half replays. A `tool_call` frame from a hook
 * carries its input and its output the same way (`toolCallContent` in
 * `claude-code/hooks.ts`).
 *
 * Each half is a string holding the exact decoded text rather than re-parsed
 * JSON. A reader who wants structure parses the member; one who wants to check
 * the body against what crossed the wire can, which re-serialising would cost
 * them. JCS drops an absent member, so a call whose response was too large to
 * hold ships `{"request":...}` alone. That half still replays, so it ships.
 * The frame names the missing half (`RESPONSE_BODY_OMITTED_ATTR`,
 * `REQUEST_BODY_OMITTED_ATTR`), and the seal counts it as a frame missing its
 * body, so the replay grade stays below `view`.
 */
function exchangeContent(
  request: string | undefined,
  response: string | undefined,
): DraftContent | undefined {
  if (request === undefined && response === undefined) return undefined;
  return jsonContent(jcs({ request, response }));
}

/**
 * The request body decoded for reading only; the forwarded bytes are the caller's.
 *
 * Decoding stops at `maxOutputLength` bytes, the same ceiling the proxy holds
 * for a raw body. Gzip and deflate inflate up to about a thousandfold, and
 * brotli and zstd further, so a request under the raw ceiling could decode to
 * more memory than the daemon has. A body that inflates past the ceiling
 * reads as one nobody here can decode: a workspace with a `models` clause
 * refuses it, and without one it is forwarded as it came, for the vendor to
 * refuse.
 */
function readableBody(
  body: Buffer,
  encoding: string | undefined,
  maxOutputLength: number,
): Buffer | undefined {
  const name = (encoding ?? "").trim().toLowerCase();
  const limit = { maxOutputLength };
  try {
    if (name === "" || name === "identity") return body;
    if (name === "zstd") return zstdDecompressSync(body, limit);
    if (name === "gzip" || name === "x-gzip") return gunzipSync(body, limit);
    if (name === "br") return brotliDecompressSync(body, limit);
    if (name === "deflate") return inflateSync(body, limit);
  } catch {
    // A body nobody here can decode, or one that inflates past the ceiling,
    // is still forwarded as it came.
  }
  return undefined;
}

function parseJsonObject(
  bytes: Buffer | undefined,
): Record<string, unknown> | undefined {
  if (bytes === undefined || bytes.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Both SDKs and Codex put `model` first, so the common case needs no parse. */
function leadingModel(bytes: Buffer | undefined): string | undefined {
  if (bytes === undefined) return undefined;
  const head = bytes.subarray(0, 512).toString("utf8");
  return /^\s*\{\s*"model"\s*:\s*"([^"\\]{1,256})"/.exec(head)?.[1];
}

/**
 * The model a request asks for, and whether the request states it only once.
 *
 * The parsed body is the authority, not the leading bytes. `leadingModel`
 * matches the first `"model"` member and `JSON.parse` keeps the last
 * duplicate, so a body carrying two `model` members can read as one model here
 * and as another to the vendor, which receives the original bytes. Checking
 * the first member and forwarding a body whose last member names a denied
 * model is an allowlist that admits exactly what it exists to refuse, and the
 * frame would then record the model that was checked rather than the one that
 * ran.
 *
 * So the leading read survives only as the fallback for a body that does not
 * parse, which the vendor rejects anyway, and a disagreement between the two is
 * reported as `ambiguous` for the caller to refuse on. Parsing costs one pass
 * over a body the proxy is about to spend a network round trip on, and the
 * Anthropic path already parses it to correlate the session.
 *
 * One function because two places need the same answer: the mandate check
 * before the call is admitted, and the frame after it is forwarded.
 */
function modelOf(
  readable: () => Buffer | undefined,
  json: () => Record<string, unknown> | undefined,
): { model: string | undefined; ambiguous: boolean } {
  const parsed = json()?.["model"];
  // Clamped to the envelope's `model` column (`short`, 512 chars,
  // `envelope.ts`): a request that names an absurd model must not carry that
  // string onto the frame unclamped and fail to seal it.
  const fromBody =
    typeof parsed === "string" ? parsed.slice(0, 512) : undefined;
  const leading = leadingModel(readable());
  return {
    model: fromBody ?? leading,
    ambiguous:
      leading !== undefined && fromBody !== undefined && leading !== fromBody,
  };
}

/** The longest effort word a frame carries: the run contract's `effort` bound. */
const REQUEST_EFFORT_MAX = 32;

/**
 * The reasoning effort a model request body asks for, as sent (#3891), or
 * undefined when it names none.
 *
 * Each vendor spells the setting in its own place, and the proxy reads the
 * one each request shape carries (packages/ai/src/provider-posture.ts):
 * - Anthropic Messages: `output_config.effort`.
 * - OpenAI Responses: `reasoning.effort`.
 * - OpenAI Chat Completions: `reasoning_effort`.
 *
 * A value that is not a non-blank string is ignored rather than guessed at,
 * and a long one is clamped so the frame always seals. The word is kept as
 * the vendor received it: Oxagen records the setting, it does not map one
 * vendor's ladder onto another's.
 *
 * @internal Exported for its unit test.
 */
export function requestEffortOf(
  json: Record<string, unknown> | undefined,
): string | undefined {
  if (json === undefined) return undefined;
  const member = (value: unknown, key: string): unknown =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)[key]
      : undefined;
  for (const candidate of [
    member(json["output_config"], "effort"),
    member(json["reasoning"], "effort"),
    json["reasoning_effort"],
  ]) {
    if (typeof candidate !== "string") continue;
    const effort = candidate.trim();
    if (effort !== "") return effort.slice(0, REQUEST_EFFORT_MAX);
  }
  return undefined;
}

/**
 * The session id inside an Anthropic `metadata.user_id`. Current Claude Code
 * sends a JSON string with a `session_id` member. Older builds sent
 * `user_<hash>_account_<uuid>_session_<uuid>`.
 */
export function sessionFromAnthropicMetadata(
  json: Record<string, unknown> | undefined,
): string | undefined {
  const metadata = json?.["metadata"];
  if (typeof metadata !== "object" || metadata === null) return undefined;
  const userId = (metadata as Record<string, unknown>)["user_id"];
  if (typeof userId !== "string") return undefined;
  if (userId.startsWith("{")) {
    try {
      const inner = JSON.parse(userId) as Record<string, unknown>;
      const id = inner["session_id"];
      if (typeof id === "string" && id.length > 0) return id;
    } catch {
      // Not the JSON form. Try the legacy one.
    }
  }
  return /_session_([0-9a-fA-F-]{8,64})$/.exec(userId)?.[1];
}

/**
 * The credential a request carries. A run token wins over anything else it
 * sent: a Claude Code signed in to claude.ai and running the helper may send
 * its login as `Authorization` beside the token in `X-Api-Key`, and both are
 * dropped on attach, so the token is the one that decides.
 */
function presentedCredential(
  req: IncomingMessage,
): { header: string; value: string } | undefined {
  let first: { header: string; value: string } | undefined;
  for (const name of CREDENTIAL_HEADERS) {
    const raw = header(req, name);
    if (raw === undefined) continue;
    const value =
      name === "authorization" ? raw.replace(/^Bearer\s+/i, "") : raw;
    if (value.length === 0) continue;
    if (looksLikeRunToken(value)) return { header: name, value };
    first ??= { header: name, value };
  }
  return first;
}

/** A refusal that the harness can act on by itself gets a 401; the rest 403. */
function credentialRefusalStatus(code: CredentialRefusalCode): 401 | 403 {
  return code === "run_token_expired" ||
    code === "run_token_invalid" ||
    code === "run_token_malformed"
    ? 401
    : 403;
}

interface ResolvedCredential {
  basis: TachoCredentialBasis;
  /** The custody credential to send in place of the token, when brokered. */
  attach?: AttachedCredential;
  /** The run token's claims, verified or merely read off a refused token. */
  claims?: RunTokenClaims;
  refusal?: { code: CredentialRefusalCode; message: string };
}

const CREDENTIAL_MESSAGES: Record<CredentialRefusalCode, string> = {
  run_token_malformed:
    "The credential this call carried is not a run token this Oxagen gateway can read.",
  run_token_invalid:
    "The run token this call carried was not issued by this Oxagen gateway. Run `oxagen credential status` on this machine.",
  run_token_expired:
    "The run token this call carried has expired. The harness fetches a new one from the Oxagen gateway on its next attempt.",
  run_token_mismatch:
    "The run token this call carried was issued for another host or another model provider.",
  run_token_required:
    "This machine brokers model credentials through the Oxagen gateway, and this call carried none. Run `oxagen agent enroll` again to point the harness at the gateway's run tokens.",
  foreign_credential:
    "This machine brokers model credentials through the Oxagen gateway, and this call brought its own. Unset the provider's API key (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or OPENAI_API_KEY) in the shell and in the env block of any .claude/settings.json or .claude/settings.local.json the harness reads; the gateway supplies the credential.",
  credential_unavailable:
    "The run token is valid, but the Oxagen gateway holds no credential for this model provider. Run `oxagen agent enroll` again, or `oxagen credential status` to see what is in custody.",
};

export function createModelProxy(deps: ModelProxyDeps): ModelProxy {
  const maxRequestBytes = deps.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  const upstreamIdleMs = deps.upstreamIdleMs ?? DEFAULT_UPSTREAM_IDLE_MS;
  const hookTimeoutMs =
    deps.beforeForwardTimeoutMs ?? DEFAULT_BEFORE_FORWARD_TIMEOUT_MS;
  const refusalWaitMs =
    deps.refusalFrameWaitMs ?? DEFAULT_REFUSAL_FRAME_WAIT_MS;
  // Unbounded: a per-origin cap here queues a session's own concurrent
  // streams against each other, which a proxy in the critical path must not
  // do. `keepAlive` still reuses connections; nothing here limits how many
  // are open at once.
  const httpAgent = new HttpAgent({ keepAlive: true, maxSockets: Infinity });
  const httpsAgent = new HttpsAgent({ keepAlive: true, maxSockets: Infinity });
  const inFlight = new Map<string, Set<InFlight>>();
  const spent = new Map<string, number>();
  const daySpend = createDaySpend({
    ...(deps.priorDaySpendMicros !== undefined
      ? { priorDaySpendMicros: deps.priorDaySpendMicros }
      : {}),
    ...(deps.recordedDaySpend !== undefined
      ? { recordedDaySpend: deps.recordedDaySpend }
      : {}),
  });
  const observed = new Map<string, number>();
  // What each session's last landed call carried, so the next call's body
  // holds only what is new (`request-prefix.ts`), and that call's system
  // context, so the next call's frame can resolve the part it cut
  // (`system-context.ts`).
  const priors = new RequestPrefixMemory<RequestContext>();
  let callsObserved = 0;
  let refused = 0;
  retireIdleSockets(httpAgent);
  retireIdleSockets(httpsAgent);
  const upstreamConnectMs =
    deps.upstreamConnectMs ?? DEFAULT_UPSTREAM_CONNECT_MS;

  const HOST_KEY = "host";

  // The cache keep-alive (lane F32). The module decides when; the proxy
  // sends, because the request it repeats carries the caller's credential.
  const keepAlive = new CacheKeepAlive<SessionRecord, KeepAlivePayload>({
    now: deps.now,
    live: (record) => !record.sealed && record.pendingTerminal !== true,
    // A parent waits while one of its subagents is open: the hooks open a
    // subagent's chain at `SubagentStart` and close it at `SubagentStop`.
    waiting: (record) => record.recorder.openChildren.size > 0,
    finding: () => cacheKeepAliveFinding(deps.policy().bundle),
    price: (model) =>
      resolveModelPrice(deps.policy().bundle.model_prices, "anthropic", model),
    send: (record, snapshot, count, finding) =>
      sendKeepAlive(record, snapshot, count, finding),
    log: deps.log,
  });
  const keepAliveTimer = setInterval(() => {
    keepAlive.tick().catch((error: unknown) => {
      deps.log(
        `model proxy: the cache keep-alive check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }, deps.keepAliveTickMs ?? KEEP_ALIVE_TICK_MS);
  keepAliveTimer.unref();

  function spendFor(sessionUuid: string): number {
    let value = spent.get(sessionUuid);
    if (value === undefined) {
      try {
        value = deps.priorSpendMicros?.(sessionUuid) ?? 0;
      } catch {
        value = 0;
      }
      spent.set(sessionUuid, value);
    }
    return value;
  }

  /** The ceilings a session's calls in flight hold against its budget. */
  function heldFor(sessionUuid: string): number {
    let held = 0;
    for (const call of inFlight.get(sessionUuid) ?? []) held += call.reserved;
    return held;
  }

  /**
   * The ceilings every call in flight holds, whatever session it belongs to.
   * The day budget is the agent's, so it counts all of them, including calls
   * no session could be found for.
   */
  function heldAll(): number {
    let held = 0;
    for (const calls of inFlight.values())
      for (const call of calls) held += call.reserved;
    return held;
  }

  /**
   * The ceiling an admitted call holds against its budgets while it is in
   * flight (`callCeilingMicros`), from the output cap the request states.
   * Nothing unless the budget is enforced with a limit that applies to this
   * call: an observed budget refuses no call, so a call has nothing to hold.
   * The session limit applies only to a call filed under a session, and the
   * day limit applies to every call.
   */
  function ceilingFor(
    route: ModelRoute,
    model: string | undefined,
    requestBytes: number,
    json: Record<string, unknown> | undefined,
    hasSession: boolean,
  ): number {
    const { budget, model_prices: prices } = deps.policy().bundle;
    if (budget.mode !== "enforced") return 0;
    const limited =
      (hasSession && budget.session_limit_usd !== undefined) ||
      budget.daily_limit_usd !== undefined;
    if (!limited) return 0;
    const cap =
      json?.["max_tokens"] ??
      json?.["max_output_tokens"] ??
      json?.["max_completion_tokens"];
    return callCeilingMicros(
      prices,
      route.provider,
      model,
      requestBytes,
      typeof cap === "number" && Number.isFinite(cap) && cap > 0
        ? Math.ceil(cap)
        : undefined,
    );
  }

  function harnessFor(provider: ModelProvider): TachoHarness {
    return defaultHarnessForProvider(provider);
  }

  function correlate(
    req: IncomingMessage,
    route: ModelRoute,
    body: () => Record<string, unknown> | undefined,
  ): { record?: SessionRecord; how: string } {
    const harness = route.harness ?? harnessFor(route.provider);
    const explicit = header(req, TACHO_MODEL_SESSION_HEADER);
    // Stella sends no session header of its own, so a native header on its
    // prefix would be some other harness's and is not read.
    const native =
      route.harness !== undefined
        ? undefined
        : route.provider === "anthropic"
          ? header(req, "x-claude-code-session-id")
          : (header(req, "session-id") ?? header(req, "session_id"));
    let id = explicit ?? native;
    let how = explicit !== undefined ? "header" : "harness_header";
    if (id === undefined && route.api === "anthropic.messages") {
      id = sessionFromAnthropicMetadata(body());
      how = "request_metadata";
    }
    if (
      id === undefined &&
      route.harness === undefined &&
      route.provider === "openai"
    ) {
      // Codex sends its conversation id twice, as `session_id` and as
      // `conversation_id`; the second is read here.
      id = header(req, "conversation_id");
      how = "harness_header";
    }
    if (
      id === undefined &&
      route.harness === undefined &&
      route.api === "openai.responses"
    ) {
      // Codex also sets `prompt_cache_key` to its conversation id. Any client
      // may set that key to anything, so it is taken only when it names a
      // session this host already knows, and never opens one.
      const key = body()?.["prompt_cache_key"];
      if (typeof key === "string" && deps.registry.get(key) !== undefined) {
        id = key;
        how = "request_cache_key";
      }
    }
    if (id !== undefined && !isInternalSession(id) && id.length <= 256) {
      const known = deps.registry.get(id);
      if (known !== undefined && !known.sealed && !known.pendingTerminal)
        return { record: known, how };
      if (known !== undefined) {
        // The record is sealed, or its terminal is waiting to land. `get`
        // prefers an open record, but a pending one reads as open to it, so
        // another harness's live record for the same id is looked for by
        // hand before the call is filed on the host's own chain: `ensure`
        // would hand back the closed record and seal a frame after its
        // terminal.
        const open = deps.registry
          .list()
          .find(
            (record) =>
              record.harnessSessionId === id &&
              !record.sealed &&
              !record.pendingTerminal,
          );
        if (open !== undefined) return { record: open, how };
        return { how: "session_closed" };
      }
      // Seen here before any hook named it: open it as ambient, the way a
      // session first seen through OTel is opened, and let the hook adopt it.
      const { record } = deps.registry.ensure(id, { harness, ambient: true });
      return { record, how };
    }
    const live = deps.registry
      .live()
      .filter(
        (record) =>
          !isInternalSession(record.harnessSessionId) &&
          !record.ambient &&
          deps.registry.agentOf(record).harness === harness,
      );
    if (live.length === 1)
      return { record: live[0] as SessionRecord, how: "sole_live_session" };
    return { how: "unattributed" };
  }

  /**
   * Whether this call is refused, and why.
   *
   * `model` is the model id the request asks for, resolved by the caller
   * before this runs. It has to be: the model branch below cannot check a
   * string that does not exist yet, and reading it after the refusal decision
   * would leave an allowlist that silently never fires — which is what the
   * 2026-09-21 gateway audit found when it looked for one. `undefined` means
   * the proxy could not read a model from the request, and the model branch
   * then permits the call rather than refusing on an absence.
   *
   * `modelAmbiguous` says the request named more than one model, so no single
   * string describes what the vendor will run. It is refused only when the
   * workspace armed a `models` clause, because only then can a model the
   * proxy cannot pin slip past a list the call must answer to. With no
   * clause there is no list to slip past, so the call is forwarded, and its
   * `llm_call` frame carries `oxagen.model_ambiguous`. Unless the vendor
   * reports the model it ran, that frame records and prices the last
   * duplicate, the one a JSON parser keeps, and the attribute says so.
   */
  function refusalFor(
    record: SessionRecord | undefined,
    model: string | undefined,
    modelAmbiguous: boolean,
    requiresModel: boolean,
  ):
    | {
        code: ModelRefusalCode;
        message: string;
        source: "human" | "bundle";
        /** Facts the refusal's frame carries beside the reason code. */
        attrs?: Record<string, string>;
      }
    | undefined {
    const view = deps.policy();
    if (view.hostStatus !== "active") {
      return {
        code: `host_${view.hostStatus}` as ModelRefusalCode,
        message: `This host is ${view.hostStatus} by its Oxagen operator. Model calls are refused until it is active again.`,
        source: "human",
      };
    }
    if (record !== undefined && record.control.cancelled !== null) {
      return {
        code: "session_cancelled",
        message: `This session was cancelled by its Oxagen operator: ${record.control.cancelled}`,
        source: "human",
      };
    }
    if (record !== undefined && record.control.paused !== null) {
      return {
        code: "session_paused",
        message: `This session is paused by its Oxagen operator: ${record.control.paused}. Model calls resume when the operator resumes it.`,
        source: "human",
      };
    }
    // Only an explicitly armed workspace policy produces a model clause.
    // The agent's budget does not arm or disarm the workspace's decision.
    const models = view.bundle.models;
    if (
      models !== undefined &&
      (modelAmbiguous || (requiresModel && model === undefined))
    ) {
      return {
        code: "model_ambiguous",
        message:
          "Oxagen cannot identify one model in this request. Send a readable request naming exactly one model.",
        source: "bundle",
      };
    }
    if (models !== undefined) {
      const verdict = modelVerdict(models, model);
      if (verdict !== undefined) {
        const named = model ?? "the requested model";
        return {
          code: "model_not_permitted",
          message:
            verdict === "denied"
              ? `This workspace's Oxagen mandate refuses ${named}. Ask the workspace's operator to allow it, or use a model the mandate permits.`
              : `This workspace's Oxagen mandate permits only its allowed models, and ${named} is not one of them. Ask the workspace's operator to add it.`,
          source: "bundle",
        };
      }
    }
    const budget = view.bundle.budget;
    if (
      record !== undefined &&
      budget.mode === "enforced" &&
      budget.session_limit_usd !== undefined
    ) {
      const limit = usdToMicros(budget.session_limit_usd);
      const used = spendFor(record.recorder.sessionUuid);
      // What the calls already in flight may still spend counts as spent, so
      // parallel calls cannot all pass on the same settled figure.
      const held = heldFor(record.recorder.sessionUuid);
      if (used + held >= limit) {
        return {
          code: "session_budget_exceeded",
          message:
            held > 0
              ? `This session's Oxagen budget is taken: $${(used / 1_000_000).toFixed(2)} observed and up to $${(held / 1_000_000).toFixed(2)} held by calls in flight, of a $${budget.session_limit_usd.toFixed(2)} limit. Send the call again once those finish, or ask the workspace's operator to raise the limit.`
              : `This session reached its Oxagen budget: $${(used / 1_000_000).toFixed(2)} observed of a $${budget.session_limit_usd.toFixed(2)} limit. Ask the workspace's operator to raise the limit, or start a new session.`,
          source: "bundle",
        };
      }
    }
    // The day ceiling belongs to the agent, not to a session, so it holds
    // for a call no session could be found for too (ADR-160).
    if (budget.mode === "enforced" && budget.daily_limit_usd !== undefined) {
      const day = utcDay(deps.now());
      const limit = usdToMicros(budget.daily_limit_usd);
      const used = daySpend.total(day);
      // As for the session: what calls in flight may still spend counts as
      // spent, so parallel calls cannot all pass on the same settled figure.
      const held = heldAll();
      if (used + held >= limit) {
        return {
          code: "daily_budget_exceeded",
          message:
            held > 0
              ? `This agent's Oxagen daily budget is taken: $${(used / 1_000_000).toFixed(2)} observed and up to $${(held / 1_000_000).toFixed(2)} held by calls in flight, of a $${budget.daily_limit_usd.toFixed(2)} limit on ${day} (UTC). Send the call again once those finish, or ask the workspace's operator to raise the limit.`
              : `This agent reached its Oxagen daily budget: $${(used / 1_000_000).toFixed(2)} observed of a $${budget.daily_limit_usd.toFixed(2)} limit on ${day} (UTC). It resets at ${nextUtcDayStart(day)}. Ask the workspace's operator to raise the limit.`,
          source: "bundle",
          attrs: {
            "oxagen.day": day,
            "oxagen.day_spend_usd_micros": String(used),
          },
        };
      }
    }
    return undefined;
  }

  /**
   * Decide what credential this call goes out with. Only the metered APIs and
   * the vendor's other endpoints under the same prefix are looked at the same
   * way: a provider with custody is brokered for every path it serves, since
   * `/v1/models` spends the same key as `/v1/messages`.
   */
  function resolveCredential(
    req: IncomingMessage,
    route: ModelRoute,
  ): ResolvedCredential {
    const broker = deps.credentials;
    const presented = presentedCredential(req);
    // The ChatGPT login: Codex sends its OAuth bearer with a
    // `ChatGPT-Account-ID`, and chatgpt.com takes no API key, so custody of an
    // OpenAI key has nothing to offer this call. It crosses as the harness's
    // own whatever the host holds.
    //
    // Stella's prefix is never brokered. Custody is taken from Claude Code
    // and Codex, and Stella keeps its own key, so the key Stella sends is its
    // own and not a bypass of anybody's custody.
    const brokered =
      broker !== undefined &&
      route.upstream !== "chatgpt" &&
      route.harness !== "stella" &&
      broker.brokered(route.provider);
    if (broker === undefined || !brokered) {
      // Nothing in custody for this provider: the harness's own credential
      // crosses untouched. A run token presented here is refused all the
      // same, because the vendor would refuse it and the person deserves a
      // reason that names the gateway.
      if (presented !== undefined && looksLikeRunToken(presented.value)) {
        const claims = peekRunTokenClaims(presented.value);
        return {
          basis: TACHO_CREDENTIAL_HARNESS_HELD,
          ...(claims !== undefined ? { claims } : {}),
          refusal: {
            code: "credential_unavailable",
            message: CREDENTIAL_MESSAGES.credential_unavailable,
          },
        };
      }
      return { basis: TACHO_CREDENTIAL_HARNESS_HELD };
    }
    if (presented === undefined) {
      return {
        basis: TACHO_CREDENTIAL_GATEWAY_BROKERED,
        refusal: {
          code: "run_token_required",
          message: CREDENTIAL_MESSAGES.run_token_required,
        },
      };
    }
    if (!looksLikeRunToken(presented.value)) {
      return {
        basis: TACHO_CREDENTIAL_GATEWAY_BROKERED,
        refusal: {
          code: "foreign_credential",
          message: CREDENTIAL_MESSAGES.foreign_credential,
        },
      };
    }
    const verdict = broker.verify(presented.value, route.provider);
    if (!verdict.ok) {
      return {
        basis: TACHO_CREDENTIAL_GATEWAY_BROKERED,
        ...(verdict.claims !== undefined ? { claims: verdict.claims } : {}),
        refusal: {
          code: verdict.code,
          message: CREDENTIAL_MESSAGES[verdict.code],
        },
      };
    }
    // Only now is the secret opened: a call that never presented a valid
    // token never causes a decrypt.
    const held = broker.custody(route.provider);
    if (held === undefined) {
      return {
        basis: TACHO_CREDENTIAL_GATEWAY_BROKERED,
        claims: verdict.claims,
        refusal: {
          code: "credential_unavailable",
          message: CREDENTIAL_MESSAGES.credential_unavailable,
        },
      };
    }
    return {
      basis: TACHO_CREDENTIAL_GATEWAY_BROKERED,
      claims: verdict.claims,
      attach: { kind: held.kind, secret: held.secret },
    };
  }

  /**
   * The attrs every frame of a proxied call carries. A call the proxy
   * answered before it resolved the credential has no basis to name.
   */
  function attrsFor(
    route: ModelRoute,
    how: string,
    credential?: ResolvedCredential,
  ): Record<string, string> {
    return {
      [TACHO_ENFORCEMENT_TIER_ATTR]: TACHO_GATEWAY_TIER,
      "oxagen.model_api": route.api,
      "oxagen.correlation": how,
      ...(credential !== undefined
        ? { [TACHO_CREDENTIAL_BASIS_ATTR]: credential.basis }
        : {}),
      // The id names the token on the record; the token itself is never
      // written anywhere, and a refused token's id is read off it unverified.
      ...(credential?.claims !== undefined
        ? { [TACHO_RUN_TOKEN_ATTR]: credential.claims.tid }
        : {}),
    };
  }

  /**
   * The chain a call the proxy did not forward lands on, named from its
   * headers alone, because its body may never have arrived. A correlation
   * that throws leaves the call on the host's own chain, unattributed.
   */
  function attributeByHeaders(
    req: IncomingMessage,
    route: ModelRoute,
  ): NonNullable<CallAttempt["attribution"]> {
    let found: { record?: SessionRecord; how: string };
    try {
      found = correlate(req, route, () => undefined);
    } catch {
      found = { how: "unattributed" };
    }
    return {
      ...(found.record !== undefined ? { record: found.record } : {}),
      recorder: found.record?.recorder ?? deps.hostRecorder(),
      how: found.how,
      attrs: attrsFor(route, found.how),
    };
  }

  /**
   * The chain a frame of this call lands on once its turn on the session's
   * queue comes, with the attrs that turn adds. The session can end while
   * the frame waits there. Its chain is then sealed, or its terminal is on
   * the way to the WAL, so the frame goes to the host's own chain and names
   * the session, as `sealCall` files a call that outlived its session. The
   * record is looked up again, because a task queued ahead of this one can
   * replace it (`SessionRegistry.restore`).
   */
  function landingChain(
    record: SessionRecord | undefined,
    how: string,
  ): { chain: SessionRecorder; attrs: Record<string, string> } {
    if (record === undefined) return { chain: deps.hostRecorder(), attrs: {} };
    const owner = deps.registry.byUuid(record.recorder.sessionUuid);
    if (owner !== undefined && !owner.sealed && owner.pendingTerminal !== true)
      return { chain: owner.recorder, attrs: {} };
    return {
      chain: deps.hostRecorder(),
      attrs: {
        "oxagen.correlation": "session_closed",
        "oxagen.session_correlation": how,
        "oxagen.session_uuid": record.recorder.sessionUuid,
      },
    };
  }

  /**
   * Seal the frame of a call the proxy answered without forwarding it
   * (ADR-256). The frame is an `error` on the chain the call was attributed
   * to, or on the host's own chain when it was attributed to none. Nothing
   * reached the vendor, so it carries no usage and owes no body, and the
   * control plane counts it as an API error, not as a model call.
   *
   * It seals at most once per call, and never for a call `settle` owns. On
   * a session's chain it seals on the session's queue, for the reason
   * `settle` gives, and the answer never waits for it. A frame that cannot
   * be written is rolled back and logged, because this runs where a throw has
   * nothing above it to catch it.
   */
  function sealNotForwarded(
    req: IncomingMessage,
    route: ModelRoute,
    attempt: CallAttempt,
    reason: NotForwardedReason,
    status?: number,
  ): void {
    if (attempt.done) return;
    attempt.done = true;
    // A call on a path the proxy does not meter seals no frame when it is
    // forwarded either.
    if (route.api === "other") return;
    const lost = (error: unknown): void => {
      deps.log(
        `model proxy: sealing the frame of a call it did not forward (${reason}) failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    };
    try {
      const attribution = attempt.attribution ?? attributeByHeaders(req, route);
      const at = deps.now();
      const body: Record<string, unknown> = {
        provider: route.provider,
        ...(attempt.model !== undefined
          ? { model: attempt.model.slice(0, 512) }
          : {}),
        ...(status !== undefined ? { api_status_code: status } : {}),
        api_error_class: reason,
        api_duration_ms: Math.max(0, at - attempt.startedAt),
      };
      const attrs: Record<string, string> = {
        ...attribution.attrs,
        [NOT_FORWARDED_ATTR]: reason,
        "oxagen.provider": route.provider,
        "oxagen.request_bytes_read": String(attempt.bytesRead),
        ...(attempt.request !== undefined
          ? { "oxagen.request_digest": digestBytes(attempt.request) }
          : {}),
      };
      const land = (): void => {
        const landing = landingChain(attribution.record, attribution.how);
        recordOnChain(
          landing.chain,
          (chain) => [
            chain.sealCollectorEvent("error", body, {
              ts: toProtocolTimestamp(at),
              fidelity: "proxy",
              attrs: { ...attrs, ...landing.attrs },
            }),
          ],
          deps.record,
        );
      };
      if (attribution.record === undefined) land();
      else
        void onSessionQueue(deps.exclusive, attribution.record, land).catch(
          lost,
        );
    } catch (error) {
      lost(error);
    }
  }

  function sendProviderError(
    res: ServerResponse,
    route: ModelRoute,
    status: number,
    code: string,
    message: string,
    retryable = false,
  ): void {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const error = providerError(route.provider, status, code, message);
    res.writeHead(error.status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(error.body),
      "x-oxagen-refusal": code,
      // Both vendors' SDKs read this. A refusal must not be retried. A call
      // cut off by the daemon restarting or by a steer should be, and so
      // should a failure on the way to the vendor, a second later: without
      // it a reset connection reached the person as a failed turn.
      "x-should-retry": retryable ? "true" : "false",
      ...(retryable ? { "retry-after": "1" } : {}),
    });
    res.end(error.body);
  }

  function readBody(
    req: IncomingMessage,
    attempt: CallAttempt,
  ): Promise<Buffer | "too_large"> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let over = false;
      req.on("data", (chunk: Buffer) => {
        if (over) return;
        size += chunk.length;
        attempt.bytesRead = size;
        if (size > maxRequestBytes) {
          over = true;
          chunks.length = 0;
          resolve("too_large");
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (!over) resolve(Buffer.concat(chunks));
      });
      req.on("error", reject);
      req.on("aborted", () => reject(new Error("client aborted the request")));
    });
  }

  async function runBeforeForward(
    request: ForwardRequest,
  ): Promise<ForwardRequest> {
    const hook = deps.beforeForward;
    if (hook === undefined) return request;
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<ForwardRequest>((resolve) => {
        timer = setTimeout(() => {
          deps.log(
            `model proxy: beforeForward took over ${hookTimeoutMs}ms, sending the request as it came`,
          );
          resolve(request);
        }, hookTimeoutMs);
      });
      return await Promise.race([Promise.resolve(hook(request)), timeout]);
    } catch (error) {
      deps.log(
        `model proxy: beforeForward failed, sending the request as it came: ${error instanceof Error ? error.message : String(error)}`,
      );
      return request;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Send one cache keep-alive for a waiting parent and seal its frame.
   *
   * The keep-alive answers to the operator's decisions as the parent's own
   * call would: a paused or cancelled session, a host that is not active, a
   * model the workspace refuses, or a budget at its limit sends nothing.
   * What it costs is added to the session's and the day's observed spend, and
   * the frame is an observed `llm_call` like any other, so Spend counts it.
   */
  function sendKeepAlive(
    record: SessionRecord,
    snapshot: KeepAliveSnapshot<KeepAlivePayload>,
    count: number,
    finding: string,
  ): Promise<KeepAliveOutcome> {
    const refusal = refusalFor(record, snapshot.model, false, true);
    if (refusal !== undefined)
      return Promise.resolve({
        sent: false,
        reason: `the proxy would refuse the parent's call (${refusal.code})`,
      });
    const payload = snapshot.payload;
    const target = payload.target;
    const secure = target.protocol === "https:";
    const sessionKey = record.recorder.sessionUuid;
    const startedAt = deps.now();
    return new Promise<KeepAliveOutcome>((resolve) => {
      let done = false;
      let upstream: ClientRequest | undefined;
      // In flight like any call, so a pause, cancel or interrupt, and the
      // daemon stopping, cut it.
      const entry: InFlight = {
        reserved: 0,
        abort: (reason) => upstream?.destroy(new Error(reason)),
      };
      const calls = inFlight.get(sessionKey) ?? new Set<InFlight>();
      calls.add(entry);
      inFlight.set(sessionKey, calls);
      const finish = (outcome: KeepAliveOutcome): void => {
        if (done) return;
        done = true;
        if (
          calls.delete(entry) &&
          calls.size === 0 &&
          inFlight.get(sessionKey) === calls
        )
          inFlight.delete(sessionKey);
        resolve(outcome);
      };
      try {
        upstream = (secure ? httpsRequest : httpRequest)({
          protocol: target.protocol,
          hostname: target.hostname,
          port:
            target.port.length > 0 ? Number(target.port) : secure ? 443 : 80,
          method: "POST",
          path: `${target.pathname}${target.search}`,
          headers: payload.headers,
          agent: secure ? httpsAgent : httpAgent,
        });
      } catch (error) {
        finish({
          sent: false,
          reason: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      const sent = upstream;
      sent.setTimeout(KEEP_ALIVE_TIMEOUT_MS, () => {
        sent.destroy(new Error("the keep-alive timed out"));
      });
      sent.on("error", (error) => {
        finish({
          sent: false,
          reason: `${target.host} failed the keep-alive: ${error.message}`,
        });
      });
      sent.on("response", (response) => {
        const status = response.statusCode ?? 502;
        const firstByteAt = deps.now();
        const chunks: Buffer[] = [];
        const hash = createHash("sha256");
        let bytes = 0;
        let over = false;
        response.on("data", (chunk: Buffer) => {
          if (done) return;
          bytes += chunk.length;
          hash.update(chunk);
          if (over) return;
          if (bytes > KEEP_ALIVE_MAX_RESPONSE_BYTES) {
            over = true;
            chunks.length = 0;
            return;
          }
          chunks.push(chunk);
        });
        const end = (errorClass: string | undefined): void => {
          if (done) return;
          const encoding = response.headers["content-encoding"];
          const text = over
            ? undefined
            : readableBody(
                Buffer.concat(chunks),
                typeof encoding === "string" ? encoding : undefined,
                KEEP_ALIVE_MAX_RESPONSE_BYTES,
              )?.toString("utf8");
          const contentType = response.headers["content-type"];
          const requestId =
            response.headers["request-id"] ??
            response.headers["x-request-id"];
          let readTokens = 0;
          try {
            readTokens = sealKeepAlive(record, snapshot, count, finding, {
              startedAt,
              firstByteAt,
              status,
              errorClass,
              responseText: text,
              responseTooLarge: over,
              responseBytes: bytes,
              responseDigest: `sha256:${hash.digest("hex")}`,
              ...(typeof contentType === "string"
                ? { responseType: contentType.slice(0, 96) }
                : {}),
              ...(typeof requestId === "string"
                ? { requestId: requestId.slice(0, 512) }
                : {}),
            });
          } catch (error) {
            // This runs inside a response listener, where a throw would take
            // the daemon down.
            deps.log(
              `model proxy: a cache keep-alive's answer could not be recorded: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          finish({
            sent: true,
            startedAt,
            ok: status < 300 && errorClass === undefined,
            readTokens,
          });
        };
        response.on("end", () => end(undefined));
        response.on("error", () => end("upstream_reset"));
        response.on("close", () => {
          if (!response.complete) end("upstream_reset");
        });
      });
      sent.end(payload.body);
    });
  }

  /**
   * Seal a keep-alive's `llm_call` frame and count what it cost. Returns the
   * cached tokens the vendor reported reading back.
   */
  function sealKeepAlive(
    record: SessionRecord,
    snapshot: KeepAliveSnapshot<KeepAlivePayload>,
    count: number,
    finding: string,
    answer: {
      startedAt: number;
      firstByteAt: number;
      status: number;
      errorClass: string | undefined;
      responseText: string | undefined;
      responseTooLarge: boolean;
      responseBytes: number;
      responseDigest: string;
      responseType?: string;
      requestId?: string;
    },
  ): number {
    const payload = snapshot.payload;
    const usage: ObservedUsage = {};
    if (answer.responseText !== undefined) {
      try {
        foldUsageDocument(
          usage,
          "anthropic.messages",
          JSON.parse(answer.responseText),
        );
      } catch {
        // An error page or a body that is not JSON carries no usage.
      }
    }
    const model = usage.model ?? snapshot.model;
    const prices = deps.policy().bundle.model_prices;
    const priced = hasTokenCounts(usage)
      ? priceObservedUsage(prices, "anthropic", { ...usage, model })
      : undefined;
    const familyPriced =
      priced !== undefined &&
      resolveModelPriceMatch(prices, "anthropic", model)?.family === true;
    const settledAt = deps.now();
    const sessionKey = record.recorder.sessionUuid;
    if (priced !== undefined) {
      spent.set(sessionKey, spendFor(sessionKey) + priced);
      daySpend.add(utcDay(settledAt), priced);
    }
    callsObserved += 1;
    observed.set(sessionKey, (observed.get(sessionKey) ?? 0) + 1);
    const failed =
      answer.errorClass ??
      (answer.status >= 400 ? `http_${answer.status}` : undefined);
    const callBody: Record<string, unknown> = {
      provider: "anthropic",
      model,
      ...(usage.inputTokens !== undefined
        ? { input_tokens: usage.inputTokens }
        : {}),
      ...(usage.outputTokens !== undefined
        ? { output_tokens: usage.outputTokens }
        : {}),
      ...(usage.cacheReadTokens !== undefined
        ? { cache_read_tokens: usage.cacheReadTokens }
        : {}),
      ...(usage.cacheCreationTokens !== undefined
        ? { cache_creation_tokens: usage.cacheCreationTokens }
        : {}),
      ...(usage.cacheCreation5mTokens !== undefined
        ? { cache_creation_5m_tokens: usage.cacheCreation5mTokens }
        : {}),
      ...(usage.cacheCreation1hTokens !== undefined
        ? { cache_creation_1h_tokens: usage.cacheCreation1hTokens }
        : {}),
      ...(priced !== undefined ? { cost_usd_micros: priced } : {}),
      cost_basis:
        priced !== undefined
          ? familyPriced
            ? "estimated"
            : "observed"
          : hasTokenCounts(usage)
            ? "observed_unpriced"
            : "observed_no_usage",
      ...(usage.stopReason !== undefined
        ? { stop_reason: usage.stopReason }
        : {}),
      ttft_ms: Math.max(0, answer.firstByteAt - answer.startedAt),
      api_duration_ms: Math.max(0, settledAt - answer.startedAt),
      api_status_code: answer.status,
      ...(failed !== undefined || usage.streamError !== undefined
        ? { api_error_class: failed ?? `stream_${usage.streamError}` }
        : {}),
      ...(answer.requestId !== undefined
        ? { request_id: answer.requestId }
        : {}),
      ...(usage.responseId !== undefined
        ? { message_id: usage.responseId }
        : {}),
    };
    // Counted above, as the keep-alive settles. Its frame is sealed on the
    // session's queue, for the reason `settle` gives: a hook there can stand
    // between its seal and its write. The keep-alive reached the vendor, so
    // its outcome stands whether or not the frame is written.
    const land = (): void => {
      // A session that ended while its keep-alive was out, or while this
      // frame waited on its queue, has its frame on the host's own chain, as
      // `sealCall` does for a call. The record is looked up again, because a
      // task queued ahead of this one can replace it.
      const owner = deps.registry.byUuid(record.recorder.sessionUuid);
      const closed =
        owner === undefined || owner.sealed || owner.pendingTerminal === true;
      // The request is stored against the parent's when the parent's frame
      // stored that request: the messages, system prompt and tools are the
      // parent's, so only the changed members ship. On the host's chain it is
      // stored whole. The parent's request is on the session's chain, so a
      // reader of the host's chain could not resolve a fold against it.
      const requestText = payload.body.toString("utf8");
      const memory = new RequestPrefixMemory();
      if (payload.priorShape !== undefined && !closed)
        memory.remember("parent", {
          text: "",
          fullDigest: payload.priorShape.requestDigest,
          fullBytes: 0,
          storedBytes: 0,
          prior: undefined,
          shape: payload.priorShape,
          priorPayload: undefined,
        });
      const fold = memory.fold("parent", requestText);
      let requestContent =
        fold.storedBytes > TACHO_MAX_BODY_BYTES ? undefined : fold.text;
      let responseContent = answer.responseText;
      // The same shared cap `sealCall` holds an exchange to: the response
      // is dropped first, then the request if it alone is still too large.
      if (requestContent !== undefined && responseContent !== undefined) {
        const both = Buffer.byteLength(
          jcs({ request: requestContent, response: responseContent }),
          "utf8",
        );
        if (both > TACHO_MAX_BODY_BYTES) {
          responseContent = undefined;
          const alone = Buffer.byteLength(
            jcs({ request: requestContent, response: undefined }),
            "utf8",
          );
          if (alone > TACHO_MAX_BODY_BYTES) requestContent = undefined;
        }
      }
      const responseOmitted = answer.responseTooLarge
        ? "too_large"
        : answer.responseText === undefined && answer.responseBytes > 0
          ? "not_decoded"
          : responseContent === undefined && answer.responseText !== undefined
            ? "too_large"
            : undefined;
      const exchange = exchangeContent(requestContent, responseContent);
      // As in `settle`: a write that fails takes the frame's seq back with it.
      recordOnChain(
        owner !== undefined && !closed ? owner.recorder : deps.hostRecorder(),
        (chain) => [
          chain.sealCollectorEvent("llm_call", callBody, {
            ts: toProtocolTimestamp(settledAt),
            fidelity: "proxy",
            ...(exchange !== undefined ? { content: exchange } : {}),
            attrs: {
              [TACHO_ENFORCEMENT_TIER_ATTR]: TACHO_GATEWAY_TIER,
              "oxagen.model_api": "anthropic.messages",
              "oxagen.correlation": "cache_keep_alive",
              ...(closed
                ? { "oxagen.session_uuid": record.recorder.sessionUuid }
                : {}),
              [TACHO_CREDENTIAL_BASIS_ATTR]: payload.basis,
              ...(payload.runTokenId !== undefined
                ? { [TACHO_RUN_TOKEN_ATTR]: payload.runTokenId }
                : {}),
              [TACHO_METERING_ATTR]: TACHO_METERING_OBSERVED,
              [KEEP_ALIVE_ATTR]: "1",
              [KEEP_ALIVE_FINDING_ATTR]: finding,
              [KEEP_ALIVE_COUNT_ATTR]: String(count),
              [KEEP_ALIVE_TTL_ATTR]: snapshot.ttl,
              "oxagen.request_digest": digestBytes(payload.body),
              "oxagen.request_bytes": String(payload.body.length),
              "oxagen.request_full_digest": fold.fullDigest,
              "oxagen.request_full_bytes": String(fold.fullBytes),
              "oxagen.request_stored_bytes": String(fold.storedBytes),
              ...(fold.prior !== undefined
                ? {
                    "oxagen.request_prior_digest": fold.prior.unchanged_from,
                    "oxagen.request_prior_messages": String(
                      fold.prior.messages,
                    ),
                    "oxagen.request_prior_fields": fold.prior.fields.join(","),
                  }
                : {}),
              ...(requestContent === undefined
                ? { [REQUEST_BODY_OMITTED_ATTR]: "too_large" }
                : {}),
              ...(responseOmitted !== undefined
                ? { [RESPONSE_BODY_OMITTED_ATTR]: responseOmitted }
                : {}),
              "oxagen.response_digest": answer.responseDigest,
              "oxagen.response_bytes": String(answer.responseBytes),
              "oxagen.stream": "0",
              "oxagen.upstream_host": payload.target.host,
              ...(answer.responseType !== undefined
                ? { "oxagen.response_content_type": answer.responseType }
                : {}),
            },
          }),
        ],
        deps.record,
      );
    };
    void onSessionQueue(deps.exclusive, record, land).catch(
      (error: unknown) => {
        deps.log(
          `model proxy: sealing a cache keep-alive's frame failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    );
    return usage.cacheReadTokens ?? 0;
  }

  async function forward(
    req: IncomingMessage,
    res: ServerResponse,
    route: ModelRoute,
    admitted: { release?: () => void },
    attempt: CallAttempt,
  ): Promise<void> {
    const startedAt = deps.now();
    let received: Buffer | "too_large";
    try {
      received = await readBody(req, attempt);
    } catch (error) {
      // The harness left, or its connection broke, before the whole request
      // arrived. Nothing can be forwarded, and the call still gets a frame.
      sealNotForwarded(req, route, attempt, "client_aborted");
      throw error;
    }
    if (received === "too_large") {
      sealNotForwarded(req, route, attempt, "request_too_large", 413);
      sendProviderError(
        res,
        route,
        413,
        "request_too_large",
        `The request body is larger than the ${maxRequestBytes} bytes the Oxagen gateway holds for one call.`,
      );
      return;
    }
    let body = received;
    attempt.request = received;
    const encoding = header(req, "content-encoding");
    let decoded: Buffer | undefined | null = null;
    const readable = (): Buffer | undefined => {
      if (decoded === null)
        decoded = readableBody(body, encoding, maxRequestBytes);
      return decoded;
    };
    let parsed: Record<string, unknown> | undefined | null = null;
    const json = (): Record<string, unknown> | undefined => {
      if (parsed === null) parsed = parseJsonObject(readable());
      return parsed;
    };

    const { record, how } = correlate(req, route, json);
    const recorder = record?.recorder ?? deps.hostRecorder();
    const sessionKey = record?.recorder.sessionUuid ?? HOST_KEY;
    const credential = resolveCredential(req, route);
    const attrs = attrsFor(route, how, credential);
    attempt.attribution = {
      ...(record !== undefined ? { record } : {}),
      recorder,
      how,
      attrs,
    };
    const metered = route.api !== "other";

    // The model the harness asked for, read before the refusal decision so the
    // `models` clause has a string to check. It used to be read after
    // `refusalFor` had already returned, which is why an allowlist bolted onto
    // the old shape would have refused nothing.
    const { model: askedModel, ambiguous: modelAmbiguous } = modelOf(
      readable,
      json,
    );
    if (askedModel !== undefined) attempt.model = askedModel;

    // The operator's decisions come first: a paused session is told it is
    // paused whatever it presented. Then the credential seam's, which are the
    // host's own configuration and so read as `bundle` on the frame.
    const refusal =
      refusalFor(record, askedModel, modelAmbiguous, metered) ??
      (credential.refusal !== undefined
        ? {
            ...credential.refusal,
            source: "bundle" as const,
            status: credentialRefusalStatus(credential.refusal.code),
          }
        : undefined);
    if (refusal !== undefined) {
      refused += 1;
      const view = deps.policy();
      const decision: Record<string, unknown> = {
        policy_decision: "deny",
        policy_source: refusal.source,
        policy_reason_code: refusal.code,
        policy_reason_digest: digestText(refusal.message),
        bundle_version: view.bundle.version,
        bundle_mode: view.bundle.mode,
      };
      const decisionAttrs: Record<string, string> = {
        ...attrs,
        "oxagen.refused": "model_call",
        "oxagen.provider": route.provider,
        "oxagen.request_digest": digestBytes(body),
        // The model the refusal was about, when the proxy could read one. A
        // `model_not_permitted` frame that does not name the model leaves the
        // operator guessing which entry to add.
        ...(askedModel !== undefined
          ? { "oxagen.model": askedModel.slice(0, 512) }
          : {}),
        ...(modelAmbiguous ? { "oxagen.model_ambiguous": "true" } : {}),
        ...(record !== undefined
          ? {
              "oxagen.session_spend_usd_micros": String(spendFor(sessionKey)),
            }
          : {}),
        ...("attrs" in refusal ? refusal.attrs : {}),
      };
      // A write that fails takes the frame's seq back with it, for the reason
      // `settle` gives, and the caller answers this call 502.
      const land = (): void => {
        const landing = landingChain(record, how);
        recordOnChain(
          landing.chain,
          (chain) => [
            chain.sealCollectorEvent("policy_decision", decision, {
              fidelity: "proxy",
              attrs: { ...decisionAttrs, ...landing.attrs },
            }),
          ],
          deps.record,
        );
      };
      if (record === undefined) land();
      else {
        // On the session's queue, for the reason `settle` gives. The refusal
        // waits for its frame there, so a frame that cannot be written is
        // still answered 502. A queue held past `refusalWaitMs` does not hold
        // the call: the refusal is answered, and the frame lands, or is
        // logged as lost, when the queue frees.
        let answered = false;
        const written = onSessionQueue(deps.exclusive, record, land);
        void written.catch((error: unknown) => {
          if (answered)
            deps.log(
              `model proxy: the frame of a refusal already answered was not written: ${error instanceof Error ? error.message : String(error)}`,
            );
        });
        if (!(await landedWithin(written, refusalWaitMs))) {
          answered = true;
          deps.log(
            `model proxy: answered a refused call before its frame could land: session ${record.harnessSessionId}'s queue was busy for ${refusalWaitMs} ms`,
          );
        }
      }
      // The refusal is the call's frame.
      attempt.done = true;
      deps.log(
        `model proxy: refused ${route.provider} ${route.api} (${refusal.code})`,
      );
      sendProviderError(
        res,
        route,
        "status" in refusal ? refusal.status : 403,
        refusal.code,
        refusal.message,
      );
      return;
    }

    // The call is in flight from the moment it is admitted: a pause, cancel
    // or interrupt that lands while `beforeForward` runs finds it and stops
    // it before anything is sent, and the ceiling it holds counts against the
    // budget of every call admitted after it.
    const requestTextBytes = readable()?.length ?? body.length;
    let abortReason: string | undefined;
    let upstreamReq: ClientRequest | undefined;
    const entry: InFlight = {
      reserved: metered
        ? ceilingFor(
            route,
            askedModel,
            requestTextBytes,
            json(),
            record !== undefined,
          )
        : 0,
      abort: (reason, retry) => {
        abortReason = reason;
        upstreamReq?.destroy(new Error(reason));
        if (!res.headersSent) {
          // A 403 reads to Claude Code as a failed login and tells the person
          // to run /login, which is wrong for a daemon restart. That case gets
          // a 503 the harness retries once the service is back.
          if (retry === "steer")
            sendProviderError(
              res,
              route,
              503,
              "steered_by_operator",
              `The session's Oxagen operator sent a steer during this model call: ${reason}. Retry the call.`,
              true,
            );
          else if (retry === "daemon_stopping")
            sendProviderError(
              res,
              route,
              503,
              "daemon_stopping",
              `The Oxagen daemon restarted during this model call: ${reason}. Retry the call.`,
              true,
            );
          else
            sendProviderError(
              res,
              route,
              403,
              "interrupted_by_operator",
              `This model call was interrupted by the session's Oxagen operator: ${reason}`,
            );
        } else {
          res.destroy();
        }
      },
    };
    const set = inFlight.get(sessionKey) ?? new Set<InFlight>();
    set.add(entry);
    inFlight.set(sessionKey, set);
    // `settle` takes the entry off. This is for a throw before there is a
    // request to settle, so the call does not hold its ceiling forever.
    admitted.release = () => {
      if (
        set.delete(entry) &&
        set.size === 0 &&
        inFlight.get(sessionKey) === set
      )
        inFlight.delete(sessionKey);
    };

    let injected = false;
    // The body `beforeForward` sent in place of the harness's, when it
    // changed it. It is the request the vendor reads, so the effort is read
    // from it (#3891), and the window counts what it added as steering
    // (ADR-200).
    let injectedJson: Record<string, unknown> | undefined;
    let dropContentEncoding = false;
    let path = route.path;
    if (deps.beforeForward !== undefined) {
      const original = json();
      const offered: ForwardRequest = {
        provider: route.provider,
        api: route.api,
        method: req.method ?? "GET",
        path,
        ...(original !== undefined ? { json: original } : {}),
        ...(record !== undefined
          ? {
              session: {
                harnessSessionId: record.harnessSessionId,
                sessionUuid: record.recorder.sessionUuid,
              },
            }
          : {}),
      };
      const result = await runBeforeForward(offered);
      if (result.json !== undefined && result.json !== original) {
        body = Buffer.from(JSON.stringify(result.json), "utf8");
        // The changed body is sent as plain JSON, whatever the caller used.
        dropContentEncoding = true;
        injected = true;
        injectedJson = result.json;
      }
      if (result.path !== path && result.path.startsWith("/"))
        path = result.path;
    }

    // The same read the mandate was answered against. `readable` and `json`
    // memoize the body as it arrived, so this was never the injected model
    // even before the read moved above `refusalFor` — the two sites always
    // agreed, and now they cannot drift apart.
    const requestModel = askedModel;
    // The effort setting the request carried (#3891), read now: the parsed
    // body is released below and the frame seals after the response.
    const requestEffort = requestEffortOf(injected ? injectedJson : json());
    // The request half of the exchange, decoded: the bytes the vendor is about
    // to read, not the gzip or zstd the harness wrapped them in, and the
    // injected body when `beforeForward` changed one, because the request that
    // was made is the request a fork has to replay.
    const sent = injected ? body : readable();
    // The body stores the request with the prefix the session's last landed
    // call already holds cut out. The fold changes no memory: this call
    // becomes the prior only once its own frame lands (`settle`), so a call
    // that overlaps it never points at it. Folding runs on the full decoded
    // text, whatever its size. A request over the cap usually folds down to
    // the few messages that are new. Checking the raw bytes here, before the
    // fold could make that saving, used to throw it away and ship no request
    // half at all for a call whose folded delta would have been a few KB.
    // Only `fold.text`, what would actually be stored, is checked against
    // the cap, below.
    const requestText = sent !== undefined ? sent.toString("utf8") : undefined;
    const fold =
      requestText === undefined
        ? undefined
        : priors.fold(sessionKey, requestText);
    const requestTooLarge =
      fold !== undefined && fold.storedBytes > TACHO_MAX_BODY_BYTES;
    // What the vendor is about to read, block by block, kept as numbers only
    // (ADR-200). The attribute rides the envelope, so it survives a
    // `digest_only` workspace that keeps none of these bytes.
    const requestWindow = metered
      ? measureProviderRequest(
          route.api,
          injectedJson ?? json(),
          injectedJson === undefined ? undefined : json(),
        )
      : null;
    // The keep-alive this call would leave behind, built now because the
    // parsed body is released below: the request the vendor reads, so the
    // injected one when `beforeForward` changed it. Only for a governed
    // Anthropic call of a session, while the bundle turns the keep-alive on.
    // While a subagent is open, a call outside the parent's conversation is
    // the subagent's, so its body is never built.
    const keepAliveCandidate = ((): ReturnType<typeof keepAliveCandidateOf> => {
      if (
        !metered ||
        route.api !== "anthropic.messages" ||
        record === undefined ||
        requestModel === undefined ||
        !keepAlive.enabled()
      )
        return undefined;
      const request = injectedJson ?? json();
      if (request === undefined) return undefined;
      const conversation = conversationOf(request, requestModel);
      if (
        record.recorder.openChildren.size > 0 &&
        keepAlive.conversationFor(sessionKey) !== conversation
      )
        return undefined;
      return keepAliveCandidateOf(request, conversation);
    })();
    // Nothing else of the request is kept past this point but its bytes to send.
    decoded = undefined;
    parsed = undefined;

    const target = upstreamUrlFor(
      { ...route, path },
      (deps.upstreams ?? (() => DEFAULT_MODEL_UPSTREAMS))(),
    );
    const secure = target.protocol === "https:";
    const requestDigest = digestBytes(body);
    const requestBytes = body.length;

    let settled = false;
    let retried = false;
    let firstByteAt: number | undefined;
    let status: number | undefined;
    let requestId: string | undefined;
    let responseType: string | undefined;
    let responseBytes = 0;
    const responseHash = createHash("sha256");
    const responseBody = new BodyCapture();
    let meter: UsageMeter | undefined;
    // The usage the vendor reported in full, for the keep-alive; undefined
    // for a call cut short, whose count is an estimate.
    let settledUsage: ObservedUsage | undefined;

    const headers = upstreamRequestHeaders(
      req.rawHeaders,
      target.host,
      body.length,
      dropContentEncoding,
      credential.attach,
    );
    const settle = (errorClass: string | undefined): void => {
      if (settled) return;
      settled = true;
      // This seals the call's frame, so the request handler must not.
      attempt.done = true;
      set.delete(entry);
      if (set.size === 0) inFlight.delete(sessionKey);
      // Counted now, as the call leaves the in-flight set, so a call admitted
      // next reads what this one spent. Only the frame waits below.
      let metering: CallMetering | undefined;
      try {
        metering = meterCall(errorClass);
      } catch (error) {
        logLostFrame(error);
        return;
      }
      // No frame seals for a call the proxy does not meter, so nothing holds
      // its request and no later call may point at it.
      if (metering === undefined) return;
      const counted = metering;
      const land = (): void => {
        let landed = false;
        try {
          landed = sealCall(counted);
        } catch (error) {
          logLostFrame(error);
        }
        afterLanding(landed, errorClass);
      };
      // A session's chain is written on its queue, where its hooks run. A
      // hook can stand between its seal and its write: a prompt waits up to
      // 500 ms on its recalled memories. Sealed beside it, this frame took
      // the seq after the hook's frame and reached the WAL first. The hook's
      // write was then refused, its rollback left the chain behind the WAL,
      // and the session recorded nothing more. The response is already
      // piped, so the caller never waits on the queue. A call no session was
      // found for goes on the daemon's own chain, which has no queue.
      if (record === undefined) land();
      else
        void onSessionQueue(deps.exclusive, record, land).catch(
          (error: unknown) => logLostFrame(error),
        );
    };

    /**
     * Log a call's frame that could not be sealed or written. This runs
     * inside response, error and close event listeners, or on a session's
     * queue, with nothing above it to catch a throw. Node treats an uncaught
     * exception thrown from a listener as fatal, which would take the whole
     * daemon down mid-call over one frame. The response already sent, or
     * already decided, is unaffected. Only this call's own frame is lost,
     * with its body, and that is logged rather than silent. This call was
     * never remembered, so no later call points at the body it lost.
     */
    const logLostFrame = (error: unknown): void => {
      deps.log(
        `model proxy: sealing the call's frame failed, the response the caller already has is unaffected: ${error instanceof Error ? error.message : String(error)}`,
      );
    };

    /** What the call's frame changes once it is on the WAL, or is not. */
    const afterLanding = (
      landed: boolean,
      errorClass: string | undefined,
    ): void => {
      // The call's frame, with its request stored as `fold.text`, is on the
      // WAL. Only now does the call become the session's prior (#4348), and
      // its system context goes beside it: sealing the frame measured it, so
      // the shared memory holds it under the digest the next fold will name.
      // The prefix memory keeps it until the session is evicted, whatever
      // the shared memory evicts first (#4508).
      if (landed && fold !== undefined)
        priors.remember(
          sessionKey,
          fold,
          SHARED_SYSTEM_CONTEXT_MEMORY.get(fold.fullDigest),
        );
      // A call that landed whole with a cached prefix may become the request
      // the keep-alive repeats. The module decides whether it is the parent's.
      if (
        keepAliveCandidate !== undefined &&
        record !== undefined &&
        requestModel !== undefined &&
        settledUsage !== undefined &&
        errorClass === undefined &&
        status !== undefined &&
        status < 300
      ) {
        try {
          keepAlive.observe(sessionKey, record, {
            conversation: keepAliveCandidate.conversation,
            model: requestModel,
            startedAt,
            usage: settledUsage,
            payload: {
              body: keepAliveCandidate.body,
              headers: upstreamRequestHeaders(
                req.rawHeaders,
                target.host,
                keepAliveCandidate.body.length,
                true,
                credential.attach,
              ),
              target,
              basis: credential.basis,
              ...(credential.claims !== undefined
                ? { runTokenId: credential.claims.tid }
                : {}),
              ...(landed && fold?.shape !== undefined
                ? { priorShape: fold.shape }
                : {}),
            },
          });
        } catch (error) {
          // Like the seal above, this runs where nothing above it catches a
          // throw, and one would take the daemon down. The call is unaffected.
          deps.log(
            `model proxy: the cache keep-alive could not take this call: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    };

    /**
     * Count what a metered call spent, as it settles. Undefined for a call
     * the proxy does not meter.
     */
    const meterCall = (
      errorClass: string | undefined,
    ): CallMetering | undefined => {
      if (!metered) return undefined;
      const usage: ObservedUsage = meter?.end() ?? {};
      const model = usage.model ?? requestModel;
      // A stream that stopped before the vendor's closing count (the caller
      // left, the operator cut it, the connection reset) still spent what it
      // carried. Its count is completed by estimate, and the frame says so,
      // rather than billing the budget the one token a stream opens with.
      const cut = meter?.cutShort === true;
      if (cut)
        Object.assign(
          usage,
          estimateCutUsage(usage, meter?.contentBytes ?? 0, requestTextBytes),
        );
      else settledUsage = usage;
      const prices = deps.policy().bundle.model_prices;
      const priced = hasTokenCounts(usage)
        ? priceObservedUsage(prices, route.provider, {
            ...usage,
            ...(model !== undefined ? { model } : {}),
          })
        : undefined;
      // Priced by a family row alone: the figure is the family's, not the model's.
      const familyPriced =
        priced !== undefined &&
        resolveModelPriceMatch(prices, route.provider, model)?.family === true;
      // One clock read stamps the frame and picks the day it is charged to,
      // so the record and the day budget cannot disagree about a call that
      // settles on a UTC midnight (ADR-160).
      const settledAt = deps.now();
      if (priced !== undefined && record !== undefined)
        spent.set(sessionKey, spendFor(sessionKey) + priced);
      if (priced !== undefined) daySpend.add(utcDay(settledAt), priced);
      callsObserved += 1;
      observed.set(sessionKey, (observed.get(sessionKey) ?? 0) + 1);
      return {
        usage,
        model,
        cut,
        priced,
        familyPriced,
        settledAt,
        durationMs: Math.max(0, deps.now() - startedAt),
        failed:
          errorClass ??
          (status !== undefined && status >= 400
            ? `http_${status}`
            : undefined),
      };
    };

    /**
     * Seal the call's frame and write it to the WAL. Returns true when the
     * frame stored this call's request as `fold.text`, so a later call may
     * cut against it.
     */
    const sealCall = ({
      usage,
      model,
      cut,
      priced,
      familyPriced,
      settledAt,
      durationMs,
      failed,
    }: CallMetering): boolean => {
      const responseText = responseBody.text();
      // The exchange ships at most `TACHO_MAX_BODY_BYTES`, request and
      // response together: `prepareContent` (evidence/frame-body.ts) holds no
      // body at all past that cap, so two halves that separately fit but do
      // not together would otherwise cost the call both of them, when the
      // request alone — usually the smaller half, already folded down to
      // what changed — would have replayed fine on its own. The response is
      // dropped first.
      // The session can end while its call is still streaming, or while
      // this frame waits on its queue. Its chain is then sealed, or its
      // terminal is on the way to the WAL, and a frame sealed there would
      // follow its `agent_stop`. The call goes to the host's own chain
      // instead, as one that starts after the session ended does
      // (`session_closed`, C-04). The request is stored whole there: a fold
      // points at the session's previous body, which sits on another chain.
      // The session's next call, after a resume, folds against nothing
      // rather than against a body stored on the host's chain. The record is
      // looked up again here, because a task queued ahead of this one can
      // replace it (`SessionRegistry.restore`), and the recorder it held then
      // writes past the chain the new one holds.
      const owner =
        record === undefined
          ? undefined
          : deps.registry.byUuid(record.recorder.sessionUuid);
      const closed =
        record !== undefined &&
        (owner === undefined ||
          owner.sealed ||
          owner.pendingTerminal === true);
      const unfolded = closed && fold !== undefined;
      if (unfolded) priors.forget(sessionKey);
      let requestContentText = unfolded
        ? fold.fullBytes > TACHO_MAX_BODY_BYTES
          ? undefined
          : requestText
        : requestTooLarge
          ? undefined
          : fold?.text;
      let responseContentText = responseText;
      if (
        requestContentText !== undefined &&
        responseContentText !== undefined
      ) {
        const combinedBytes = Buffer.byteLength(
          jcs({ request: requestContentText, response: responseContentText }),
          "utf8",
        );
        if (combinedBytes > TACHO_MAX_BODY_BYTES) {
          responseContentText = undefined;
          const requestOnlyBytes = Buffer.byteLength(
            jcs({ request: requestContentText, response: undefined }),
            "utf8",
          );
          if (requestOnlyBytes > TACHO_MAX_BODY_BYTES)
            requestContentText = undefined;
        }
      }
      // Whether this frame stores the folded request. Only then may a later
      // call cut against this one (`afterLanding` remembers it once the frame
      // is on the WAL). A request cut for size here, alone or only once paired
      // with the response, is stored nowhere, so this call is never
      // remembered and the next call folds against the last one that did
      // ship, or stores its request whole. It never points at a body nobody
      // stored.
      const shipsFold =
        fold !== undefined && !unfolded && requestContentText !== undefined;
      // The frame about to seal resolves the part it cut from the context of
      // the call it cut against. The fold took that context from the prefix
      // memory when the call was forwarded. Putting it back in the shared
      // memory now means the resolve never depends on what that memory
      // evicted while this call streamed (#4508).
      if (shipsFold) SHARED_SYSTEM_CONTEXT_MEMORY.restorePrior(fold);
      // Bytes came back and none of them are here, so either the encoding the
      // vendor chose is one this build has no decoder for, or the exchange
      // pushed the shared cap over and this half was the one dropped to keep
      // the other. Both read the same to a reader: nothing to show, and why.
      const responseOmitted = responseBody.tooLarge
        ? "too_large"
        : responseText === undefined && responseBytes > 0
          ? "not_decoded"
          : responseContentText === undefined && responseText !== undefined
            ? "too_large"
            : undefined;
      const exchange = exchangeContent(requestContentText, responseContentText);
      // Chosen before the mark `recordOnChain` takes, so a write that fails
      // takes back the chain the frame was sealed on.
      const chain =
        owner !== undefined && !closed
          ? owner.recorder
          : closed
            ? deps.hostRecorder()
            : recorder;
      const callBody: Record<string, unknown> = {
        provider: route.provider,
        ...(model !== undefined ? { model } : {}),
        ...(usage.inputTokens !== undefined
          ? { input_tokens: usage.inputTokens }
          : {}),
        ...(usage.outputTokens !== undefined
          ? { output_tokens: usage.outputTokens }
          : {}),
        ...(usage.cacheReadTokens !== undefined
          ? { cache_read_tokens: usage.cacheReadTokens }
          : {}),
        ...(usage.cacheCreationTokens !== undefined
          ? { cache_creation_tokens: usage.cacheCreationTokens }
          : {}),
        ...(usage.cacheCreation5mTokens !== undefined
          ? { cache_creation_5m_tokens: usage.cacheCreation5mTokens }
          : {}),
        ...(usage.cacheCreation1hTokens !== undefined
          ? { cache_creation_1h_tokens: usage.cacheCreation1hTokens }
          : {}),
        ...(usage.thinkingTokens !== undefined
          ? { thinking_tokens: usage.thinkingTokens }
          : {}),
        ...(priced !== undefined ? { cost_usd_micros: priced } : {}),
        cost_basis:
          priced !== undefined
            ? cut || familyPriced
              ? "estimated"
              : "observed"
            : hasTokenCounts(usage)
              ? "observed_unpriced"
              : "observed_no_usage",
        ...(usage.serviceTier !== undefined
          ? { service_tier: usage.serviceTier }
          : {}),
        ...(usage.stopReason !== undefined
          ? { stop_reason: usage.stopReason }
          : {}),
        ...(requestEffort !== undefined
          ? { request_effort: requestEffort }
          : {}),
        ...(firstByteAt !== undefined
          ? { ttft_ms: Math.max(0, firstByteAt - startedAt) }
          : {}),
        api_duration_ms: durationMs,
        ...(status !== undefined ? { api_status_code: status } : {}),
        ...(failed !== undefined || usage.streamError !== undefined
          ? { api_error_class: failed ?? `stream_${usage.streamError}` }
          : {}),
        ...(requestId !== undefined ? { request_id: requestId } : {}),
        ...(usage.responseId !== undefined
          ? { message_id: usage.responseId }
          : {}),
      };
      // Judged against the session's ledger too, so the session's own record
      // of this call, arriving later, is stamped a duplicate of this frame.
      const sessionSighting =
        closed && record !== undefined
          ? (owner ?? record).recorder.judgeModelCallSealedElsewhere(callBody)
          : undefined;
      recordOnChain(
        chain,
        (sealing) => [
          sealing.sealCollectorEvent("llm_call", callBody, {
            ts: toProtocolTimestamp(settledAt),
            fidelity: "proxy",
            // The recorder redacts these bytes, digests what is left and puts
            // that digest on the frame as `content.digest`, overriding any the
            // caller supplies. So `content.digest` is the one a reader
            // verifies the body against, and the proxy does not compute it:
            // the proxy has not redacted, and a digest of the bytes before
            // redaction would name a body that never ships. The two wire
            // digests below are a different claim and keep their meaning, that
            // these exact bytes crossed the wire to this vendor.
            ...(exchange !== undefined ? { content: exchange } : {}),
            attrs: {
              ...attrs,
              // The frame names the session it belongs to, and how the
              // proxy matched the call to it.
              ...(closed
                ? {
                    "oxagen.correlation": "session_closed",
                    "oxagen.session_correlation": how,
                    "oxagen.session_uuid": recorder.sessionUuid,
                  }
                : {}),
              ...sessionSighting?.attrs,
              [TACHO_METERING_ATTR]: TACHO_METERING_OBSERVED,
              "oxagen.request_digest": requestDigest,
              "oxagen.request_bytes": String(requestBytes),
              ...(requestWindow !== null
                ? { [CONTEXT_WINDOW_ATTR]: encodeWindowAttr(requestWindow) }
                : {}),
              "oxagen.response_digest": `sha256:${responseHash.digest("hex")}`,
              "oxagen.response_bytes": String(responseBytes),
              "oxagen.stream": meter?.isStreaming === true ? "1" : "0",
              "oxagen.upstream_host": target.host,
              ...(responseType !== undefined
                ? { "oxagen.response_content_type": responseType }
                : {}),
              ...(injected ? { "oxagen.request_injected": "1" } : {}),
              // The body named more than one model and no `models` clause
              // refused it, so `model` above may be a duplicate the vendor
              // never ran. The frame says so rather than reading as pinned.
              ...(modelAmbiguous ? { "oxagen.model_ambiguous": "true" } : {}),
              // A half left out of the body. The seal reads these two attrs
              // (`bodyIsPartial`), so a call with half a body grades as one
              // missing its body rather than as a whole capture.
              ...(fold !== undefined && requestContentText === undefined
                ? { [REQUEST_BODY_OMITTED_ATTR]: "too_large" }
                : fold === undefined && sent === undefined && body.length > 0
                  ? { [REQUEST_BODY_OMITTED_ATTR]: "not_decoded" }
                  : {}),
              ...(fold !== undefined
                ? {
                    "oxagen.request_full_digest": fold.fullDigest,
                    "oxagen.request_full_bytes": String(fold.fullBytes),
                    "oxagen.request_stored_bytes": String(
                      unfolded ? fold.fullBytes : fold.storedBytes,
                    ),
                  }
                : {}),
              ...(fold?.prior !== undefined && !unfolded
                ? {
                    "oxagen.request_prior_digest": fold.prior.unchanged_from,
                    "oxagen.request_prior_messages": String(
                      fold.prior.messages,
                    ),
                    "oxagen.request_prior_fields": fold.prior.fields.join(","),
                  }
                : {}),
              ...(responseOmitted !== undefined
                ? { [RESPONSE_BODY_OMITTED_ATTR]: responseOmitted }
                : {}),
              ...(abortReason !== undefined
                ? { "oxagen.interrupted": "1" }
                : {}),
              ...(cut ? { "oxagen.usage_partial": "1" } : {}),
            },
          }),
        ],
        deps.record,
      );
      sessionSighting?.commit();
      return shipsFold;
    };

    // The caller went away: stop paying for tokens nobody will read.
    res.on("close", () => {
      if (settled || res.writableFinished) return;
      upstreamReq?.destroy(new Error("client closed the connection"));
      settle(abortReason !== undefined ? "interrupted" : "client_aborted");
    });

    const onResponse = (upstream: IncomingMessage): void => {
      status = upstream.statusCode ?? 502;
      firstByteAt = deps.now();
      const idHeader =
        upstream.headers["request-id"] ?? upstream.headers["x-request-id"];
      requestId =
        typeof idHeader === "string" ? idHeader.slice(0, 512) : undefined;
      const contentType = upstream.headers["content-type"];
      const contentEncodingName = upstream.headers["content-encoding"];
      responseType = `${typeof contentType === "string" ? contentType.slice(0, 96) : "none"}${
        typeof contentEncodingName === "string"
          ? ` (${contentEncodingName.slice(0, 32)})`
          : ""
      }`;
      meter = new UsageMeter(
        metered && status < 400 ? route.api : "other",
        typeof contentType === "string" ? contentType : undefined,
      );
      const contentEncoding = upstream.headers["content-encoding"];
      const decoder = decoderFor(
        typeof contentEncoding === "string" ? contentEncoding : undefined,
      );
      let decoderFailed = false;
      decoder?.on("data", (chunk: Buffer) => {
        // The meter ended at settle; see the upstream `data` listener below.
        if (settled) return;
        meter?.write(chunk);
        responseBody.write(chunk);
      });
      decoder?.on("error", () => {
        // A body this build's decoder cannot read. zlib does not follow this
        // with an `end`, so nothing downstream should keep waiting for one;
        // `decoderFailed` tells the `end` handler below to settle without it.
        decoderFailed = true;
      });
      const compressed =
        typeof contentEncoding === "string" &&
        contentEncoding.toLowerCase() !== "identity";

      res.writeHead(
        status,
        upstream.statusMessage ?? "",
        downstreamResponseHeaders(upstream.rawHeaders),
      );
      res.flushHeaders();
      res.socket?.setNoDelay(true);

      upstream.on("data", (chunk: Buffer) => {
        // A call can settle while the response still has a chunk buffered:
        // the caller closed, the operator interrupted, or the upstream
        // failed, and the stream's own `resume` delivers one more chunk on
        // the next tick. `settle` has already sealed the frame and finalized
        // `responseHash`, so hashing that chunk throws
        // ERR_CRYPTO_HASH_FINALIZED from this listener, and Node exits on
        // an uncaught throw from a listener (#4107). The frame's digest and
        // byte count describe the bytes seen up to settle; a later chunk
        // belongs to no frame. `pipe` reads the chunk on its own listener.
        if (settled) return;
        responseBytes += chunk.length;
        responseHash.update(chunk);
        if (decoder !== undefined) decoder.write(chunk);
        else if (!compressed) {
          meter?.write(chunk);
          responseBody.write(chunk);
        }
      });
      // Sealing runs after the response has been handed to `res` via `pipe`
      // below, not before it: a WAL append is synchronous work the caller's
      // connection should never wait on. `process.nextTick` is the smallest
      // deferral that still guarantees that ordering — this listener is
      // registered before `upstream.pipe(res)`, so both run synchronously
      // inside the same `end` emission, in registration order; queuing the
      // seal for the next tick lets pipe's own `end` handler (which calls
      // `res.end()`) run first within that same emission, while everything
      // that reads a sealed frame straight back off `call()` still sees it,
      // because nothing here waits on I/O the way `setImmediate` would.
      const settleDeferred = (errorClass: string | undefined): void =>
        process.nextTick(() => settle(errorClass));
      upstream.on("end", () => {
        if (decoder === undefined || decoderFailed) {
          // No decoder ran, or it failed and will not emit `end` or another
          // `error` of its own (zlib leaves the stream unusable after one):
          // either way nothing more is coming, so settle now rather than
          // wait on an event that was never going to arrive and leak the
          // in-flight entry (P1-3).
          settleDeferred(undefined);
          return;
        }
        decoder.once("end", () => settleDeferred(undefined));
        decoder.once("error", () => settleDeferred(undefined));
        try {
          decoder.end();
        } catch {
          settleDeferred(undefined);
        }
      });
      // Node emits both aborted and error when a response is destroyed, even
      // when this proxy destroyed it because the caller left. Classify and
      // report the first failure only, preserving an already recorded cause.
      const failResponse = (error?: Error): void => {
        if (settled) return;
        if (abortReason === undefined) {
          deps.log(
            `model proxy: upstream ${target.host} failed mid-response: ${error?.message ?? "aborted"}`,
          );
        }
        settle(abortReason !== undefined ? "interrupted" : "upstream_reset");
        res.destroy();
      };
      upstream.on("error", failResponse);
      upstream.on("aborted", () => {
        failResponse();
      });
      // `pipe` carries the backpressure: a slow reader pauses the vendor's
      // stream instead of growing a buffer here.
      upstream.pipe(res);
    };

    const onError = (
      failed: ClientRequest,
      error: NodeJS.ErrnoException,
    ): void => {
      if (settled || failed !== upstreamReq) return;
      if (abortReason !== undefined) {
        settle("interrupted");
        return;
      }
      // A pooled connection the vendor closed while it idled fails the next
      // call sent down it with a reset before a byte of answer. Nothing was
      // answered, so the call goes again once, on a connection of its own.
      if (
        !retried &&
        status === undefined &&
        failed.reusedSocket &&
        error.code === "ECONNRESET"
      ) {
        retried = true;
        deps.log(
          `model proxy: ${target.host} reset a pooled connection, sending the call again on a new one`,
        );
        upstreamReq = openUpstream(true);
        return;
      }
      deps.log(
        `model proxy: upstream ${target.host} unreachable: ${error.message}`,
      );
      settle("upstream_unreachable");
      sendProviderError(
        res,
        route,
        502,
        "upstream_unreachable",
        `The Oxagen gateway could not reach ${target.host}: ${error.message}`,
        true,
      );
    };

    /**
     * Send the call. The idle timeout arms only once a connection is open, so
     * a call still waiting for one, or for its connect to finish, is timed
     * separately: past `upstreamConnectMs` it is answered 504 rather than
     * left to wait on a connection that is not coming.
     */
    const openUpstream = (fresh: boolean): ClientRequest => {
      const created = (secure ? httpsRequest : httpRequest)({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port.length > 0 ? Number(target.port) : secure ? 443 : 80,
        method: req.method ?? "GET",
        path: `${target.pathname}${target.search}`,
        headers,
        agent: fresh ? false : secure ? httpsAgent : httpAgent,
      });
      created.setTimeout(upstreamIdleMs, () => {
        created.destroy(new Error("upstream idle timeout"));
      });
      const connectTimer = setTimeout(() => {
        if (settled || created !== upstreamReq) return;
        deps.log(
          `model proxy: no connection to ${target.host} within ${upstreamConnectMs}ms`,
        );
        created.destroy(new Error("upstream connect timeout"));
        settle("upstream_connect_timeout");
        sendProviderError(
          res,
          route,
          504,
          "upstream_connect_timeout",
          `The Oxagen gateway could not open a connection to ${target.host} within ${Math.round(upstreamConnectMs / 1000)}s.`,
          true,
        );
      }, upstreamConnectMs);
      connectTimer.unref();
      const connected = (): void => clearTimeout(connectTimer);
      created.once("socket", (socket) => {
        if (socket.connecting) socket.once("connect", connected);
        else connected();
      });
      created.once("close", connected);
      created.on("response", onResponse);
      created.on("error", (error) => onError(created, error));
      created.end(body);
      return created;
    };

    // Interrupted while `beforeForward` ran: the refusal is already sent, and
    // nothing reaches the vendor.
    if (abortReason !== undefined) {
      settle("interrupted");
      return;
    }
    upstreamReq = openUpstream(false);
    // The request is on its way to the vendor, and `settle` seals its frame
    // whatever happens to it from here.
    attempt.done = true;
  }

  return {
    handle: (req, res) => {
      void (async () => {
        const port = deps.port();
        const verdict = guardLoopbackRequest(
          {
            host: req.headers.host,
            origin: req.headers.origin as string | undefined,
          },
          port,
        );
        if (!verdict.ok || !isLoopbackPeer(req.socket.remoteAddress)) {
          const reason = verdict.reason ?? "host";
          deps.log(
            `model proxy: refused ${req.method ?? "?"} from ${String(req.socket.remoteAddress)}: ${verdict.ok ? "peer" : reason}`,
          );
          const text = JSON.stringify({
            error: verdict.ok
              ? "this listener answers only to loopback peers"
              : GUARD_MESSAGES[reason],
          });
          res.writeHead(403, {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(text),
          });
          res.end(text);
          req.resume();
          return;
        }
        const url = req.url ?? "/";
        if (
          req.method === "GET" &&
          (url === "/healthz" || url.startsWith("/healthz?"))
        ) {
          const text = JSON.stringify({
            ok: true,
            gateway: {
              listening: true,
              port: port ?? 0,
              routes: [...MODEL_PROXY_ROUTES],
              calls_observed: callsObserved,
            },
          });
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(text),
          });
          res.end(text);
          return;
        }
        const route = resolveModelRoute(url, req.headers);
        if (route === undefined) {
          const text = JSON.stringify({
            error: {
              message: "The Oxagen gateway serves no such path.",
              type: "not_found",
            },
          });
          res.writeHead(404, {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(text),
          });
          res.end(text);
          req.resume();
          return;
        }
        const admitted: { release?: () => void } = {};
        const attempt: CallAttempt = {
          startedAt: deps.now(),
          bytesRead: 0,
          done: false,
        };
        try {
          await forward(req, res, route, admitted, attempt);
        } catch (error) {
          admitted.release?.();
          deps.log(
            `model proxy: ${req.method ?? "?"} ${route.provider} ${route.api} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          // A call that failed before it was forwarded has no frame yet.
          sealNotForwarded(req, route, attempt, "gateway_error", 502);
          sendProviderError(
            res,
            route,
            502,
            "gateway_error",
            "The Oxagen gateway failed before it could forward this call.",
            true,
          );
        }
      })();
    },
    handleUpgrade: (_req, socket) => {
      // Codex tries a websocket first and falls back to HTTP for the rest of
      // the session on exactly this status. The proxy meters HTTP only.
      socket.end(
        "HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
    },
    abortSession: (sessionUuid, reason, retry) => {
      const calls = [...(inFlight.get(sessionUuid) ?? [])];
      for (const call of calls) call.abort(reason, retry);
      return calls.length;
    },
    callsObservedFor: (sessionUuid) => observed.get(sessionUuid) ?? 0,
    keepAliveTick: () => keepAlive.tick(),
    stats: () => {
      let open = 0;
      for (const calls of inFlight.values()) open += calls.size;
      return { callsObserved, refused, inFlight: open };
    },
    close: () => {
      clearInterval(keepAliveTimer);
      // The requests held for keep-alives carry credentials: none outlives
      // the proxy.
      keepAlive.clear();
      for (const calls of inFlight.values())
        for (const call of [...calls])
          call.abort("the daemon is stopping", "daemon_stopping");
      httpAgent.destroy();
      httpsAgent.destroy();
    },
  };
}
