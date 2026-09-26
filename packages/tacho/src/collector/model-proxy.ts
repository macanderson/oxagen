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
  resolveModelPriceMatch,
  usdToMicros,
} from "./model-pricing";
import { RequestPrefixMemory } from "./request-prefix";
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
  policy: () => ModelProxyPolicy;
  upstreams?: () => ModelUpstreams;
  /** Observed spend already on a session's chain, read once per session. */
  priorSpendMicros?: (sessionUuid: string) => number;
  /**
   * This host's observed spend on a UTC day (`YYYY-MM-DD`), read from its
   * WAL once per day (ADR-160).
   */
  priorDaySpendMicros?: DaySpendDeps["priorDaySpendMicros"];
  /** The control plane's latest figures for the agent's day, when it sent any. */
  recordedDaySpend?: DaySpendDeps["recordedDaySpend"];
  beforeForward?: BeforeForward;
  credentials?: CredentialBroker;
  /** How long `beforeForward` may take before the original is sent. */
  beforeForwardTimeoutMs?: number;
  /** The most request bytes held for one call. */
  maxRequestBytes?: number;
  /** Abort an upstream that sends nothing for this long. */
  upstreamIdleMs?: number;
  /** Answer 504 when no connection to the vendor is open this long after the call. */
  upstreamConnectMs?: number;
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
  stats: () => ModelProxyStats;
  close: () => void;
}

const DEFAULT_MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const DEFAULT_UPSTREAM_IDLE_MS = 10 * 60_000;
const DEFAULT_BEFORE_FORWARD_TIMEOUT_MS = 250;
const DEFAULT_UPSTREAM_CONNECT_MS = 30_000;
/**
 * How long a pooled upstream connection may sit idle before the proxy closes
 * it. Below the vendors' own keep-alive windows, so the proxy retires a
 * connection before the vendor does: sending a call down one the far end
 * has just closed is what turns a healthy call into an `ECONNRESET`.
 */
const FREE_SOCKET_TIMEOUT_MS = 30_000;

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
    "The run token this call carried was not issued by this Oxagen gateway. Run `tacho credential status` on this machine.",
  run_token_expired:
    "The run token this call carried has expired. The harness fetches a new one from the Oxagen gateway on its next attempt.",
  run_token_mismatch:
    "The run token this call carried was issued for another host or another model provider.",
  run_token_required:
    "This machine brokers model credentials through the Oxagen gateway, and this call carried none. Run `tacho enroll` again to point the harness at the gateway's run tokens.",
  foreign_credential:
    "This machine brokers model credentials through the Oxagen gateway, and this call brought its own. Unset the provider's API key (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or OPENAI_API_KEY) in the shell and in the env block of any .claude/settings.json or .claude/settings.local.json the harness reads; the gateway supplies the credential.",
  credential_unavailable:
    "The run token is valid, but the Oxagen gateway holds no credential for this model provider. Run `tacho enroll` again, or `tacho credential status` to see what is in custody.",
};

export function createModelProxy(deps: ModelProxyDeps): ModelProxy {
  const maxRequestBytes = deps.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  const upstreamIdleMs = deps.upstreamIdleMs ?? DEFAULT_UPSTREAM_IDLE_MS;
  const hookTimeoutMs =
    deps.beforeForwardTimeoutMs ?? DEFAULT_BEFORE_FORWARD_TIMEOUT_MS;
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
  // What each session's previous call carried, so the next call's body holds
  // only what is new (`request-prefix.ts`).
  const priors = new RequestPrefixMemory();
  let callsObserved = 0;
  let refused = 0;
  retireIdleSockets(httpAgent);
  retireIdleSockets(httpsAgent);
  const upstreamConnectMs =
    deps.upstreamConnectMs ?? DEFAULT_UPSTREAM_CONNECT_MS;

  const HOST_KEY = "host";

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

  function attrsFor(
    route: ModelRoute,
    how: string,
    credential: ResolvedCredential,
  ): Record<string, string> {
    return {
      [TACHO_ENFORCEMENT_TIER_ATTR]: TACHO_GATEWAY_TIER,
      "oxagen.model_api": route.api,
      "oxagen.correlation": how,
      [TACHO_CREDENTIAL_BASIS_ATTR]: credential.basis,
      // The id names the token on the record; the token itself is never
      // written anywhere, and a refused token's id is read off it unverified.
      ...(credential.claims !== undefined
        ? { [TACHO_RUN_TOKEN_ATTR]: credential.claims.tid }
        : {}),
    };
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

  function readBody(req: IncomingMessage): Promise<Buffer | "too_large"> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let over = false;
      req.on("data", (chunk: Buffer) => {
        if (over) return;
        size += chunk.length;
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

  async function forward(
    req: IncomingMessage,
    res: ServerResponse,
    route: ModelRoute,
    admitted: { release?: () => void },
  ): Promise<void> {
    const startedAt = deps.now();
    const received = await readBody(req);
    if (received === "too_large") {
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
    const metered = route.api !== "other";

    // The model the harness asked for, read before the refusal decision so the
    // `models` clause has a string to check. It used to be read after
    // `refusalFor` had already returned, which is why an allowlist bolted onto
    // the old shape would have refused nothing.
    const { model: askedModel, ambiguous: modelAmbiguous } = modelOf(
      readable,
      json,
    );

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
      deps.record([
        recorder.sealCollectorEvent(
          "policy_decision",
          {
            policy_decision: "deny",
            policy_source: refusal.source,
            policy_reason_code: refusal.code,
            policy_reason_digest: digestText(refusal.message),
            bundle_version: view.bundle.version,
            bundle_mode: view.bundle.mode,
          },
          {
            fidelity: "proxy",
            attrs: {
              ...attrs,
              "oxagen.refused": "model_call",
              "oxagen.provider": route.provider,
              "oxagen.request_digest": digestBytes(body),
              // The model the refusal was about, when the proxy could read
              // one. A `model_not_permitted` frame that does not name the
              // model leaves the operator guessing which entry to add.
              ...(askedModel !== undefined
                ? { "oxagen.model": askedModel.slice(0, 512) }
                : {}),
              ...(modelAmbiguous ? { "oxagen.model_ambiguous": "true" } : {}),
              ...(record !== undefined
                ? {
                    "oxagen.session_spend_usd_micros": String(
                      spendFor(sessionKey),
                    ),
                  }
                : {}),
              ...("attrs" in refusal ? refusal.attrs : {}),
            },
          },
        ),
      ]);
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
    // (ADR-193).
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
    // The body stores the request with the prefix the previous call already
    // holds cut out. Folding runs on the full decoded text, whatever its
    // size: a request over the cap usually folds down to the few messages
    // that are new, and checking the raw bytes here — before the fold had a
    // chance to make that saving — used to throw it away and ship no request
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
    // (ADR-193). The attribute rides the envelope, so it survives a
    // `digest_only` workspace that keeps none of these bytes.
    const requestWindow = metered
      ? measureProviderRequest(
          route.api,
          injectedJson ?? json(),
          injectedJson === undefined ? undefined : json(),
        )
      : null;
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
      set.delete(entry);
      if (set.size === 0) inFlight.delete(sessionKey);
      try {
        settleMetered(errorClass);
      } catch (error) {
        // Sealing a frame or appending it to the WAL must never surface
        // here: this runs inside response, error and close event listeners
        // with nothing above it to catch a throw, and Node treats an
        // uncaught exception thrown from a listener as fatal, which would
        // take the whole daemon down mid-call over one frame. The response
        // already sent, or already decided, is unaffected; only this call's
        // own frame is lost, and that is logged rather than silent.
        deps.log(
          `model proxy: sealing the call's frame failed, the response the caller already has is unaffected: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };

    const settleMetered = (errorClass: string | undefined): void => {
      if (!metered) return;
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
      const failed =
        errorClass ??
        (status !== undefined && status >= 400 ? `http_${status}` : undefined);
      const responseText = responseBody.text();
      // The exchange ships at most `TACHO_MAX_BODY_BYTES`, request and
      // response together: `prepareContent` (evidence/frame-body.ts) holds no
      // body at all past that cap, so two halves that separately fit but do
      // not together would otherwise cost the call both of them, when the
      // request alone — usually the smaller half, already folded down to
      // what changed — would have replayed fine on its own. The response is
      // dropped first.
      let requestContentText = requestTooLarge ? undefined : fold?.text;
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
      // `fold` already remembered this call as the session's next prior
      // (`request-prefix.ts`), on the assumption its own body would ship.
      // A request cut for size here — alone, or only once paired with the
      // response — breaks that assumption: the next call's `unchanged_from`
      // would point at a body nobody stored. Forgetting falls back to
      // storing the next call in full, which costs the saving this call
      // would have offered but never points at an unstored body.
      if (fold !== undefined && requestContentText === undefined) {
        priors.forget(sessionKey);
      }
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
      deps.record(
        [
          recorder.sealCollectorEvent(
            "llm_call",
            {
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
              api_duration_ms: Math.max(0, deps.now() - startedAt),
              ...(status !== undefined ? { api_status_code: status } : {}),
              ...(failed !== undefined || usage.streamError !== undefined
                ? { api_error_class: failed ?? `stream_${usage.streamError}` }
                : {}),
              ...(requestId !== undefined ? { request_id: requestId } : {}),
              ...(usage.responseId !== undefined
                ? { message_id: usage.responseId }
                : {}),
            },
            {
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
                      "oxagen.request_stored_bytes": String(fold.storedBytes),
                    }
                  : {}),
                ...(fold?.prior !== undefined
                  ? {
                      "oxagen.request_prior_digest": fold.prior.unchanged_from,
                      "oxagen.request_prior_messages": String(
                        fold.prior.messages,
                      ),
                      "oxagen.request_prior_fields":
                        fold.prior.fields.join(","),
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
            },
          ),
        ],
        recorder.takeBodies(),
      );
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
        try {
          await forward(req, res, route, admitted);
        } catch (error) {
          admitted.release?.();
          deps.log(
            `model proxy: ${req.method ?? "?"} ${route.provider} ${route.api} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
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
    stats: () => {
      let open = 0;
      for (const calls of inFlight.values()) open += calls.size;
      return { callsObserved, refused, inFlight: open };
    },
    close: () => {
      for (const calls of inFlight.values())
        for (const call of [...calls])
          call.abort("the daemon is stopping", "daemon_stopping");
      httpAgent.destroy();
      httpsAgent.destroy();
    },
  };
}
