/**
 * Anonymous, OPT-OUT CLI usage telemetry — the client side of
 * `POST /v1/telemetry/usage` (apps/api/src/routes/v1/telemetry.usage.ts).
 * Full disclosure lives in TELEMETRY.md at the repo root; read that first.
 *
 * Design invariants (this file IS the trust boundary on the client):
 *   - `ALLOWED_KEYS` below is the set of fields this module puts on the wire.
 *     Enforcement is at build + test time, not runtime: `buildUsageEvent` is
 *     the sole payload constructor and `UsageEventPayload` types it exactly,
 *     and the test below cross-checks the list. Nothing strips a stray key
 *     from a payload handed straight to `sendUsageEvent`, so that constructor
 *     is the boundary to keep honest.
 *     It is a plain, dependency-free literal — NOT imported from
 *     `@oxagen/telemetry` — so the published, potentially-open-sourced CLI has
 *     zero production coupling to that internal workspace package (no
 *     ClickHouse client, no OpenTelemetry SDK ever reaches the CLI bundle). A
 *     test-only cross-check (usage.test.ts, via a devDependency) asserts this
 *     list never drifts from the canonical schema in
 *     packages/telemetry/src/usage-events.ts, so the two cannot silently
 *     diverge even though they are not the same object at runtime.
 *   - Every value is a UUID, a short identifier-shaped string, a 0/1 flag, or
 *     a bounded integer. There is no field, anywhere in this module, that
 *     could carry a prompt, file path, model slug, API key, or any other
 *     piece of content or identity.
 *   - Sending is opt-out-respecting, best-effort, and bounded: if telemetry is
 *     disabled this module never PERSISTS an id (no install id is minted or
 *     written to disk) and never opens a socket; if it is enabled, the network
 *     call is wrapped in a short AbortController timeout and every error
 *     (network, timeout, non-2xx) is swallowed. A telemetry failure can never
 *     surface as a CLI failure. The ephemeral in-process `SESSION_ID` below is
 *     minted at import time either way — it is never written down and never
 *     leaves the process while opted out.
 */
import { randomUUID } from "node:crypto";
import { readConfig, writeConfig, getApiUrl } from "../lib/config.js";
import pkg from "../../package.json" with { type: "json" };

/** The exact 18-key allowlist the ingest route accepts — see the file header. */
export const ALLOWED_KEYS = [
  "install_id",
  "session_id",
  "oxagen_version",
  "os",
  "arch",
  "command",
  "model_tier",
  "best_of_n",
  "graph_used",
  "pipeline_used",
  "tui",
  "headless",
  "byok",
  "tool_calls_json",
  "step_count",
  "duration_ms",
  "error_type",
  "exit_status",
] as const;

export type ModelTier = "fast" | "balanced" | "precise" | "mixed" | "";

/** The wire payload — every field matches a `usage_events` ClickHouse column. */
export interface UsageEventPayload {
  install_id: string;
  session_id: string;
  oxagen_version: string;
  os: string;
  arch: string;
  command: string;
  model_tier: ModelTier;
  best_of_n: number;
  graph_used: 0 | 1;
  pipeline_used: 0 | 1;
  tui: 0 | 1;
  headless: 0 | 1;
  byok: 0 | 1;
  tool_calls_json: string;
  step_count: number;
  duration_ms: number;
  error_type: string;
  exit_status: string;
}

const USAGE_ENDPOINT_PATH = "/v1/telemetry/usage";
/** Fire-and-forget send is bounded at this ceiling — see sendUsageEvent. */
const SEND_TIMEOUT_MS = 2_000;

// ── Opt-out (checked in this exact order; any one disables everything) ───────

/**
 * True unless explicitly disabled. Checks, in order: `DO_NOT_TRACK=1` (the
 * cross-tool convention: https://consoledonottrack.com/), `OXAGEN_TELEMETRY=0`,
 * then the persisted `telemetry.enabled` config flag (`oxagen telemetry off`).
 */
export function isTelemetryEnabled(): boolean {
  if (process.env["DO_NOT_TRACK"] === "1") return false;
  if (process.env["OXAGEN_TELEMETRY"] === "0") return false;
  if (readConfig().telemetry?.enabled === false) return false;
  return true;
}

// ── install id ────────────────────────────────────────────────────────────

/**
 * Read the persisted per-install id, or mint and persist a new one. Callers
 * MUST check {@link isTelemetryEnabled} first — this function does not check
 * it itself, so that "no id is ever generated while opted out" is visibly
 * true at the call site (recordUsageEvent) rather than hidden in here.
 */
export function getOrCreateInstallId(): string {
  const config = readConfig();
  const existing = config.telemetry?.installId;
  if (existing) return existing;
  const installId = randomUUID();
  writeConfig({ telemetry: { ...config.telemetry, installId } });
  return installId;
}

// ── one-time disclosure ──────────────────────────────────────────────────────

const DISCLOSURE_LINES = [
  "",
  "Oxagen CLI collects anonymous usage telemetry (command names, durations,",
  "coarse success/error categories, OS/arch) to improve the product. It never",
  "collects code, prompts, file contents, file paths, model slugs, or",
  "personal data — see TELEMETRY.md for the exact field list.",
  "",
  "Opt out anytime: `oxagen telemetry off`, or set OXAGEN_TELEMETRY=0 /",
  "DO_NOT_TRACK=1. This notice only prints once.",
  "",
];

/** Print the one-time first-run notice to stderr, then never again. */
export function ensureDisclosureShown(): void {
  const config = readConfig();
  if (config.telemetry?.disclosed) return;
  process.stderr.write(DISCLOSURE_LINES.join("\n") + "\n");
  writeConfig({ telemetry: { ...config.telemetry, disclosed: true } });
}

// ── session-level accumulator ────────────────────────────────────────────
//
// Populated opportunistically by call sites deep in the agent loop that have
// signal the generic index.tsx wrapper does not — e.g. which model tier
// actually ran, how many tool calls of each kind. Every setter is a no-op-safe
// accumulator; nothing here can throw, and nothing here is required for a
// valid event (all fields have a safe zero-value default).

interface SessionStats {
  modelTiers: Set<ModelTier>;
  bestOfN: number;
  graphUsed: boolean;
  pipelineUsed: boolean;
  byok: boolean;
  toolCalls: Record<string, number>;
  stepCount: number;
}

function emptyStats(): SessionStats {
  return {
    modelTiers: new Set(),
    bestOfN: 0,
    graphUsed: false,
    pipelineUsed: false,
    byok: false,
    toolCalls: {},
    stepCount: 0,
  };
}

let stats = emptyStats();

/** Reset the accumulator. Called by tests; also safe to call at the start of a new REPL turn. */
export function resetUsageSessionStats(): void {
  stats = emptyStats();
}

/** Tally one or more invocations of a tool by name (e.g. "code_graph", "grep"). */
export function recordToolCall(toolName: string, count = 1): void {
  // Match the server's identifier shape so a name never fails validation —
  // never the tool's arguments or output, just the name and a count.
  const key =
    toolName
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")
      .slice(0, 32) || "unknown";
  stats.toolCalls[key] = (stats.toolCalls[key] ?? 0) + count;
}

/** Record which model tier served a turn. A session that uses >1 tier reports "mixed". */
export function recordModelTier(tier: ModelTier): void {
  if (tier) stats.modelTiers.add(tier);
}

/** Record the best-of-N fan-out width for `oxagen solve`. */
export function setBestOfN(n: number): void {
  stats.bestOfN = Math.max(stats.bestOfN, Math.trunc(n));
}

/** Mark that the local code-graph tool fired this session. */
export function markGraphUsed(): void {
  stats.graphUsed = true;
}

/** Mark whether the coding-agent pipeline (prompt-enhancer/judge/survey) ran. */
export function markPipelineUsed(used = true): void {
  stats.pipelineUsed = used;
}

/** Mark whether the session ran in local BYOK mode. */
export function setByok(byok: boolean): void {
  stats.byok = byok;
}

/** Add to the agent-loop step/turn count. */
export function addSteps(n: number): void {
  stats.stepCount += Math.max(0, Math.trunc(n));
}

function resolveModelTier(): ModelTier {
  if (stats.modelTiers.size === 0) return "";
  if (stats.modelTiers.size > 1) return "mixed";
  const [only] = stats.modelTiers;
  return only ?? "";
}

// ── classify + build + send ──────────────────────────────────────────────────

/** Coarse, PII-free error category from a caught error. Never the message or stack. */
export function classifyErrorType(err: unknown): string {
  if (!(err instanceof Error)) return "unknown";
  const msg = err.message.toLowerCase();
  if (
    msg.includes("credit") ||
    msg.includes("insufficient") ||
    msg.includes("billing")
  ) {
    return "credit_balance";
  }
  if (msg.includes("abort")) return "aborted";
  if (msg.includes("timeout") || msg.includes("timed out")) return "timeout";
  if (
    msg.includes("network") ||
    msg.includes("fetch failed") ||
    msg.includes("econnrefused") ||
    msg.includes("enotfound")
  ) {
    return "network";
  }
  return "unknown";
}

/**
 * Classify raw argv into a safe, fixed-vocabulary command label. NEVER
 * returns arbitrary argv content — a bare prompt (`oxagen "fix the bug"`) has
 * no subcommand token, so it is classified purely by SHAPE (prompt / repl /
 * stdin), never by the words themselves.
 */
export function classifyCommand(
  argv: string[],
  knownCommands: readonly string[],
): string {
  const rest = argv.slice(2);
  const first = rest[0];
  if (first && !first.startsWith("-") && knownCommands.includes(first))
    return first;
  const hasPositional = rest.some((a) => !a.startsWith("-"));
  if (hasPositional) return "prompt";
  return process.stdout.isTTY ? "repl" : "stdin";
}

/** One random id per CLI process — groups the (at most one) event this run emits. */
const SESSION_ID = randomUUID();

export interface BuildEventInput {
  command: string;
  durationMs: number;
  exitStatus: string;
  errorType?: string;
  tui?: boolean;
  headless?: boolean;
}

/** Assemble the full, allowlist-shaped payload from the accumulator + per-call fields. */
export function buildUsageEvent(
  input: BuildEventInput,
  installId: string,
): UsageEventPayload {
  return {
    install_id: installId,
    session_id: SESSION_ID,
    oxagen_version: String(pkg.version),
    os: process.platform,
    arch: process.arch,
    command: input.command,
    model_tier: resolveModelTier(),
    best_of_n: stats.bestOfN,
    graph_used: stats.graphUsed ? 1 : 0,
    pipeline_used: stats.pipelineUsed ? 1 : 0,
    tui: input.tui ? 1 : 0,
    headless: (input.headless ?? !process.stdout.isTTY) ? 1 : 0,
    byok: stats.byok ? 1 : 0,
    tool_calls_json: JSON.stringify(stats.toolCalls),
    step_count: stats.stepCount,
    duration_ms: Math.max(0, Math.trunc(input.durationMs)),
    error_type: input.errorType ?? "",
    exit_status: input.exitStatus,
  };
}

/**
 * Send one event, fire-and-forget. Bounded at {@link SEND_TIMEOUT_MS}; EVERY
 * failure mode (network error, timeout, non-2xx response) is swallowed here
 * — telemetry can never throw into, slow, or break the calling command. Also
 * re-checks the opt-out flags so a disabled install never opens a socket even
 * if a caller forgets to check first.
 */
export async function sendUsageEvent(
  payload: UsageEventPayload,
): Promise<void> {
  if (!isTelemetryEnabled()) return;
  const url = `${getApiUrl()}${USAGE_ENDPOINT_PATH}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch {
    // Network error, abort/timeout, or a thrown non-Response — all swallowed.
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The single entry point every command flow calls at the end of a run (see
 * index.tsx). No-ops completely — no disclosure, no id generation, no
 * network — when telemetry is disabled.
 *
 * This function is a hard guarantee, not just a convention: it can NEVER
 * throw. `sendUsageEvent` already swallows every network-side failure, but
 * `ensureDisclosureShown`/`getOrCreateInstallId` touch the filesystem
 * (~/.config/oxagen/config.json) via `readConfig`/`writeConfig`, which CAN
 * throw (permissions, disk full, a racing writer). Telemetry must never be
 * the reason a command's own success/failure result gets masked, so the
 * whole body is wrapped here — at the source, not left to every call site to
 * remember — rather than only in a defensive `.catch()` at the call site.
 */
export async function recordUsageEvent(input: BuildEventInput): Promise<void> {
  try {
    if (!isTelemetryEnabled()) return;
    ensureDisclosureShown();
    const installId = getOrCreateInstallId();
    const payload = buildUsageEvent(input, installId);
    await sendUsageEvent(payload);
  } catch {
    // Config I/O failure or anything else unforeseen — telemetry is always
    // best-effort and must never propagate into the calling command.
  }
}
