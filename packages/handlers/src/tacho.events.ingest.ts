// tacho.events.ingest.ts — the machine-to-machine intake for tacho/1.0 events.
//
// Trust boundary (spec section 3.1 step 4, data-model.md section 0.4):
//   - Tenant identity comes from the API key's scope, never the body.
//   - The key must carry the server-owned `tacho_host_v1` scope naming a
//     live host in this tenant, and every event must name that host.
//   - Every event's hash is recomputed and every chain link checked, within
//     the batch and against the session row's stored head. A break never
//     rejects the batch (telemetry is fail-open); it is recorded on the row,
//     stamped on every event as chain_verified = false, and answered back.
//
// A re-sent event (one below its session's recorded head) is compared with
// the frame ClickHouse holds at its seq: the same hash is not written again,
// another hash is refused and answered as a chain break, and a seq ClickHouse
// does not hold is written, because that is the retry of an append that
// failed after the Postgres commit. The control envelope, which drains the
// host's queued commands, is built only after the append has landed.
//
// What lands: every event in ClickHouse `tacho_events`; the session rows,
// per-model rollups, files touched, and commands run in Postgres; the host's
// liveness; and the control envelope in the response. A batch that carried
// cost adds it to the spend-budget counter (ADR-060 §5), and an `agent_stop`
// on a root session emits `cost/run.sealed` so the rollup job rebuilds the
// run's `cost.run_totals` row from its frames (ADR-060 §3).
//
// Billing (ADR-165): each tool call a wrapped harness made and Tacho allowed
// is one governed action unit on the per-action ledger, keyed by the call's
// `tool_use_id` so a re-sent batch bills nothing twice (`isBillableToolCall`
// has the rule). Denials are free. The control envelope is built after
// billing, so a batch refused at any step leaves its commands queued.
//
// Proof (ADR-064): each fresh `proof.observed` frame writes its verdict row
// (lib/proof.ts) under the run it is part of, the root session named by its
// `root_session_uuid`, whichever session's chain carried it. A verdict reaching
// a root sealed before it asks the rollup for the run's row again, so the row
// carries it. A proof body the run-evidence schema refuses is still recorded
// as a frame; only its verdict row is skipped, and `proof_rejections` names it.
//
// Bodies (ADR-058): a batch may ship the bytes a frame's `content.digest`
// names. The host is resolved first (a revoked, expired or mismatched host
// writes nothing), then the control plane verifies each body against the
// chain and the platform's redaction detectors (lib/tacho-replay.ts),
// refuses the workspace has opted down to digest_only, writes the accepted
// bytes through the evidence body store before any row references them, and
// stamps the object reference on the ClickHouse row. Each session counts the
// frames that carried content, the bodies retained and the tool result
// bodies among them; the `agent_stop` seal grades the session from those
// counts, the chain verdict and the host's own gaps, and writes
// `replay_grade` and `completeness_gaps` on the session row.

import type { CapabilityHandler } from "@oxagen/oxagen";
import { tachoEventsIngest } from "@oxagen/oxagen/contracts/tacho.events.ingest";
import { schema, withTenantDb } from "@oxagen/database";
import type { TachoSealSource } from "@oxagen/database/schema";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import { runEnrichmentEnabled } from "@oxagen/oxagen/run-enrichment";
import {
  PROOF_OBSERVED_KIND,
  proofObservedBodySchema,
} from "@oxagen/run-evidence";
import {
  countsLlmCallSplit,
  countsLlmCallUsage,
  deriveSessionTitle,
  fallbackRunTitle,
  retainsBody,
  TACHO_GATEWAY_TIER,
  TACHO_METERING_ATTR,
  TACHO_METERING_OBSERVED,
  type TachoEvent,
  verifyChain,
} from "@oxagen/tacho";
import {
  insertTachoEvents,
  selectTachoStoredFrames,
  storeOverloadedFrom,
  type TachoEventInsert,
} from "@oxagen/telemetry";
import {
  attributableWorkspaceId,
  governedActionEntry,
  type GovernedActionEntry,
  ledgerKey,
  recordGovernedActions,
  recordSpend,
} from "@oxagen/billing";
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { evidenceStore } from "@oxagen/run-ledger/evidence-store";
import { writeAssembly } from "@oxagen/run-ledger";
import {
  containedLaunchesFor,
  containedTierOf,
  promotedTier,
} from "./lib/tacho-containment";
import { machineSnapshotOf } from "./lib/machine-facts";
import { rollupFiles, sessionChangedFilesWhere } from "./lib/file-facts-rollup";
import { latestHarnessTitle } from "./lib/harness-title";
import { unlockOnboardingGate } from "./lib/onboarding";
import {
  gatewayInvocationColumnReady,
  sessionFileObservedStatusColumnReady,
  sessionGatewayColumnReady,
  sessionPushesColumnReady,
  sessionMachineSnapshotColumnReady,
} from "./lib/tacho-gateway-columns";
import { eventClient } from "./event-client";
import {
  RUN_ENRICH_EVENT,
  RUN_PROGRESSED_EVENT,
} from "@oxagen/inngest-functions/events";
import { recordProofFrames } from "./lib/proof";
import {
  type TachoHostRow,
  controlEnvelope,
  readWorkspaceRetention,
  resolveEnrolledHost,
  tachoDenied,
  touchHost,
  unstorableBatch,
} from "./lib/tacho-host";
import {
  continuesRecordedChain,
  readSuccessionHosts,
  succeedsHost,
} from "./lib/tacho-session-succession";
import {
  type BodyRejection,
  countContentFrames,
  sealTachoSession,
  verifyBatchBodies,
  type VerifiedBody,
} from "./lib/tacho-replay";
import { logger } from "./logger";

type Body = Record<string, unknown>;

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

interface SessionDelta {
  numTurns: number;
  numPrompts: number;
  numModelCalls: number;
  numApiErrors: number;
  numToolCalls: number;
  numToolErrors: number;
  numToolRejections: number;
  numSubagents: number;
  numCompactions: number;
  numModelSwitches: number;
  numNotifications: number;
  numElicitations: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheCreation5mTokens: number;
  cacheCreation1hTokens: number;
  thinkingTokens: number;
  webSearchRequests: number;
  webFetchRequests: number;
  totalCostMicros: number;
  policyDecisions: number;
  policyDenies: number;
  telemetryGapCount: number;
  filesRead: number;
  filesWritten: number;
  filesDeleted: number;
  commandsRun: number;
  networkCalls: number;
  commits: number;
  pushes: number;
  pullRequests: number;
}

/**
 * Count a frame that acted on a repository rather than on a file.
 *
 * The frame kind does not decide this and must not: a pull request opened
 * from the shell seals a `command` frame and one opened through the GitHub
 * MCP server seals a `network` frame, and they are the same act. The
 * `effect_kind` is the discriminator, so both call sites ask the same
 * question of it.
 *
 * These count intent, not confirmed outcome. The collector seals an effect
 * frame only for a call that succeeded, so a push rejected for a
 * non-fast-forward is not counted here. What is still not observed is the
 * remote: nothing in this path reads the branch afterwards to confirm the
 * ref moved, and a push performed inside a script the agent invoked is
 * invisible to the classifier that produced these kinds.
 */
function countRepoEffect(delta: SessionDelta, effectKind: unknown): void {
  if (effectKind === "git_commit") delta.commits += 1;
  else if (effectKind === "git_push") delta.pushes += 1;
  else if (effectKind === "pr_open") delta.pullRequests += 1;
}

function emptyDelta(): SessionDelta {
  return {
    numTurns: 0,
    numPrompts: 0,
    numModelCalls: 0,
    numApiErrors: 0,
    numToolCalls: 0,
    numToolErrors: 0,
    numToolRejections: 0,
    numSubagents: 0,
    numCompactions: 0,
    numModelSwitches: 0,
    numNotifications: 0,
    numElicitations: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cacheCreation5mTokens: 0,
    cacheCreation1hTokens: 0,
    thinkingTokens: 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
    totalCostMicros: 0,
    policyDecisions: 0,
    policyDenies: 0,
    telemetryGapCount: 0,
    filesRead: 0,
    filesWritten: 0,
    filesDeleted: 0,
    commandsRun: 0,
    networkCalls: 0,
    commits: 0,
    pushes: 0,
    pullRequests: 0,
  };
}

/**
 * A model call the host's loopback proxy observed on the wire (ADR-094): an
 * `llm_call` the collector sealed with `proxy` fidelity and
 * `oxagen.metering: observed`. Its usage is the vendor's own, read off the
 * response, and not the harness's report of it.
 *
 * All three marks are required. A record posted to the host's OTLP endpoint is
 * sealed `otel_log` with `sdk` fidelity whatever attributes it carries, so a
 * process holding the local bearer cannot mint one of these by setting the
 * attribute alone.
 */
export function isObservedModelCall(event: TachoEvent): boolean {
  return (
    event.kind === "llm_call" &&
    event.source === "collector" &&
    event.fidelity === "proxy" &&
    event.attrs[TACHO_METERING_ATTR] === TACHO_METERING_OBSERVED
  );
}

/**
 * The events that count toward usage, with observed metering taking precedence
 * over self-reported metering for the same calls.
 *
 * A session routed through the proxy reports every model call twice: once as
 * the proxy's observed frame, and once as the harness's own telemetry (an
 * `otel_log` or a `transcript` `llm_call`). Counting both doubles the session's
 * tokens and cost. The observed frame is sealed when the response ends, and the
 * harness exports its own record after that, so on one chain the observed frame
 * always comes first. The rule follows from that order: once a session has an
 * observed model call, every self-reported `llm_call` after it is dropped from
 * the counters. The frame itself is still stored; only its usage is not added.
 *
 * `sessionObserved` carries the answer across batches: it is true when an
 * earlier batch already recorded an observed call for this session
 * (`cost_basis = 'observed'` on the row).
 *
 * A session that bypassed the proxy has no observed frame, so nothing is
 * dropped and its self-reported usage counts as it always has.
 */
export function usageCountedEvents(
  fresh: readonly TachoEvent[],
  sessionObserved: boolean,
): TachoEvent[] {
  let observed = sessionObserved;
  const counted: TachoEvent[] = [];
  for (const event of fresh) {
    if (isObservedModelCall(event)) {
      observed = true;
      counted.push(event);
      continue;
    }
    if (observed && event.kind === "llm_call") continue;
    counted.push(event);
  }
  return counted;
}

/**
 * The run facts a batch last recorded: the model, the permission mode, the
 * effort, and the head commit. Each is the latest non-empty value in the
 * batch, so a batch whose last frame carries no context (a daemon frame, a
 * reconciliation) does not read as a session that stopped reporting them.
 * The caller writes each one only when it is non-null (#4010).
 */
export function lastRecordedContext(fresh: readonly TachoEvent[]): {
  model: string | null;
  permissionMode: string | null;
  effort: string | null;
  gitHeadSha: string | null;
} {
  const facts = {
    model: null as string | null,
    permissionMode: null as string | null,
    effort: null as string | null,
    gitHeadSha: null as string | null,
  };
  for (const event of fresh) {
    const context = event.context;
    if (!context) continue;
    facts.model = str(context.model) ?? facts.model;
    facts.permissionMode = str(context.permission_mode) ?? facts.permissionMode;
    facts.effort = str(context.effort) ?? facts.effort;
    facts.gitHeadSha = str(context.git_head_sha) ?? facts.gitHeadSha;
  }
  return facts;
}

/**
 * The first harness version any frame in the batch carries, or null.
 *
 * A Claude Code session usually opens on a hook, and a hook payload has no
 * version. The recorder learns it later, from the first OTel record or
 * transcript line, and stamps the frames after that. Reading the genesis
 * frame alone left `harness_version` null for the whole run.
 */
export function batchHarnessVersion(
  fresh: readonly TachoEvent[],
): string | null {
  for (const event of fresh) {
    const version = str(event.agent.harness_version);
    if (version !== null) return version;
  }
  return null;
}

/**
 * Fold one event into the session's counters. Model usage counts each call
 * once, from its first sighting (OTel log, transcript, or hook), or the
 * proxy's observed view when the session has one: the caller passes the
 * events through `usageCountedEvents` first.
 */
export function foldDelta(delta: SessionDelta, event: TachoEvent): void {
  const body = event.body as Body;
  switch (event.kind) {
    case "turn_start":
      delta.numTurns += 1;
      delta.numPrompts += 1;
      break;
    case "llm_call":
      // One row per call carries its tokens: the first sighting from any
      // token-bearing source, transcript included. A later sighting of the
      // same call from another source is stamped
      // `oxagen.llm_call_duplicate_of` by the host and adds nothing here
      // (`countsLlmCallUsage`, shared with the host's ledger).
      if (countsLlmCallUsage(event)) {
        delta.numModelCalls += 1;
        delta.inputTokens += num(body["input_tokens"]);
        delta.outputTokens += num(body["output_tokens"]);
        delta.cacheReadTokens += num(body["cache_read_tokens"]);
        delta.cacheCreationTokens += num(body["cache_creation_tokens"]);
        delta.totalCostMicros += num(body["cost_usd_micros"]);
      }
      // The observed frame carries the classes the harness's OTel record does
      // not, and in an observed session the transcript view is not counted.
      // A transcript continuation block had its usage stripped by the host
      // and is excluded by `countsLlmCallSplit`.
      if (countsLlmCallSplit(event) || isObservedModelCall(event)) {
        delta.cacheCreation5mTokens += num(body["cache_creation_5m_tokens"]);
        delta.cacheCreation1hTokens += num(body["cache_creation_1h_tokens"]);
        delta.thinkingTokens += num(body["thinking_tokens"]);
        delta.webSearchRequests += num(body["web_search_requests"]);
        delta.webFetchRequests += num(body["web_fetch_requests"]);
      }
      break;
    case "error":
      if (
        body["api_error_class"] !== undefined ||
        body["api_status_code"] !== undefined
      )
        delta.numApiErrors += 1;
      break;
    case "tool_call":
      if (event.source === "hook" || event.source === "collector") {
        delta.numToolCalls += 1;
        if (body["tool_status"] === "error") delta.numToolErrors += 1;
        if (body["tool_status"] === "rejected") delta.numToolRejections += 1;
        if (body["effect_kind"] === "file_read") delta.filesRead += 1;
      }
      break;
    case "file_io":
      if (body["effect_kind"] === "file_delete") delta.filesDeleted += 1;
      else delta.filesWritten += 1;
      break;
    case "command":
      delta.commandsRun += 1;
      countRepoEffect(delta, body["effect_kind"]);
      break;
    case "network":
      delta.networkCalls += 1;
      countRepoEffect(delta, body["effect_kind"]);
      break;
    case "policy_decision":
    case "token_denied":
      if (
        event.source === "hook" ||
        event.source === "collector" ||
        event.source === "control_plane"
      ) {
        delta.policyDecisions += 1;
        if (body["policy_decision"] === "deny") delta.policyDenies += 1;
      }
      break;
    case "subagent_start":
      delta.numSubagents += 1;
      break;
    case "oxagen:compaction":
      if (event.hook_event_name === "PostCompact" || event.source !== "hook")
        delta.numCompactions += 1;
      break;
    case "oxagen:model_switch":
      if (event.hook_event_name === "PostModelSwitch")
        delta.numModelSwitches += 1;
      break;
    case "oxagen:notification":
      delta.numNotifications += 1;
      break;
    case "oxagen:elicitation":
      delta.numElicitations += 1;
      break;
    case "telemetry_gap":
      delta.telemetryGapCount += 1;
      break;
    default:
      break;
  }
}

/**
 * The key Tacho writes for Oxagen's own MCP server in a harness's
 * `mcpServers` map (`OXAGEN_MCP_SERVER_KEY`,
 * packages/tacho/src/host/mcp-config-writer.ts). Not exported from the
 * package root, so it is repeated here. Change both together.
 */
const OXAGEN_MCP_SERVER = "oxagen";

/**
 * Whether a frame is a tool call that bills one governed action unit: a call
 * a wrapped harness made, Tacho allowed, and the tool completed.
 *
 * A tool call normally has one frame that answers yes. The reasoning, one
 * condition at a time:
 *
 *   1. `kind === "tool_call"`. PreToolUse seals `tool_requested`, and a
 *      PermissionRequest seals `approval_request`, so the frames before the
 *      call runs never bill. PostToolUse and PostToolUseFailure seal the
 *      `tool_call`. The effect frame the same hook adds (`command`,
 *      `file_io`, `network`) is a different kind and never bills.
 *   2. `source === "hook"`. The hook is where Tacho rules on a harness tool
 *      call (every harness reaches it: Claude Code and Codex directly, Cursor
 *      and Stella through their adapters). The OTel exporter and the
 *      transcript tailer report the same call again, and the recorder seals
 *      at most one of those repeats (ADR-140). They observed the call, they
 *      did not govern it. `collector` frames are the daemon's own: a call to
 *      Oxagen's MCP gateway, which the kernel bills when it serves it, or a
 *      brokered git push, which the hook already reported as the harness's
 *      shell call.
 *   3. `tool_status === "ok"`. A denial never reaches PostToolUse. It seals a
 *      `policy_decision` (PermissionDenied, a Tacho deny) or `token_denied`,
 *      so denials stay free by construction. A frame reporting `rejected` or
 *      `cancelled` is a person or the harness stopping the call, and `error`
 *      is a call that failed. None of them bill, which is the rule the kernel
 *      applies to a handler that throws and the agent runtime applies to an
 *      external MCP call that fails: an action bills when it completes.
 *   4. Not a call to Oxagen's own MCP server. That call runs `invoke()`,
 *      and the kernel already bills it as a governed action. Billing its hook
 *      frame too would charge one action twice.
 *
 * What guarantees one unit per call, rather than one per frame, is the
 * ledger key ({@link tachoToolCallEntries}), not this predicate. A second
 * hook frame for a call (a repeat the recorder stamps because it brings a
 * body) carries the same `tool_use_id`, and the ledger bills a key once.
 */
export function isBillableToolCall(event: TachoEvent): boolean {
  if (event.kind !== "tool_call" || event.source !== "hook") return false;
  const body = event.body as Body;
  if (body["tool_status"] !== "ok") return false;
  return body["mcp_server_name"] !== OXAGEN_MCP_SERVER;
}

/** Who a session's tool calls are attributed to on the ledger. */
export interface ToolCallAttribution {
  /** claude-code, codex, cursor or stella, as the session row recorded it. */
  harness: string | null;
  /** The registered agent's public id (`agt_…`), or the host's agent key. */
  agentId: string | null;
  /** The agent principal the host enrolled as, when it enrolled as one. */
  principalId: string | null;
  principalKind: string | null;
  /** The session's initiating human principal. */
  operatorUserId: string | null;
  /** The run the Run page shows: the root session's public id (`tse_…`). */
  runId: string | null;
}

/**
 * The ledger entries for a batch's billable tool calls (ADR-165): one per
 * call, keyed `tacho:<session_uuid>:<tool_use_id>`.
 *
 * `tool_use_id` is unique within a session for every harness Tacho wraps
 * (Stella's is numbered per invocation by the daemon), so the key names the
 * call and not the frame that reported it. A re-sent batch builds the same
 * keys, and the ledger bills a key once.
 *
 * A frame without a `tool_use_id` falls back to its `event_id_idem`, which
 * the host assigns once and re-sends unchanged. Never a random value: a key
 * that changed on a re-send would bill the same call again.
 *
 * `toolName` is never null because the ledger requires a subject on every
 * row (`gau_ledger_subject_check`). A hook frame always carries one. The
 * fallback names the MCP tool, then says the harness sent no name.
 */
export function tachoToolCallEntries(
  events: readonly TachoEvent[],
  attributionFor: (sessionUuid: string) => ToolCallAttribution | undefined,
  args: { workspaceId: string; requestId: string | null; now: Date },
): GovernedActionEntry[] {
  const workspaceId = attributableWorkspaceId(args.workspaceId);
  const entries: GovernedActionEntry[] = [];
  for (const event of events) {
    if (!isBillableToolCall(event)) continue;
    const body = event.body as Body;
    const toolUseId = str(body["tool_use_id"]);
    const attribution = attributionFor(event.session_uuid);
    const at = new Date(event.ts);
    entries.push(
      governedActionEntry({
        idempotencyKey: ledgerKey(
          "tacho",
          event.session_uuid,
          toolUseId ?? `event:${event.event_id_idem}`,
        ),
        source: "tacho",
        units: 1,
        occurredAt: isNaN(at.getTime()) ? args.now : at,
        toolName:
          str(body["tool_name"]) ??
          str(body["mcp_tool_name"]) ??
          "unnamed tool",
        mcpServer: str(body["mcp_server_name"]),
        surface: "tacho",
        harness: attribution?.harness ?? str(event.agent.harness),
        workspaceId,
        agentId: attribution?.agentId ?? null,
        principalId: attribution?.principalId ?? null,
        principalKind: attribution?.principalKind ?? null,
        operatorUserId: attribution?.operatorUserId ?? null,
        runId: attribution?.runId ?? null,
        sessionId: event.session_uuid,
        toolCallId: toolUseId,
        requestId: args.requestId,
      }),
    );
  }
  return entries;
}

/**
 * Which of this host's chains the control plane actually served a gateway call
 * for, and when it last did — read from its own records, never from the batch.
 *
 * ## What this replaces
 *
 * The correlation used to be `carriesGatewayCall(events)`: does some event in
 * the batch carry `oxagen.enforcement_tier: "gateway"`. That answered the right
 * question with the wrong authority. The server observation
 * (`hosts.gateway_last_seen_at`) established only that the host had served a
 * gateway call at some point — one timestamp with no session on it — so the
 * batch chose which session it landed on, and whoever can submit a batch
 * chooses the batch. Once a host had served ONE legitimate gateway call the
 * timestamp was a reusable value: an existing session passed whenever the
 * observation was newer than its `createdAt`, and a newly invented session
 * passed unconditionally, because nothing predates a session being opened by
 * the same batch (#3221, discussion_r4036718127, discussion_r4040352859).
 *
 * Now both halves come from `tacho.gateway_chains`, written where
 * `machineKeyDenial` authenticated the host's `tacho_gateway_v1` credential and
 * ruled on the call. A batch submitter cannot cause a row there: it would need
 * the gateway credential, which never leaves the daemon. So a forged
 * `oxagen.enforcement_tier` on a host with a real observation now names a chain
 * the table has never heard of, and the session stays on the host's own mode.
 *
 * ## Why the latest, and why not consumed
 *
 * The newest invocation per chain is what the lifetime bound is applied to: a
 * chain that has served gateway calls for a week should not be judged on the
 * first one. Rows are never consumed on match. Consuming would let a forged
 * batch that arrived first burn a real observation belonging to the session
 * that earned it — trading this defect for a worse one, which is exactly why
 * #3178 declined to narrow the window instead of fixing the correlation.
 *
 * ## The empty answer
 *
 * `undefined` is returned without touching the database whenever a promotion is
 * impossible anyway — no host observation, or the table not migrated yet. That
 * is not an optimisation: querying a table that does not exist raises 42P01,
 * which aborts the transaction exactly as 42703 does, and would take out
 * ingestion for every host during the deploy-before-migrate window (#1275).
 */
/** What the control plane recorded about one chain its gateway served. */
interface GatewayChainRecord {
  /** The newest call, which the session's lifetime is measured against. */
  at: Date;
  /**
   * The chain's genesis hash as the gateway stated it, or null for a daemon
   * too old to send one. Null never promotes: the chain NAME alone is
   * something a forger holding the host's ingest key can also write.
   */
  genesisHash: string | null;
}

async function gatewayInvocationsFor(
  tx: Tx,
  host: GatewayObservable & { id: string },
  chains: string[],
  invocationTable: boolean,
): Promise<Map<string, GatewayChainRecord>> {
  const answers = new Map<string, GatewayChainRecord>();
  if (!invocationTable) return answers;
  if (gatewayObservationFor(host) === null) return answers;
  if (chains.length === 0) return answers;
  // No aggregate: `tacho.gateway_chains` holds one row per (host, chain), so
  // the newest call on a chain IS the row's `lastSeenAt`. The bound is a unique
  // index rather than a convention, which is what lets this be a plain read.
  const rows = await tx
    .select({
      chain: schema.tachoGatewayChains.chainSessionUuid,
      at: schema.tachoGatewayChains.lastSeenAt,
      genesisHash: schema.tachoGatewayChains.chainGenesisHash,
    })
    .from(schema.tachoGatewayChains)
    .where(
      and(
        eq(schema.tachoGatewayChains.hostId, host.id),
        inArray(schema.tachoGatewayChains.chainSessionUuid, chains),
      ),
    );
  for (const row of rows) {
    // Normalised rather than trusted: some pooled paths hand back a string,
    // and the value is compared against a session's `createdAt`, where a string
    // comparison would silently read as "always after".
    const at = row.at instanceof Date ? row.at : new Date(row.at);
    if (!isNaN(at.getTime()))
      answers.set(row.chain, { at, genesisHash: row.genesisHash ?? null });
  }
  return answers;
}

/** The bits of the host row the tier is derived from. Nothing else may be. */
export interface GatewayObservable {
  mode: string;
  gatewayLastSeenAt: Date | null;
}

/**
 * The control plane's own record that this host served a gateway call, or
 * `null` when it has none.
 *
 * `tacho_hosts.gateway_last_seen_at` is written in
 * `@oxagen/iam`'s `machineKeyDenial`, at the one moment the platform *knows*
 * rather than *is told*: it authenticated a server-minted, per-host
 * `tacho_gateway_v1` credential and is about to serve the call. Enrollment
 * mints that credential and writes the host id into its scope, and
 * `create_api_key` refuses a caller-supplied reserved purpose, so the host the
 * observation is filed under is the server's own attribution throughout.
 *
 * Nothing a batch carries reaches this. The process in the P1 finding holds the
 * *local* OTLP bearer; the gateway credential never leaves the daemon.
 *
 * Null with no default. A host that has never had a gateway call authorised has
 * no observation, and no evidence must read as no evidence rather than as a
 * tier.
 */
export function gatewayObservationFor(host: GatewayObservable): Date | null {
  // `?? null`, not a bare read: a row fetched before this column existed, or a
  // projection that omits it, arrives `undefined`. Absent must land on the
  // no-evidence branch, never on a truthy object nobody can date.
  return host.gatewayLastSeenAt ?? null;
}

/**
 * The enforcement tier a session is recorded under.
 *
 * Derived from what the control plane observed, never from what the batch
 * says. Neither `attrs[oxagen.enforcement_tier]` nor the envelope's
 * `agent.enforcement_tier` is read for it — both are submitted, and the tier
 * exists precisely to separate what the platform enforced from what the agent
 * claims. A tier the agent can set is not a weaker version of that separation;
 * it is the absence of one, with a signature on top
 * (discussion_r4036718127, P1).
 *
 * `gateway` needs all three, and the first is the one that holds:
 *
 *  1. The control plane authorised a call on this host's gateway credential.
 *     Its own record, unreachable from any submission.
 *  2. The call was served for *this* chain, and this chain is the one it says
 *     it is. `chain` is the `tacho.gateway_chains` row matching the session's
 *     uuid, written where the gateway credential was authenticated — so the
 *     correlation is the server's too, not the batch's (#3221) — and its
 *     `genesisHash` must equal the session's own. The uuid alone is a NAME,
 *     which a forger holding the host's ingest key can write; the genesis hash
 *     is the hash of the daemon's own first sealed event, which it cannot.
 *  3. The chain the batch presents actually verifies. An unverified chain
 *     proves nothing about the hashes in it, and the genesis hash above is one
 *     of them — a forger who cannot produce the daemon's first event can still
 *     WRITE its hash into an event of their own, and only chain verification
 *     catches that.
 *
 * Otherwise the host's own mode decides, which is server-owned already: the
 * operator sets it in Oxagen and the daemon is told, not asked.
 *
 * ## Why there is no lifetime bound any more
 *
 * There used to be a fourth condition: the call must not predate the session's
 * `createdAt`. It existed when the correlation was a host-level timestamp with
 * no session on it, where "predates" was the only thing standing between a
 * stale observation and a chain it had nothing to do with.
 *
 * The genesis hash subsumes it, and keeping it was actively wrong. The control
 * plane records the call while HANDLING it; the daemon seals the corresponding
 * event only after the call returns. When those events are the chain's first
 * batch, `createdAt` is necessarily later than the record — so a chain whose
 * first gateway call precedes its first ingest failed the comparison at
 * genesis and kept failing it on every later batch, until some other gateway
 * call happened to advance `lastSeenAt`. If that first batch also sealed the
 * chain, the wrong tier was permanent.
 *
 * That is the failure this file has had twice before, in the direction that
 * does not announce itself: nothing is labelled `gateway`, and a silent
 * under-report of enforcement looks exactly like a quiet system. A record
 * bound to this exact chain by its genesis hash is about this chain whenever
 * it was written, so there is nothing left for an ordering to decide.
 *
 * ## What is no longer read
 *
 * `oxagen.enforcement_tier` on the batch. The daemon still writes it, because
 * it is true of the EVENT — that call really did come through the gateway, and
 * an operator reading the stream wants to see which ones did. It is not true of
 * the SESSION in any way the control plane can check, and a value that decides
 * a signed tier has to be one the control plane established itself.
 * `tacho-gateway-attribute.test.ts` fails if any handler reads it back.
 */
export function enforcementTierOf(
  chain: GatewayChainRecord | null,
  host: GatewayObservable,
  // Whether the chain the batch presents verifies. An unverified chain's
  // hashes are unproven, and the genesis hash the match turns on is one of
  // them.
  chainVerified: boolean,
  // Whether `tacho.sessions.gateway_observed_at` exists yet.
  //
  // `gateway` is never assigned without somewhere to write the observation
  // that justifies it (discussion_r4040750815). Migration 20260917140000 adds
  // the host column and the session column in two statements, so a run that
  // fails between them leaves a database that can derive the tier and cannot
  // record its evidence — and the tier is monotonic, so a session sealed in
  // that window would carry `gateway` with a null observation for good, with
  // no later batch able to repair it.
  //
  // Falling back to the host's own mode is the conservative answer and it is
  // self-correcting: the probe re-asks once a minute, and a session that was
  // not sealed meanwhile is promoted by the next batch, evidence and all.
  evidenceColumn: boolean,
  // This chain's OWN genesis hash: the session row's, or for a session being
  // created by this batch, the batch's first event. Null for a chain with none
  // — one whose first batch did not start at seq 0 — and null never matches.
  sessionGenesisHash: string | null,
  // Whether this session's verified chain holds a model call the host's
  // loopback proxy observed (ADR-094, ADR-095: "model and MCP requests seen by
  // the gateway for that run give `gateway`").
  //
  // This is the second road to `gateway`, and it stands on different evidence
  // from the first, so say which. The MCP road above is the control plane's own
  // record of a call it served. For model traffic no such record can exist:
  // the proxy's whole design is that the prompt goes from the machine to the
  // vendor and never to Oxagen, so the only witness is the daemon, and its
  // testimony is the frame it sealed. What makes that more than a claim is
  // that the chain verifies, so the frame is part of the hash-linked record
  // and not an attribute somebody set, and that `isObservedModelCall` requires
  // the collector's own source and fidelity, which a record posted through the
  // local OTLP endpoint cannot carry. It is host-attested, and the word
  // ADR-095 allows for it is exactly that narrow: "observed" metering and
  // "enforced" budgets on routed traffic, never "enforced" against the
  // machine's operator.
  //
  // It is computed from traffic. A host whose harness config has the base URL
  // written and whose run went around the proxy has no such frame, and stays
  // on the host's own mode.
  modelRouted = false,
): string {
  if (evidenceColumn && chainVerified && modelRouted) return TACHO_GATEWAY_TIER;
  const observed = gatewayObservationFor(host);
  if (
    evidenceColumn &&
    // The host has served a gateway call at all. Redundant with the
    // invocation row by construction — the same function writes both — and
    // kept as a belt, because the two are written by separate statements and a
    // deployment can be mid-migration on one and not the other.
    observed !== null &&
    chain !== null &&
    // The chain is the one it says it is. The NAME is something a forger
    // holding the host's ingest key can write too: open the session first with
    // a chain of its own and let a genuine gateway call advance `lastSeenAt`,
    // and the name, the lifetime and the host observation are all satisfied by
    // the row the forger created. The genesis hash is not — a chain that does
    // not begin with the daemon's own first event has a different one, and
    // producing a different chain with the same one is a preimage attack.
    //
    // Both sides must be present. A daemon too old to state its genesis, or a
    // session row that never recorded one, leaves the tier on the host's mode
    // rather than promoting on a name.
    chain.genesisHash !== null &&
    sessionGenesisHash !== null &&
    chain.genesisHash === sessionGenesisHash &&
    // …and the chain it came from verifies. Without this the match is on a
    // hash the batch simply asserts: a forger cannot produce the daemon's
    // first event, but nothing stops them writing its hash into an event of
    // their own, and only `verifyChain` rejects an event whose hash is not the
    // hash of its contents.
    chainVerified
  )
    return TACHO_GATEWAY_TIER;
  return host.mode === "enforce" ? "harness" : "observe";
}

/**
 * The human principal behind the host's enrollment: the row IAM resolves for
 * the host's API key (its creator, `packages/iam/src/fetch-authz.ts`) and the
 * operator the Run header prints (spec section 5.2: the human at the keyboard
 * is the `initiating_principal`). A host row with no recorded enroller, or an
 * enroller with no principal in this organization, attributes to nobody.
 */
async function enrollingPrincipalId(
  tx: Tx,
  ctx: Scope,
  host: TachoHostRow,
): Promise<string | null> {
  if (!host.createdById) return null;
  const principal = await tx.query.principals.findFirst({
    where: and(
      eq(schema.principals.orgId, ctx.orgId),
      eq(schema.principals.parentUserId, host.createdById),
      eq(schema.principals.kind, "human"),
    ),
    columns: { id: true },
  });
  return principal?.id ?? null;
}

/** The insert values for a session row seen for the first time. */
function genesisRow(
  host: TachoHostRow,
  ctx: Scope,
  initiatingPrincipalId: string | null,
  events: TachoEvent[],
  now: Date,
  // Whether `tacho.sessions.gateway_observed_at` exists yet. Naming a column
  // the database does not have fails the INSERT, so between deploy and
  // migration every new session would fail to open — for a field that is null
  // on all but the gateway tier (discussion_r4040352870).
  sessionGatewayColumn: boolean,
  // The tier this session opens on, and the gateway call that justifies it.
  //
  // Passed in rather than derived here. This function used to compute it a
  // second time, from the batch's own first hash, while the caller computed it
  // from `existing?.genesisHash` — which is null for a session being created.
  // The two disagreed for exactly the session this function is for: the row
  // was written `gateway` and the seal, computed from the caller's value, was
  // graded `observe`. A sealed session is never regraded, so exports and
  // attestations carried that pair for good.
  //
  // One derivation, one caller. There is nothing left to disagree.
  tier: string,
  gatewayObservedAt: Date | null,
  // The chain's own genesis, recorded on the row so a later batch can be
  // matched against it — and so the conflict guard (`landsOnThisChain`) checks
  // the same value this INSERT writes. Passed in for the same reason `tier` is:
  // the caller derives it to build that guard, and a second derivation here is
  // two values that have to agree.
  genesisHash: string | null,
) {
  const first = events[0] as TachoEvent;
  const genesis = events.find((event) => event.kind === "agent_start") ?? first;
  const body = genesis.body as Body;
  const context = genesis.context ?? {};
  const anthropic = genesis.anthropic ?? {};
  const subagent = genesis.subagent;
  const ingestedAt = new Date(first.ts);
  return {
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    sessionUuid: first.session_uuid,
    harnessSessionId: first.session_id,
    hostId: host.id,
    agentKey: first.agent.agent_key,
    // The registered agent the host enrolled as (enroll_host, #2967); null
    // for an operator-enrolled host.
    agentId: host.agentId,
    agentPrincipalId: host.agentPrincipalId,
    initiatingPrincipalId,
    rootSessionUuid: first.root_session_uuid,
    parentSessionUuid: first.parent_session_uuid ?? null,
    subagentId: subagent?.subagent_id ?? null,
    subagentType: subagent?.subagent_type ?? null,
    spawnDepth: subagent?.spawn_depth ?? 0,
    spawnToolUseId: subagent?.spawn_tool_use_id ?? null,
    anthropicUserIdHash: anthropic.user_id_hash ?? null,
    anthropicAccountUuid: anthropic.account_uuid ?? null,
    anthropicAccountId: anthropic.account_id ?? null,
    anthropicOrgUuid: anthropic.org_uuid ?? null,
    apiKeySource: anthropic.api_key_source ?? null,
    runtime: first.agent.runtime,
    harness: first.agent.harness,
    harnessVersion: batchHarnessVersion(events),
    wrapperVersion: first.agent.wrapper_version,
    entrypoint: context.entrypoint ?? null,
    querySourceInitial: context.query_source ?? null,
    terminalType: context.terminal_type ?? null,
    sessionKind: context.session_kind ?? null,
    isChildSession: genesis.host?.is_child_session ?? null,
    bridgeSessionId: genesis.host?.bridge_session_id ?? null,
    outputStyle: context.output_style ?? null,
    effort: context.effort ?? null,
    modelInitial: str(body["model"]) ?? context.model ?? null,
    permissionModeInitial: context.permission_mode ?? null,
    startType: str(body["session_start_source"]),
    startSource: str(body["session_start_source"]),
    startedAt: isNaN(ingestedAt.getTime()) ? now : ingestedAt,
    lastEventAt: now,
    cwd: context.cwd ?? null,
    projectDir: context.project_dir ?? null,
    transcriptPath: str(body["transcript_path"]),
    gitRemoteDigest: context.git_remote_digest ?? null,
    gitBranch: context.git_branch ?? null,
    gitHeadShaStart: context.git_head_sha ?? null,
    gitDirtyStart: context.git_dirty ?? null,
    worktreePath: context.worktree_path ?? null,
    worktreeBranch: context.worktree_branch ?? null,
    toolsAvailable: body["tools_available"] ?? null,
    mcpServers: body["mcp_servers"] ?? null,
    agentsAvailable: body["agents_available"] ?? null,
    skillsAvailable: body["skills_available"] ?? null,
    slashCommands: body["slash_commands"] ?? null,
    plugins: body["plugins"] ?? null,
    pluginErrors: body["plugin_errors"] ?? null,
    mcpServerErrors: body["mcp_server_errors"] ?? null,
    harnessCapabilities: body["harness_capabilities"] ?? null,
    settingsSources: body["settings_sources"] ?? null,
    hooksRegistered: body["hooks_registered"] ?? null,
    envSnapshot: body["env_snapshot"] ?? null,
    memoryPaths: body["memory_paths"] ?? null,
    enforcementTier: tier,
    // The evidence the tier stands on, written only when it is what raised
    // the row: a `gateway` session points at the observation that made it one.
    ...(sessionGatewayColumn
      ? {
          // The call that raised it, or nothing. A tier that is `gateway`
          // from the first row still has to point at what made it one.
          gatewayObservedAt,
        }
      : {}),
    bundleMode: host.mode,
    genesisHash,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * What reopening an idle-closed session writes: exactly the columns the
 * control plane's idle close set (`idleCloseColumns` in
 * `@oxagen/inngest-functions`), back to an open session's values.
 */
export const IDLE_CLOSE_UNDONE = {
  sealedAt: null,
  sealSource: null,
  outcome: "running",
  endedAt: null,
  finalHash: null,
  unobservedTail: false,
  completenessGaps: [],
  replayGrade: null,
} as const;

/**
 * What reopening a host-sealed session writes when its host starts the chain
 * again (ADR-172): the idle close's columns, plus the two reasons a host's
 * `agent_stop` records and the idle close does not.
 */
const HOST_SEAL_UNDONE = {
  ...IDLE_CLOSE_UNDONE,
  endReason: null,
  terminalReason: null,
} as const;

/**
 * The host started this chain again after its stop (ADR-172). A resumed
 * session's `SessionStart` hook seals an `agent_start`: Claude Code sends one
 * on `--resume`, and a background session sends one each time its process
 * comes back for the next message. The daemon seals one when any other hook
 * reopens a session its sweep closed for quiet. Nothing else seals an
 * `agent_start` on a chain that has already begun, so a late transcript line
 * or OTel record after the stop never counts.
 */
function isRestart(event: TachoEvent): boolean {
  return event.kind === "agent_start";
}

/**
 * Terminal facts from an `agent_stop`, when the batch carries one and does
 * not start the chain again after it.
 */
function terminalPatch(
  events: TachoEvent[],
  now: Date,
): Record<string, unknown> {
  let stop: TachoEvent | undefined;
  for (const event of events) {
    if (event.kind === "agent_stop") stop = event;
    // Stopped and then started again in one batch: the session is running.
    else if (stop !== undefined && isRestart(event)) stop = undefined;
  }
  if (!stop) return {};
  const body = stop.body as Body;
  const outcome = str(body["session_outcome"]);
  const patch: Record<string, unknown> = {
    endedAt: new Date(stop.ts),
    sealedAt: now,
    // The host's own end: final, unlike the control plane's idle close.
    sealSource: "agent_stop" satisfies TachoSealSource,
    finalHash: stop.hash,
    outcome:
      outcome === "completed" || outcome === "aborted" || outcome === "crashed"
        ? outcome
        : "unknown",
    endReason: str(body["session_end_reason"]),
    terminalReason: str(body["terminal_reason"]),
    unobservedTail: body["unobserved_tail"] === true,
  };
  const set = (key: string, value: unknown) => {
    if (value !== undefined && value !== null) patch[key] = value;
  };
  set(
    "isError",
    typeof body["is_error"] === "boolean" ? body["is_error"] : undefined,
  );
  set(
    "apiErrorStatus",
    typeof body["api_error_status"] === "number"
      ? body["api_error_status"]
      : undefined,
  );
  set(
    "durationMs",
    typeof body["duration_ms"] === "number" ? body["duration_ms"] : undefined,
  );
  set(
    "apiDurationWithoutRetriesMs",
    typeof body["api_duration_without_retries_ms"] === "number"
      ? body["api_duration_without_retries_ms"]
      : undefined,
  );
  set(
    "toolDurationMs",
    typeof body["tool_duration_ms_total"] === "number"
      ? body["tool_duration_ms_total"]
      : undefined,
  );
  set(
    "linesAdded",
    typeof body["lines_added"] === "number" ? body["lines_added"] : undefined,
  );
  set(
    "linesRemoved",
    typeof body["lines_removed"] === "number"
      ? body["lines_removed"]
      : undefined,
  );
  set(
    "hasUnknownModelCost",
    typeof body["has_unknown_model_cost"] === "boolean"
      ? body["has_unknown_model_cost"]
      : undefined,
  );
  set("modelsUsed", body["models_used"]);
  set("subagentStats", body["subagent_stats"]);
  set("permissionDenials", body["permission_denials"]);
  set(
    "completenessGaps",
    Array.isArray(body["completeness_gaps"])
      ? body["completeness_gaps"]
      : undefined,
  );
  set(
    "ttftFirstMs",
    typeof body["ttft_first_ms"] === "number"
      ? body["ttft_first_ms"]
      : undefined,
  );
  set("fastModeState", str(body["fast_mode_state"]));
  set("terminalReason", str(body["terminal_reason"]));
  if (typeof body["total_cost_usd_micros"] === "number")
    patch["totalCostMicrosAuthoritative"] = body["total_cost_usd_micros"];
  return patch;
}

// A batch whose own values Postgres refuses fails the same way on every retry,
// so it is answered as a refused input the shipper can bisect, never as a 500
// it retries for ever (`unstorableBatch` in ./lib/tacho-host.ts).
const promptDecoder = new TextDecoder("utf-8", { fatal: true });

/**
 * The first prompt this batch carries for each run, by root session uuid: the
 * retained body of the earliest `turn_start` on the run's own chain. A
 * subagent's prompt is written by the parent agent, not the operator, so it
 * never names the run. A body that is not UTF-8 text is skipped.
 */
export function firstRootPrompts(
  events: readonly TachoEvent[],
  bodies: readonly VerifiedBody[],
): Map<string, string> {
  const byEvent = new Map(bodies.map((body) => [body.eventIdIdem, body]));
  const first = new Map<string, { seq: number; text: string }>();
  for (const event of events) {
    if (event.kind !== "turn_start") continue;
    if (event.session_uuid !== event.root_session_uuid) continue;
    const body = byEvent.get(event.event_id_idem);
    if (body === undefined) continue;
    const seen = first.get(event.root_session_uuid);
    if (seen !== undefined && seen.seq <= event.seq) continue;
    let text: string;
    try {
      text = promptDecoder.decode(body.bytes);
    } catch {
      continue;
    }
    first.set(event.root_session_uuid, { seq: event.seq, text });
  }
  return new Map([...first].map(([root, { text }]) => [root, text]));
}

export const tachoEventsIngestHandler: CapabilityHandler<
  typeof tachoEventsIngest
> = (input, ctx) =>
  ingestBatch(input, ctx).catch((err: unknown) => {
    throw unstorableBatch("ingest_tacho_events", err) ?? err;
  });

const ingestBatch: CapabilityHandler<typeof tachoEventsIngest> = async (
  input,
  ctx,
) => {
  const now = new Date();
  const capability = "ingest_tacho_events";

  // The host before any write: the key must name a live host in this tenant
  // and every event must name that host. A batch the tenant refuses puts no
  // object in its store.
  const { host, retention } = await withTenantDb(async (tx) => {
    const host = await resolveEnrolledHost(
      capability,
      ctx,
      tx as never,
      input.host_enrollment_id,
    );
    // A frame the host's predecessor recorded and never shipped still names
    // the predecessor: the enrollment id sits inside the hashed event, so the
    // host cannot restate it. Those frames are accepted from a successor
    // (ADR-179) and from no other host.
    const eventHosts = input.events.map(
      (event) => event.agent.host_enrollment_id,
    );
    // An event that names no host has no predecessor to check, so it is
    // refused as the pre-succession check refused it.
    if (eventHosts.some((id) => id === undefined)) {
      throw tachoDenied(capability, "Forbidden: event names another host");
    }
    const foreign = [
      ...new Set(
        eventHosts.filter(
          (id): id is string => id !== undefined && id !== host.publicId,
        ),
      ),
    ];
    if (foreign.length > 0) {
      const predecessors = await readSuccessionHosts(tx, "publicId", foreign);
      if (
        foreign.some((id) => {
          const predecessor = predecessors.get(id);
          return predecessor === undefined || !succeedsHost(predecessor, host);
        })
      ) {
        throw tachoDenied(capability, "Forbidden: event names another host");
      }
    }
    // A session another host opened is refused here, before any of this
    // batch's bodies reach the tenant's store. The same refusal inside the
    // write transaction below stays as the guard of record; this one only
    // stops a refused batch from writing objects first.
    const named = [...new Set(input.events.map((event) => event.session_uuid))];
    const owners = (await tx
      .select({
        sessionUuid: schema.tachoSessions.sessionUuid,
        hostId: schema.tachoSessions.hostId,
        seqCount: schema.tachoSessions.seqCount,
        lastHash: schema.tachoSessions.lastHash,
      })
      .from(schema.tachoSessions)
      .where(inArray(schema.tachoSessions.sessionUuid, named))) as Array<{
      sessionUuid?: string;
      hostId?: string | null;
      seqCount?: number;
      lastHash?: string | null;
    }>;
    const held = owners.filter(
      (row) =>
        row.sessionUuid !== undefined &&
        named.includes(row.sessionUuid) &&
        row.hostId !== host.id,
    );
    const holders = await readSuccessionHosts(
      tx,
      "id",
      held.flatMap((row) => (row.hostId ? [row.hostId] : [])),
    );
    // A session a revoked predecessor opened passes here only on a batch
    // that continues its recorded chain, the same test the write below
    // applies, so a successor's refused batch writes no bodies either.
    if (
      held.some((row) => {
        const holder = row.hostId ? holders.get(row.hostId) : undefined;
        return (
          holder === undefined ||
          !succeedsHost(holder, host) ||
          !continuesRecordedChain(
            { seqCount: row.seqCount ?? 0, lastHash: row.lastHash ?? null },
            input.events.filter(
              (event) => event.session_uuid === row.sessionUuid,
            ),
          )
        );
      })
    ) {
      // The collector's Shipper matches this message to set the session
      // aside (`SESSION_OWNED_ELSEWHERE`), as it does the one below.
      throw tachoDenied(
        capability,
        "Forbidden: session belongs to another host",
      );
    }
    const retention = await readWorkspaceRetention(
      tx as never,
      ctx.orgId,
      ctx.workspaceId,
    );
    return { host, retention };
  });

  // A `proof.observed` body the run-evidence schema refuses. The frame is
  // still a link in the chain and is recorded like any other; only its
  // verdict row is not written, and the response says which frames were
  // refused. Refusing the whole batch at the input parse made the host
  // quarantine it, and the next batch then failed the dense-seq check, so the
  // session read `chain_verified = false` for the rest of its life.
  const proofRejections: Array<{ event_id_idem: string; reason: string }> = [];
  for (const event of input.events) {
    if (event.kind !== PROOF_OBSERVED_KIND) continue;
    const parsed = proofObservedBodySchema.safeParse(event.body);
    if (parsed.success) continue;
    const issue = parsed.error.issues[0];
    const what =
      issue === undefined
        ? "schema"
        : `${issue.path.join(".")} ${issue.message}`;
    proofRejections.push({
      event_id_idem: event.event_id_idem,
      reason: `proof_body_invalid: ${what}`.slice(0, 256),
    });
  }
  const refusedProofs = new Set(
    proofRejections.map((rejection) => rejection.event_id_idem),
  );

  // Bodies next: verified against the chain, then written content-addressed
  // before any row references them. A rejected body leaves its frame without
  // one; the seal records the gap.
  const verified = verifyBatchBodies(input.events, input.bodies);
  const bodyRejections: BodyRejection[] = [...verified.rejected];
  const retained: VerifiedBody[] = [];
  for (const body of verified.accepted) {
    // Both halves of the mandate bind here as they do on the host: the mode
    // says exact bytes may be kept at all, the classes say which content the
    // workspace authorised. `retainsBody` is the same rule the collector
    // applies before it writes, so a body can never be kept at one end and
    // refused at the other.
    if (retention.mode === "digest_only") {
      bodyRejections.push({
        event_id_idem: body.eventIdIdem,
        reason: "retention_digest_only",
      });
      continue;
    }
    if (!retainsBody(body.kind, retention)) {
      bodyRejections.push({
        event_id_idem: body.eventIdIdem,
        reason: "retention_class_excluded",
      });
      continue;
    }
    retained.push(body);
  }
  const bytesRefs = new Map<string, string>();
  // A few at a time, each bounded: a batch carries up to 200 bodies, and one
  // at a time with no bound held the request open for as long as the slowest
  // store answer took, however many there were. A write that runs out its
  // time fails the batch, which the host keeps and ships again.
  await eachConcurrently(retained, BODY_WRITE_CONCURRENCY, async (body) => {
    const { ref } = await withinTime(
      evidenceStore().put({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        runId: body.sessionUuid,
        digest: body.digest,
        contentType: body.contentType,
        bytes: body.bytes,
      }),
      BODY_WRITE_TIMEOUT_MS,
      "evidence body write",
    );
    bytesRefs.set(body.eventIdIdem, ref);
    // A recorded model stream is folded into the message it was HERE, once,
    // and stored beside the wire the row references. The bytes above are the
    // record and are untouched; the fold is derived, so a miss is reported
    // and never refuses the frame (spec §14).
    //
    // No call timing travels with it. The object is keyed by the body's
    // digest, so two calls with identical retained bytes share it, and this
    // frame's `ttft_ms` and `api_duration_ms` are already columns on its own
    // row — the transcript read lays them over the shared fold.
    const wrote = await writeAssembly(evidenceStore(), {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      runId: body.sessionUuid,
      bodyRef: ref,
      bytes: body.bytes,
    });
    if (wrote === "failed") {
      logger.warn(
        { eventIdIdem: body.eventIdIdem, kind: body.kind },
        "frame reassembly was not stored; the transcript will fold this frame on read",
      );
    }
  });

  // The operator's first prompt, for each run this batch opens. It names the
  // run in this transaction and starts its generated account right after the
  // append, so a new run is never listed by its uuid while it waits for the
  // enrichment sweep.
  const firstPrompts = firstRootPrompts(input.events, retained);

  const result = await withTenantDb(async (tx) => {
    const bySession = new Map<string, TachoEvent[]>();
    for (const event of input.events) {
      const list = bySession.get(event.session_uuid) ?? [];
      list.push(event);
      bySession.set(event.session_uuid, list);
    }

    const chainBreaks: Array<{
      session_uuid: string;
      at_seq: number;
      reason: string;
    }> = [];
    const verified = new Map<string, boolean>();
    // The head each session had before this batch: events below it are
    // re-sent rows.
    const recordedHeads = new Map<string, number>();
    // What the batch changed about spend: the cost its sessions added, and
    // the root sessions it sealed. The cost goes to the spend counter at the
    // end of this transaction. The sealed roots are acted on after it.
    let batchSpendMicros = 0n;
    const rollupRoots: string[] = [];
    // Each sealed root session this batch touched, by session uuid. A re-send
    // that finds its frames missing from ClickHouse is the retry of an append
    // that failed, and the seal dispatch that attempt never sent is sent now.
    const sealedRoots = new Map<string, string>();
    // The root session of each chain this batch landed model or tool frames
    // on, by root session uuid. A subagent's frames are its root's cost, so
    // the root is what is rolled up. Resolved to open roots after the loop.
    const progressedRootUuids = new Set<string>();
    // Every root the batch's chains belong to, and the ones a subagent's
    // fresh frames reported for: those are open again if the control plane
    // closed them for silence.
    const batchRootUuids = new Set<string>();
    const subagentReportedRootUuids = new Set<string>();
    // The batch's fresh `proof.observed` frames, by the root session they belong to.
    const proofsByRoot = new Map<string, TachoEvent[]>();
    // Who each session's tool calls are billed to, read off the rows this
    // transaction wrote. The ledger entries are built after the commit, from
    // every event in the batch (see the billing step below).
    const attribution = new Map<string, ToolCallAttribution>();
    // The rows name the root session by uuid; the run a person opens is the
    // root's public id. Collected here, resolved once after the loop.
    const rootUuids = new Map<string, string>();
    let newSessions = 0;
    // The first root session this batch opened: the run the onboarding gate
    // records when this is the organization's first frame (#2967).
    let firstOpenedRunId: string | null = null;
    // Resolved on the first genesis row of the batch; every session a host
    // opens has the same operator, and a batch of continuations never asks.
    let initiatingPrincipalId: string | null | undefined;
    // Asked once for the whole batch rather than per session: the answer is
    // per-process and cached, and a batch cannot straddle a migration it holds
    // a transaction across.
    const sessionGatewayColumn = await sessionGatewayColumnReady(tx, true);
    // The two columns this branch adds, asked the same way and for the same
    // window. Probed separately from each other because one migration adds
    // both and a run that fails between its two statements leaves exactly the
    // half-applied state an inference would get wrong.
    const pushesColumn = await sessionPushesColumnReady(tx, true);
    const machineColumn = await sessionMachineSnapshotColumnReady(tx, true);
    const observedStatusColumn = await sessionFileObservedStatusColumnReady(
      tx,
      true,
    );
    // Which of this batch's chains the control plane's own records say it
    // served a gateway call for (#3221). One grouped read for the whole batch,
    // and skipped entirely when no promotion is possible — including while
    // `tacho.gateway_chains` is still an unapplied migration, where
    // naming the table would raise 42P01 and abort the transaction.
    const gatewayInvocations = await gatewayInvocationsFor(
      tx,
      host,
      [...bySession.keys()],
      await gatewayInvocationColumnReady(tx, true),
    );

    const containedLaunches = await containedLaunchesFor(tx, host.id, [
      ...bySession.keys(),
    ]);

    for (const [sessionUuid, events] of bySession) {
      events.sort((a, b) => a.seq - b.seq);
      const first = events[0] as TachoEvent;
      batchRootUuids.add(first.root_session_uuid);
      const last = events[events.length - 1] as TachoEvent;
      const existing = await tx.query.tachoSessions.findFirst({
        where: eq(schema.tachoSessions.sessionUuid, sessionUuid),
        columns: {
          id: true,
          seqCount: true,
          lastHash: true,
          chainVerified: true,
          hostId: true,
          telemetryGapCount: true,
          numToolCalls: true,
          contentFrames: true,
          bodyFrames: true,
          toolBodyFrames: true,
          enforcementTier: true,
          sealedAt: true,
          // Whether that seal is the host's or the control plane's idle
          // close, which the next event overrules.
          sealSource: true,
          // What the chain proved it was when it opened. The gateway states
          // the same hash on every call, and a tier rises only when the two
          // agree (#3221).
          genesisHash: true,
          // `observed` once the host's model proxy has metered this session,
          // which is what stops its self-reported usage being counted too.
          costBasis: true,
          // The session's own server-clock birth. A gateway call the control
          // plane served before this chain existed is not evidence about it.
          createdAt: true,
        },
      });
      // The collector's Shipper matches this message to set the session
      // aside instead of retrying it (`SESSION_OWNED_ELSEWHERE` in
      // packages/tacho/src/collector/spool.ts). Change both together.
      //
      // The one exception is a successor (ADR-179): a later enrollment of the
      // same machine in the same workspace, whose predecessor is revoked,
      // carrying the session on from its recorded head. The write below
      // moves the session to it, and only while the predecessor still holds it.
      let succeeds = false;
      if (existing && existing.hostId !== host.id) {
        const holder = existing.hostId
          ? (await readSuccessionHosts(tx, "id", [existing.hostId])).get(
              existing.hostId,
            )
          : undefined;
        if (
          holder === undefined ||
          !succeedsHost(holder, host) ||
          !continuesRecordedChain(existing, events)
        ) {
          throw tachoDenied(
            capability,
            "Forbidden: session belongs to another host",
          );
        }
        succeeds = true;
      }

      let ok = true;
      let breakSeq: number | null = null;
      let reason = "";
      const internal = verifyChain(events, { expectGenesis: first.seq === 0 });
      if (!internal.ok) {
        ok = false;
        breakSeq = first.seq;
        reason = internal.violations[0] ?? "chain verification failed";
      }
      // A re-send repeats rows already accepted (idempotent under the
      // (session_uuid, seq) key). Only the events past the recorded head are
      // new: they alone move the counters, the head and the seal, so a retried
      // batch never counts a frame twice.
      const fresh = existing
        ? events.filter((event) => event.seq >= existing.seqCount)
        : events;
      const head = fresh[0];
      // A successor takes the session only with frames past the recorded
      // head, which must link to it. A batch of re-sent frames alone proves
      // nothing about the head: `compareResent` judges those after the
      // commit, too late to undo a move. The re-send is still accepted, since
      // a spool that never saw its answer sends the same batch again.
      const moves = succeeds && fresh.length > 0;
      if (existing) {
        if (first.seq > existing.seqCount) {
          ok = false;
          breakSeq = first.seq;
          reason = `seq ${first.seq} follows recorded seq ${existing.seqCount - 1}: the sequence must be dense`;
        } else if (
          head &&
          existing.lastHash !== null &&
          head.prev_hash !== existing.lastHash
        ) {
          ok = false;
          breakSeq = head.seq;
          reason = `seq ${head.seq} prev_hash does not match the recorded chain head`;
        }
        if (!existing.chainVerified) ok = false;
      } else if (first.seq !== 0) {
        ok = false;
        breakSeq = first.seq;
        reason = `first observed event has seq ${first.seq}, not 0`;
      }
      verified.set(sessionUuid, ok);
      recordedHeads.set(sessionUuid, existing?.seqCount ?? 0);
      if (!ok && breakSeq !== null)
        chainBreaks.push({
          session_uuid: sessionUuid,
          at_seq: breakSeq,
          reason,
        });

      // Observed metering takes precedence over self-reported metering for
      // the same calls, so a session routed through the proxy counts once.
      const counted = usageCountedEvents(
        fresh,
        existing?.costBasis === TACHO_METERING_OBSERVED,
      );
      const firstObserved = fresh.find(isObservedModelCall);
      const delta = emptyDelta();
      for (const event of counted) foldDelta(delta, event);
      const contentFrames = countContentFrames(fresh);
      const freshIds = new Set(fresh.map((event) => event.event_id_idem));
      const freshBodies = retained.filter(
        (body) =>
          body.sessionUuid === sessionUuid && freshIds.has(body.eventIdIdem),
      );
      const bodyFrames = freshBodies.length;
      const toolBodyFrames = freshBodies.filter(
        (body) => body.kind === "tool_call",
      ).length;
      // The tier this batch leaves the session on, derived once from the
      // control plane's own records so the row and the seal cannot disagree
      // and neither is read off the batch (discussion_r4036718127, P1).
      //
      // A rise to `gateway` is allowed — a daemon chain opens long before the
      // first connected app calls anything, so the tier genuinely becomes true
      // later — but only on evidence Oxagen itself holds, and never after the
      // seal. A sealed session's tier is final: its replay grade was computed
      // from it and signed into the attestation, and a value that moves
      // underneath a signature is the escalation, not the mislabel.
      const chainRecord = gatewayInvocations.get(sessionUuid) ?? null;
      // The chain's genesis hash: the recorded one, or — for a session this
      // batch is opening — the batch's own first event. Resolved HERE, because
      // this value feeds both the row and the seal and deriving it twice is
      // how they came to disagree.
      //
      // `existing ? … : …` rather than `existing?.genesisHash ?? …`. A row that
      // exists and recorded no genesis is answered with NOTHING, not with a
      // hash off the batch. Those are different questions: the recorded value
      // is what the row can be checked against afterwards, and a batch's
      // re-sent seq-0 event is not written back to it — so promoting on one
      // would leave a `gateway` row whose `genesis_hash` is null, pointing at
      // evidence nobody can re-derive. That is the failure this whole
      // correlation exists to end, one level in.
      //
      // Rows predating this feature are the reachable case, not a hypothetical:
      // they carry a null `genesis_hash` and a true `chain_verified`, and
      // whether they promote would otherwise depend on whether some later batch
      // happened to re-send seq 0. They stay on the host's own mode instead,
      // which is the same degradation a daemon too old to state its genesis
      // gets.
      const sessionGenesisHash = existing
        ? existing.genesisHash
        : first.seq === 0
          ? first.hash
          : null;
      const gatewayTier = enforcementTierOf(
        chainRecord,
        host,
        ok,
        sessionGatewayColumn,
        sessionGenesisHash,
        firstObserved !== undefined,
      );
      const derivedTier = containedTierOf(
        gatewayTier,
        containedLaunches.get(sessionUuid),
        sessionGenesisHash,
      );
      // What a `gateway` tier stands on: the control plane's record of a
      // served MCP call, or the first model call the proxy observed.
      const gatewayEvidenceAt =
        chainRecord?.at ??
        (firstObserved !== undefined ? new Date(firstObserved.ts) : null);
      // The control plane's idle close (`tacho.session-idle-close`) is an
      // inference from silence, not the host's word, so it is not final: this
      // batch's `agent_stop` replaces it with the host's own seal, and any
      // other new frame reopens the session. Nothing was signed on the
      // strength of the close that a later seal could contradict, so the tier
      // may still rise under it.
      const idleClosed =
        !!existing?.sealedAt && existing.sealSource === "idle_timeout";
      // A host's seal holds against every later frame but one: the host
      // starting the chain again (ADR-172). Claude Code resumes a session
      // under the id it ended with, so its chain carries on past the stop,
      // and one session stays one run. An operator's seal stays final
      // (ADR-169). A row sealed before `seal_source` existed reads as the
      // host's.
      const resumed =
        !!existing?.sealedAt &&
        (existing.sealSource === "agent_stop" ||
          existing.sealSource === null) &&
        fresh.some(isRestart);
      const openExisting =
        existing && (idleClosed || resumed)
          ? { ...existing, sealedAt: null }
          : existing;
      const effectiveTier = promotedTier(openExisting, derivedTier);
      const promoteToGateway =
        existing !== undefined && effectiveTier !== existing.enforcementTier;
      // The grade is computed once, at seal: a sealed session is sealed
      // again only after something reopened it.
      const terminal = openExisting?.sealedAt ? {} : terminalPatch(fresh, now);
      const { totalCostMicrosAuthoritative, ...terminalColumns } =
        terminal as Record<string, unknown> & {
          totalCostMicrosAuthoritative?: number;
        };
      if (terminal["sealedAt"] !== undefined) {
        const seal = sealTachoSession({
          hostGaps: Array.isArray(terminalColumns["completenessGaps"])
            ? (terminalColumns["completenessGaps"] as string[])
            : [],
          chainVerified: ok,
          unobservedTail: terminalColumns["unobservedTail"] === true,
          telemetryGapCount:
            (existing?.telemetryGapCount ?? 0) + delta.telemetryGapCount,
          retentionMode: retention.mode,
          contentFrames: (existing?.contentFrames ?? 0) + contentFrames,
          bodyFrames: (existing?.bodyFrames ?? 0) + bodyFrames,
          toolCalls: (existing?.numToolCalls ?? 0) + delta.numToolCalls,
          toolBodyFrames: (existing?.toolBodyFrames ?? 0) + toolBodyFrames,
          // Derived, not declared. This used to fall through to
          // `first.agent.enforcement_tier` — the envelope field, which the
          // submitter fills — so a claimed tier was signed into the replay
          // grade that the export bundle and the attestation carry.
          enforcementTier: effectiveTier,
        });
        terminalColumns["completenessGaps"] = seal.completenessGaps;
        terminalColumns["replayGrade"] = seal.replayGrade;
      }
      // New frames on an idle-closed session with no stop among them: the
      // session was not over. Undo exactly what the close wrote
      // (`idleCloseColumns` in @oxagen/inngest-functions). A resumed session
      // undoes the host's seal the same way, and its stop's reasons with it.
      const reopen =
        fresh.length > 0 && terminal["sealedAt"] === undefined
          ? resumed
            ? HOST_SEAL_UNDONE
            : idleClosed
              ? IDLE_CLOSE_UNDONE
              : {}
          : {};
      const tail = fresh.at(-1);
      const latest = lastRecordedContext(fresh);
      const harnessVersion = batchHarnessVersion(fresh);
      const increments = {
        numTurns: sql`${schema.tachoSessions.numTurns} + ${delta.numTurns}`,
        numPrompts: sql`${schema.tachoSessions.numPrompts} + ${delta.numPrompts}`,
        numModelCalls: sql`${schema.tachoSessions.numModelCalls} + ${delta.numModelCalls}`,
        numApiErrors: sql`${schema.tachoSessions.numApiErrors} + ${delta.numApiErrors}`,
        numToolCalls: sql`${schema.tachoSessions.numToolCalls} + ${delta.numToolCalls}`,
        numToolErrors: sql`${schema.tachoSessions.numToolErrors} + ${delta.numToolErrors}`,
        numToolRejections: sql`${schema.tachoSessions.numToolRejections} + ${delta.numToolRejections}`,
        numSubagents: sql`${schema.tachoSessions.numSubagents} + ${delta.numSubagents}`,
        numCompactions: sql`${schema.tachoSessions.numCompactions} + ${delta.numCompactions}`,
        numModelSwitches: sql`${schema.tachoSessions.numModelSwitches} + ${delta.numModelSwitches}`,
        numNotifications: sql`${schema.tachoSessions.numNotifications} + ${delta.numNotifications}`,
        numElicitations: sql`${schema.tachoSessions.numElicitations} + ${delta.numElicitations}`,
        inputTokens: sql`${schema.tachoSessions.inputTokens} + ${delta.inputTokens}`,
        outputTokens: sql`${schema.tachoSessions.outputTokens} + ${delta.outputTokens}`,
        cacheReadTokens: sql`${schema.tachoSessions.cacheReadTokens} + ${delta.cacheReadTokens}`,
        cacheCreationTokens: sql`${schema.tachoSessions.cacheCreationTokens} + ${delta.cacheCreationTokens}`,
        cacheCreation5mTokens: sql`${schema.tachoSessions.cacheCreation5mTokens} + ${delta.cacheCreation5mTokens}`,
        cacheCreation1hTokens: sql`${schema.tachoSessions.cacheCreation1hTokens} + ${delta.cacheCreation1hTokens}`,
        thinkingTokens: sql`${schema.tachoSessions.thinkingTokens} + ${delta.thinkingTokens}`,
        webSearchRequests: sql`${schema.tachoSessions.webSearchRequests} + ${delta.webSearchRequests}`,
        webFetchRequests: sql`${schema.tachoSessions.webFetchRequests} + ${delta.webFetchRequests}`,
        totalCostMicros:
          totalCostMicrosAuthoritative !== undefined
            ? totalCostMicrosAuthoritative
            : sql`${schema.tachoSessions.totalCostMicros} + ${delta.totalCostMicros}`,
        policyDecisions: sql`${schema.tachoSessions.policyDecisions} + ${delta.policyDecisions}`,
        policyDenies: sql`${schema.tachoSessions.policyDenies} + ${delta.policyDenies}`,
        telemetryGapCount: sql`${schema.tachoSessions.telemetryGapCount} + ${delta.telemetryGapCount}`,
        contentFrames: sql`${schema.tachoSessions.contentFrames} + ${contentFrames}`,
        bodyFrames: sql`${schema.tachoSessions.bodyFrames} + ${bodyFrames}`,
        toolBodyFrames: sql`${schema.tachoSessions.toolBodyFrames} + ${toolBodyFrames}`,
        filesRead: sql`${schema.tachoSessions.filesRead} + ${delta.filesRead}`,
        filesWritten: sql`${schema.tachoSessions.filesWritten} + ${delta.filesWritten}`,
        filesDeleted: sql`${schema.tachoSessions.filesDeleted} + ${delta.filesDeleted}`,
        commandsRun: sql`${schema.tachoSessions.commandsRun} + ${delta.commandsRun}`,
        networkCalls: sql`${schema.tachoSessions.networkCalls} + ${delta.networkCalls}`,
        commits: sql`${schema.tachoSessions.commits} + ${delta.commits}`,
        // Skipped while the column is unmigrated. Every other counter here
        // is on a column that has shipped, so naming this one before its
        // migration lands would raise 42703 and refuse the whole batch —
        // ingestion stopped outright, on a host still reporting healthy.
        ...(pushesColumn
          ? {
              pushes: sql`${schema.tachoSessions.pushes} + ${delta.pushes}`,
            }
          : {}),
        pullRequests: sql`${schema.tachoSessions.pullRequests} + ${delta.pullRequests}`,
      };
      const machineSnapshot = machineColumn
        ? machineSnapshotOf(fresh)
        : undefined;
      const common = {
        ...(machineSnapshot === undefined ? {} : { machineSnapshot }),
        lastEventAt: now,
        seqCount: sql`GREATEST(${schema.tachoSessions.seqCount}, ${last.seq + 1})`,
        chainVerified: ok,
        ...(ok ? {} : { chainBreakAtSeq: breakSeq }),
        ...(tail
          ? {
              lastHash: tail.hash,
              // Each fact moves only when the batch recorded one. Writing the
              // tail frame's value unconditionally cleared the model and the
              // permission mode whenever a batch ended on a frame with no
              // context, and the Run header then read them as not recorded.
              ...(latest.model === null ? {} : { modelFinal: latest.model }),
              ...(latest.permissionMode === null
                ? {}
                : { permissionModeFinal: latest.permissionMode }),
              ...(latest.gitHeadSha === null
                ? {}
                : { gitHeadShaEnd: latest.gitHeadSha }),
              // The genesis row takes effort and the first permission mode
              // from its own frame. A session whose genesis carried neither
              // gets them from the first batch that does.
              ...(latest.effort === null
                ? {}
                : {
                    effort: sql`COALESCE(${schema.tachoSessions.effort}, ${latest.effort})`,
                  }),
              // The same for the harness version, which the genesis frame of
              // a hook-opened session never carries.
              ...(harnessVersion === null
                ? {}
                : {
                    harnessVersion: sql`COALESCE(${schema.tachoSessions.harnessVersion}, ${harnessVersion})`,
                  }),
              ...(latest.permissionMode === null
                ? {}
                : {
                    permissionModeInitial: sql`COALESCE(${schema.tachoSessions.permissionModeInitial}, ${latest.permissionMode})`,
                  }),
            }
          : {}),
        // The rise to `gateway`, on every batch rather than only the one that
        // opened the chain.
        //
        // A gateway call joins the daemon's long-lived `tachod-*` chain, whose
        // genesis row was written when the daemon started and long before any
        // connected app called anything. Computing the tier at insert alone
        // therefore never reached the row: the existing-session branch applies
        // this patch and nothing else.
        //
        // What changed. The condition was once `carriesGatewayCall(events)` on
        // its own — an attribute in the batch, which a process holding the
        // local OTLP bearer can set on an ordinary record — so a later
        // submission could promote an existing observe session retroactively,
        // and exports then signed the tier. #3178 gated that rise on the
        // control plane's own host observation; #3221 replaced the remaining
        // client-attested half, which said WHICH session, with a server record
        // of the chain the gateway was serving. Both halves are now Oxagen's
        // own, still bounded to the session's lifetime and still refused
        // outright once the session is sealed.
        //
        // Monotonic still. Once a chain has served a connected app that fact
        // does not stop being true, so a later batch of daemon bookkeeping must
        // not demote it back to the host's mode.
        ...(promoteToGateway
          ? {
              enforcementTier: effectiveTier,
              // What raised it. A tier that rose must point at the evidence.
              // Guarded on the column's presence in its own right rather than
              // leaning on `promoteToGateway` being unreachable without the
              // host column: that coupling holds today and is invisible to
              // anyone changing either half.
              ...(sessionGatewayColumn
                ? { gatewayObservedAt: gatewayEvidenceAt }
                : {}),
            }
          : {}),
        ...(firstObserved !== undefined
          ? { costBasis: TACHO_METERING_OBSERVED }
          : {}),
        updatedAt: now,
        ...reopen,
        ...terminalColumns,
        ...increments,
      };

      // Identity is still enforced, and not by a predicate here.
      //
      // The INSERT no longer updates anything, so there is no conflict clause
      // left to guard. On the existing-session path the question is asked where
      // it belongs: `enforcementTierOf` promotes only when the gateway record's
      // genesis hash equals the ROW'S own, so a chain wearing another's uuid
      // cannot be promoted — and its frames fail chain verification against the
      // recorded head, which is reported as a chain break.
      // Whether this batch's writes landed, and whether they opened the
      // session. Decided by the statement on BOTH paths: on neither is the row
      // this transaction writes necessarily the row it read.
      let accepted: boolean;
      let inserted = false;
      if (existing) {
        // The row must still be where the read left it.
        //
        // `fresh` — and everything folded from it: the delta, the content and
        // body counts, the seal and the grade computed from them — is derived
        // from `existing.seqCount`, a head read under no lock. A concurrent
        // batch for the same session advances that head between the read and
        // this statement, and then both transactions fold the SAME frames:
        // every counter on the row is applied twice, and a row the first one
        // sealed is written again by the second, whose `terminalPatch` was
        // computed against an unsealed read.
        //
        // That is not an adversarial case. The daemon's spool re-sends a batch
        // whose response it did not see, so a retry overlapping an in-flight
        // original is the ordinary way it happens, and the two carry identical
        // frames.
        //
        // `seq_count` is written only here and only ever forward, so matching
        // it IS the question "is this still the row `fresh` was computed
        // against". A refusal costs one round trip: the batch is re-sent by the
        // daemon's spool, and the next read sees the real head.
        //
        // The TIER has to be matched too, and separately, because it is the one
        // piece of tier-relevant state that moves WITHOUT the head. A
        // promotion-only re-send — same frames, already recorded, so no new
        // seq — raises `enforcement_tier` and leaves `seq_count` exactly where
        // this batch read it. A concurrent terminal batch that derived
        // `observe` then still matches the head, and writes an observe-derived
        // `replayGrade` onto a row that is now `gateway`: the sealed tier and
        // the signed grade disagree, and a sealed session is never regraded.
        //
        // `common`'s grade is computed from `effectiveTier`, which is computed
        // from `existing.enforcementTier` — so matching the tier is the same
        // question as matching the head, asked of the other input.
        const written = await tx
          .update(schema.tachoSessions)
          .set(moves ? { ...common, hostId: host.id } : common)
          .where(
            and(
              eq(schema.tachoSessions.id, existing.id),
              eq(schema.tachoSessions.seqCount, existing.seqCount),
              // A session moves to a successor only from the host that held
              // it when this batch read it.
              ...(moves && existing.hostId
                ? [eq(schema.tachoSessions.hostId, existing.hostId)]
                : []),
              eq(
                schema.tachoSessions.enforcementTier,
                existing.enforcementTier,
              ),
              // The idle close moves the seal without moving the head. A close
              // that committed after this batch's read would otherwise take
              // these frames without the reopen they owe it, and leave a
              // session that is plainly running reading as closed. Refused,
              // the batch is re-sent and its next read reopens the session.
              //
              // An operator's `seal_run` (#4073) also moves the seal without
              // moving the head, and it can land on an idle-closed row. A
              // batch that read the idle close computed a reopen, which would
              // undo a seal that is final. So the batch writes only while the
              // idle close it read still stands. Refused, the batch is
              // re-sent and its next read sees the operator's seal.
              //
              // A resume undoes the host's seal it read, and only that one.
              ...(existing.sealedAt
                ? idleClosed
                  ? [
                      eq(
                        schema.tachoSessions.sealSource,
                        "idle_timeout" satisfies TachoSealSource,
                      ),
                    ]
                  : resumed
                    ? [
                        existing.sealSource === null
                          ? isNull(schema.tachoSessions.sealSource)
                          : eq(
                              schema.tachoSessions.sealSource,
                              "agent_stop" satisfies TachoSealSource,
                            ),
                      ]
                    : []
                : [isNull(schema.tachoSessions.sealedAt)]),
            ),
          )
          .returning({ id: schema.tachoSessions.id });
        accepted = written.length > 0;
      } else {
        if (initiatingPrincipalId === undefined)
          initiatingPrincipalId = await enrollingPrincipalId(tx, ctx, host);
        const row = genesisRow(
          host,
          ctx,
          initiatingPrincipalId,
          events,
          now,
          sessionGatewayColumn,
          derivedTier,
          gatewayTier === TACHO_GATEWAY_TIER ? gatewayEvidenceAt : null,
          sessionGenesisHash,
        );
        const written = await tx
          .insert(schema.tachoSessions)
          .values({
            ...row,
            ...(machineSnapshot === undefined ? {} : { machineSnapshot }),
            ...terminalColumns,
            ...(firstObserved !== undefined
              ? { costBasis: TACHO_METERING_OBSERVED }
              : {}),
            chainVerified: ok,
            chainBreakAtSeq: ok ? null : breakSeq,
            lastHash: last.hash,
            seqCount: last.seq + 1,
          } as typeof schema.tachoSessions.$inferInsert)
          // DO NOTHING, not DO UPDATE.
          //
          // The conflict path used to apply a `common` computed from
          // `existing` — the read that preceded the INSERT, which says nothing
          // about the row this statement is now hitting. Every attempt to make
          // that safe added another predicate and another way to be half
          // right: it doubled the counters (`common` already carries
          // `increments`, and the follow-up applied them again), and on the
          // branch that dropped the seal it still advanced `seq_count` through
          // the `agent_stop`, putting the stop below the recorded head so that
          // even a re-send folded `fresh = []` and the session could never be
          // sealed by anyone.
          //
          // There is nothing this statement can safely write to a row it has
          // not read. So it writes nothing: the INSERT either opens the
          // session or does nothing at all, and a conflict is refused and
          // retried. The retry reads the row and takes the existing-session
          // path, which has the real values and its own guards — which is
          // where a decision about an existing row belongs.
          .onConflictDoNothing()
          // RETURNING, or there is nothing to read. An INSERT without it yields
          // no rows through postgres-js even when it inserted, so `written`
          // would be empty for EVERY new session — each one refused, rolled
          // back, and retried for ever. Named rather than bare, like every
          // other RETURNING in this file: a bare one asks for every column the
          // schema declares and fails on a pending migration
          // (`tacho-column-projection.test.ts`).
          .returning({ id: schema.tachoSessions.id });
        // `DO NOTHING` returns a row only when it inserted one, so the two
        // questions have one answer here.
        accepted = written.length > 0;
        inserted = accepted;
        if (inserted) newSessions += 1;
        // Counters on a fresh row start from the insert's zero defaults, so
        // the delta is applied here. Only on a real insert: a conflict wrote
        // nothing, so there is nothing of this batch's on that row to complete.
        if (inserted) {
          await tx
            .update(schema.tachoSessions)
            .set(increments)
            .where(eq(schema.tachoSessions.sessionUuid, sessionUuid));
        }
      }
      // Refused, on either path: the row this batch hit moved under the read
      // its frames were folded against, or the INSERT lost to a row it has not
      // read. Both are transient — the same batch succeeds against a fresh
      // read — so the whole attempt is rolled back and the daemon re-sends.
      //
      // Thrown INSIDE the transaction, and that is the point. Raising it after
      // the commit left the accepted half of a mixed batch committed while the
      // response never reached the daemon: control commands were marked `sent`
      // and could not be selected again, and the accepted sessions' spend
      // deltas were skipped — and on the retry their heads had advanced, so the
      // deltas folded empty and the spend was undercounted for good.
      //
      // `conflict` maps to 409: neither `ControlUnreachable` nor the 400/422
      // the shipper quarantines on, so it takes the "keep the batch, back off"
      // branch (`spool.ts`) and the next attempt reads the rows as they now
      // are. At most one retry: a conflict on the INSERT path means the row
      // exists, so the retry takes the existing-session path.
      if (!accepted) {
        throw new HandlerError({
          code: "conflict",
          reason: "session_moved_under_read",
          message: `session ${sessionUuid} changed between this batch's read and its write; re-send it`,
        });
      }

      const sessionRow = await tx.query.tachoSessions.findFirst({
        where: eq(schema.tachoSessions.sessionUuid, sessionUuid),
        columns: {
          id: true,
          publicId: true,
          parentSessionUuid: true,
          rootSessionUuid: true,
          harness: true,
          initiatingPrincipalId: true,
        },
      });
      const sessionId = sessionRow?.id;
      if (sessionRow) {
        attribution.set(sessionUuid, {
          harness: sessionRow.harness ?? null,
          agentId: null,
          principalId: host.agentPrincipalId ?? null,
          principalKind: host.agentPrincipalId ? "agent" : null,
          operatorUserId: sessionRow.initiatingPrincipalId ?? null,
          runId:
            sessionRow.parentSessionUuid == null
              ? (sessionRow.publicId ?? null)
              : null,
        });
        if (sessionRow.parentSessionUuid != null && sessionRow.rootSessionUuid)
          rootUuids.set(sessionUuid, sessionRow.rootSessionUuid);
      }
      // `inserted`, not `accepted && !existing`: a conflict that took the update
      // path is accepted and still did not open the session, and `!existing` is
      // the read that preceded the statement.
      if (
        sessionRow?.publicId &&
        inserted &&
        firstOpenedRunId === null &&
        first.parent_session_uuid == null
      ) {
        firstOpenedRunId = sessionRow.publicId;
      }
      // Everything below is this batch's events landing on the session row, so
      // it is gated on the same answer. A refused batch belongs to a different
      // chain or to a session already sealed; its models, files, commands,
      // proof frames and spend are not that session's evidence, and counting
      // them is the same defect as the counters were.
      if (sessionId && accepted) {
        await rollupModels(tx, ctx, sessionId, counted, now);
        await rollupFiles(tx, ctx, sessionId, fresh, now, observedStatusColumn);
        await rollupCommands(tx, ctx, sessionId, fresh, now);
        await refreshSessionTitle(
          tx,
          ctx,
          sessionId,
          fresh,
          now,
          observedStatusColumn,
        );
        await refreshHarnessTitle(tx, sessionId, fresh);
      }
      if (accepted) {
        for (const event of fresh) {
          if (event.kind !== PROOF_OBSERVED_KIND) continue;
          if (refusedProofs.has(event.event_id_idem)) continue;
          const frames = proofsByRoot.get(event.root_session_uuid) ?? [];
          frames.push(event);
          proofsByRoot.set(event.root_session_uuid, frames);
        }
        if (delta.totalCostMicros > 0)
          batchSpendMicros += BigInt(delta.totalCostMicros);
        // A reopen asks too, whatever the batch carried: the run's row was
        // rebuilt at the close and reads final until it is rebuilt open.
        if (
          delta.numModelCalls > 0 ||
          delta.numToolCalls > 0 ||
          delta.totalCostMicros > 0 ||
          "sealedAt" in reopen
        )
          progressedRootUuids.add(first.root_session_uuid);
        if (fresh.length > 0 && first.root_session_uuid !== sessionUuid)
          subagentReportedRootUuids.add(first.root_session_uuid);
      }
      if (
        accepted &&
        sessionRow &&
        sessionRow.parentSessionUuid === null &&
        "sealedAt" in terminalColumns
      )
        rollupRoots.push(sessionRow.publicId);
      if (
        accepted &&
        sessionRow?.publicId &&
        sessionRow.parentSessionUuid === null &&
        (existing?.sealedAt || "sealedAt" in terminalColumns)
      )
        sealedRoots.set(sessionUuid, sessionRow.publicId);
    }

    // Every session in the batch has its row now, so a root the batch opened
    // resolves. A root sealed before the verdict already has its cost row and
    // is rebuilt to carry it. Each witness run the rows name is rebuilt too:
    // its row names the worker's operator only once a verdict row links it to
    // the worker, and it usually sealed before that.
    for (const [rootSessionUuid, frames] of proofsByRoot) {
      const root = await tx.query.tachoSessions.findFirst({
        where: and(
          eq(schema.tachoSessions.orgId, ctx.orgId),
          eq(schema.tachoSessions.workspaceId, ctx.workspaceId),
          eq(schema.tachoSessions.sessionUuid, rootSessionUuid),
          isNull(schema.tachoSessions.parentSessionUuid),
        ),
        columns: { publicId: true, sealedAt: true },
      });
      if (!root)
        throw new HandlerError({
          code: "conflict",
          reason: "root_session_unrecorded",
          message: `proof frames name root session ${rootSessionUuid}, which this workspace has not recorded`,
        });
      // Attempts are numbered in the order the frames were observed, across
      // the root's chain and its subagents' chains.
      frames.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
      const proofs = await recordProofFrames(
        tx,
        { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
        root.publicId,
        frames,
      );
      if (proofs.written > 0 && root.sealedAt) rollupRoots.push(root.publicId);
      rollupRoots.push(...proofs.witnessRunIds);
    }

    // A run is one piece of work across its chains. When a subagent reports,
    // a root the control plane closed for silence was not done, so it is
    // reopened too, conditional on the close still standing.
    for (const rootSessionUuid of subagentReportedRootUuids) {
      const reopened = await tx
        .update(schema.tachoSessions)
        .set({ ...IDLE_CLOSE_UNDONE, updatedAt: now })
        .where(
          and(
            eq(schema.tachoSessions.orgId, ctx.orgId),
            eq(schema.tachoSessions.workspaceId, ctx.workspaceId),
            eq(schema.tachoSessions.sessionUuid, rootSessionUuid),
            isNull(schema.tachoSessions.parentSessionUuid),
            eq(
              schema.tachoSessions.sealSource,
              "idle_timeout" satisfies TachoSealSource,
            ),
          ),
        )
        .returning({ id: schema.tachoSessions.id });
      if (reopened.length > 0) progressedRootUuids.add(rootSessionUuid);
    }

    // The public id of every root the batch touched. An open root's row is
    // its running estimate. A root this batch sealed is left to
    // `cost/run.sealed`. A root sealed earlier is rolled up again too: a
    // subagent's chain, or a harness that carried on after the daemon's sweep
    // sealed it, can land frames after the seal's rollup, and nothing else
    // would ever count them. One read per root, like the proof loop above: a
    // batch names one or two.
    const rootIds = new Map<string, string>();
    for (const rootSessionUuid of batchRootUuids) {
      const root = await tx.query.tachoSessions.findFirst({
        where: and(
          eq(schema.tachoSessions.orgId, ctx.orgId),
          eq(schema.tachoSessions.workspaceId, ctx.workspaceId),
          eq(schema.tachoSessions.sessionUuid, rootSessionUuid),
          isNull(schema.tachoSessions.parentSessionUuid),
        ),
        columns: { publicId: true },
      });
      if (root) rootIds.set(rootSessionUuid, root.publicId);
    }

    // Name each run whose first prompt this batch carries, and remember it so
    // its account is requested once the frames are in ClickHouse. Only a run
    // with no name and no account yet: an operator's own name, a harness
    // title the model already replaced, and a re-sent batch all leave it be.
    // The workspace setting is read once, and only when a prompt is in hand.
    // A workspace with enrichment off keeps the place-derived title.
    const promptedRuns: string[] = [];
    let enrichmentEnabled: boolean | undefined;
    for (const [rootSessionUuid, prompt] of firstPrompts) {
      const runId = rootIds.get(rootSessionUuid);
      if (runId === undefined) continue;
      if (enrichmentEnabled === undefined) {
        // `run.enrich` refuses an archived workspace and one with the setting
        // off, so a request it would refuse is not sent.
        const workspace = await tx.query.workspaces.findFirst({
          where: and(
            eq(schema.workspaces.id, ctx.workspaceId),
            eq(schema.workspaces.orgId, ctx.orgId),
          ),
          columns: { settings: true, archivedAt: true },
        });
        enrichmentEnabled =
          workspace !== undefined &&
          workspace.archivedAt == null &&
          runEnrichmentEnabled(workspace.settings);
      }
      if (!enrichmentEnabled) break;
      const unnamed = and(
        eq(schema.tachoSessions.orgId, ctx.orgId),
        eq(schema.tachoSessions.workspaceId, ctx.workspaceId),
        eq(schema.tachoSessions.sessionUuid, rootSessionUuid),
        isNull(schema.tachoSessions.parentSessionUuid),
        isNull(schema.tachoSessions.name),
        isNull(schema.tachoSessions.summary),
      );
      const row = await tx.query.tachoSessions.findFirst({
        where: unnamed,
        columns: {
          name: true,
          summary: true,
          gitBranch: true,
          worktreeBranch: true,
        },
      });
      if (row === undefined || row.name != null || row.summary != null)
        continue;
      const title = fallbackRunTitle(
        prompt,
        row.worktreeBranch ?? row.gitBranch,
      );
      // `updated_at` is left alone: the title is not input to the account,
      // and moving it would make the sweep queue the run a second time.
      if (title !== null)
        await tx
          .update(schema.tachoSessions)
          .set({ name: title })
          .where(unnamed);
      promptedRuns.push(runId);
    }
    const sealedThisBatch = new Set(rollupRoots);
    const progressRoots = [...progressedRootUuids].flatMap((uuid) => {
      const runId = rootIds.get(uuid);
      return runId === undefined || sealedThisBatch.has(runId) ? [] : [runId];
    });

    if (newSessions > 0) {
      await tx
        .update(schema.tachoHosts)
        .set({
          sessionsCount: sql`${schema.tachoHosts.sessionsCount} + ${newSessions}`,
        })
        .where(eq(schema.tachoHosts.id, host.id));
    }
    // The organization's first frame opens the onboarding gate (mockup
    // obUnlock: the agent and its run exist from this moment). Guarded on the
    // row's step, so only the first batch to land writes it.
    if (firstOpenedRunId !== null) {
      const unlocked = await unlockOnboardingGate(tx, {
        orgId: ctx.orgId,
        runPublicId: firstOpenedRunId,
        agentId: host.agentId,
        now,
      });
      if (unlocked) {
        logger.info(
          {
            orgId: ctx.orgId,
            workspaceId: ctx.workspaceId,
            runId: firstOpenedRunId,
            agentId: host.agentId,
          },
          "tacho.events.ingest: first frame received — onboarding gate unlocked",
        );
      }
    }
    // The ledger attribution the loop could not finish from one row: the run a
    // subagent session belongs to is its root's, and the agent is named by its
    // registry public id when the host enrolled as a registered agent, so a
    // tool call Tacho recorded and an action the kernel recorded for the same
    // agent group together. Read only when the batch has something to bill.
    if (input.events.some(isBillableToolCall)) {
      const rootRuns = new Map<string, string | null>();
      for (const root of new Set(rootUuids.values())) {
        const row = await tx.query.tachoSessions.findFirst({
          where: and(
            eq(schema.tachoSessions.sessionUuid, root),
            isNull(schema.tachoSessions.parentSessionUuid),
          ),
          columns: { publicId: true },
        });
        rootRuns.set(root, row?.publicId ?? null);
      }
      const agent = host.agentId
        ? await tx.query.agents.findFirst({
            where: eq(schema.agents.id, host.agentId),
            columns: { publicId: true },
          })
        : undefined;
      const agentId = agent?.publicId ?? host.agentKey;
      for (const [sessionUuid, entry] of attribution) {
        const root = rootUuids.get(sessionUuid);
        attribution.set(sessionUuid, {
          ...entry,
          agentId,
          runId:
            root === undefined ? entry.runId : (rootRuns.get(root) ?? null),
        });
      }
    }
    const seen = await touchHost(tx as never, host, input.daemon, now, true);
    // The batch's cost reaches the spend-budget counter in this transaction
    // (#3825). If the counter write fails, the whole batch rolls back and the
    // host sends it again. Nothing the cost was folded from committed, so the
    // retry computes the same cost and counts it once. A committed batch
    // folds its re-sent frames as already recorded (`fresh = []`), which is
    // why a counter write made after the commit, once lost, was never made
    // again. This is the last write here, so the counter row stays locked for
    // the shortest time. The batch counts on the UTC day of this request.
    // For an organisation on a dedicated plane, `recordSpend` writes the
    // shared-plane counter in its own transaction before this one commits
    // (ADR-042 §2), so a failed write still rolls the batch back.
    if (batchSpendMicros > 0n) {
      await recordSpend(
        {
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          at: now,
          micros: batchSpendMicros,
        },
        tx,
      );
    }
    // The control envelope is NOT built here. Building it drains the host's
    // queued commands and marks them `sent`, and this transaction commits
    // before the ClickHouse append below. An append that failed after the
    // commit answered the host a 500 or a 503: the commands never reached it,
    // and a `sent` row is offered again only once its redelivery lease runs
    // out (`drainCommands`).
    return {
      chainBreaks,
      verified,
      recordedHeads,
      seen,
      rollupRoots,
      attribution,
      sealedRoots,
      progressRoots,
      rootIds,
      promptedRuns,
    };
  });

  // Every event this batch re-sends below a session's recorded head is
  // compared with the frame ClickHouse holds at that seq (§8.3). The same
  // hash is a frame already landed: it is not written again, so a re-send
  // never restamps a stored row. A different hash is another frame claiming a
  // position the chain already holds: it is refused and reported as a chain
  // break, and the stored frame stands, sealed or not. A seq ClickHouse does
  // not hold is the retry of an append that failed after the Postgres commit,
  // and it is written.
  //
  // The read reaches the same node the append below does, and it is on the
  // retry path by construction, so a refusal here is answered as a refusal
  // too, or the second attempt 500s one call earlier than the first (#3662).
  let resent: ResentVerdicts;
  try {
    resent = await compareResent(input.events, result.recordedHeads);
  } catch (err) {
    refuseIfStoreOverloaded(err, ctx, input.events.length);
    throw err;
  }
  // Nothing derived from `event.anthropic` is stored. The producer chooses that
  // block, so any stable value computed from it and readable back would be an
  // oracle: submit the hash of a guessed address, read the result, compare it
  // to a colleague's row. The session's person is `initiatingPrincipalId` /
  // `initiatingUserId`, which this deployment issues rather than the harness
  // reports (#3072).
  const inserts: TachoEventInsert[] = input.events
    .filter(
      (event) =>
        !resent.landed.has(event.event_id_idem) &&
        !resent.refused.has(event.event_id_idem),
    )
    .map((event) => {
      const bytesRef = bytesRefs.get(event.event_id_idem);
      return {
        event,
        chainVerified: result.verified.get(event.session_uuid) ?? false,
        ...(bytesRef === undefined ? {} : { bytesRef }),
      };
    });
  try {
    await insertTachoEvents(inserts);
  } catch (err) {
    // A store refusing this write under pressure is answered as a refusal,
    // with a wait. Everything else is the fault it looks like (#3662).
    refuseIfStoreOverloaded(err, ctx, inserts.length);
    logger.error(
      {
        err,
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        accepted: inserts.length,
      },
      "tacho.events.ingest: append failed",
    );
    throw err;
  }

  // The seal event goes out after the batch's frames are in ClickHouse: the
  // rollup job reads tacho_events as soon as it receives the event, and the
  // sweep does not revisit a run whose rollup postdates its seal.
  //
  // A re-send that wrote a sealed root's missing `agent_stop` is the retry of
  // an append that failed, and that attempt sent no seal event. Its own fold
  // saw the stop as already recorded, so without this nothing would send one.
  const rollupRoots = new Set(result.rollupRoots);
  for (const event of input.events) {
    if (event.kind !== "agent_stop") continue;
    if (!resent.missing.has(event.event_id_idem)) continue;
    const root = result.sealedRoots.get(event.session_uuid);
    if (root !== undefined) rollupRoots.add(root);
  }
  for (const runId of rollupRoots) {
    try {
      await eventClient.send({
        name: "cost/run.sealed",
        data: { runId, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      });
    } catch (err) {
      logger.error(
        { err, runId },
        "tacho.events.ingest: cost/run.sealed dispatch failed; the nightly sweep rolls the run up",
      );
    }
  }

  // A run's cost is rolled up as it goes, and reads as an estimate until it
  // seals (#3980). Sent after the append for the reason the seal event is,
  // and debounced per run by `cost.run-progress`, so one event per batch is
  // what the sender owes. Best-effort like the seal: a run whose event is lost
  // is rolled up by its next batch, or at its seal. Sent before billing: a
  // billing failure fails the request, and the re-sent batch folds no new
  // frames, so an event owed by this attempt would otherwise never go out.
  // A second event for the same run is harmless; the job is debounced.
  //
  // A re-send that wrote model or tool frames ClickHouse was missing is the
  // retry of an append that failed, and that attempt sent no progress event.
  // Its fold saw the frames as already recorded, so the delta was empty.
  const progressRoots = new Set(result.progressRoots);
  for (const event of input.events) {
    if (event.kind !== "llm_call" && event.kind !== "tool_call") continue;
    if (!resent.missing.has(event.event_id_idem)) continue;
    const runId = result.rootIds.get(event.root_session_uuid);
    if (runId !== undefined && !rollupRoots.has(runId))
      progressRoots.add(runId);
  }
  if (progressRoots.size > 0) {
    try {
      await eventClient.send(
        [...progressRoots].map((runId) => ({
          name: RUN_PROGRESSED_EVENT,
          data: { runId, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
        })),
      );
    } catch (err) {
      logger.warn(
        { err, runIds: [...progressRoots] },
        "tacho.events.ingest: cost/run.progressed dispatch failed; the next batch or the seal rolls the run up",
      );
    }
  }

  // A run's account starts from its first prompt, as soon as that prompt's
  // frames are in ClickHouse, where `run.enrich` reads them. The id holds for
  // the run's life, so a re-sent batch or a second prompt-bearing batch asks
  // once. Best-effort like the events above: a lost request is picked up by
  // the enrichment sweep within five minutes.
  if (result.promptedRuns.length > 0) {
    try {
      await eventClient.send(
        result.promptedRuns.map((runPublicId) => ({
          name: RUN_ENRICH_EVENT,
          id: `run-enrich:first-prompt:${runPublicId}`,
          data: {
            orgId: ctx.orgId,
            workspaceId: ctx.workspaceId,
            runPublicId,
          },
        })),
      );
    } catch (err) {
      logger.warn(
        { err, runIds: result.promptedRuns },
        "tacho.events.ingest: run/enrich dispatch failed; the enrichment sweep summarizes the run",
      );
    }
  }

  // Billing: one governed action unit per allowed tool call (ADR-165). Run
  // after every write above, so a charge never lands for a frame the record
  // does not hold, and before the control envelope, for the reason given
  // there.
  //
  // Built from EVERY event in the batch, not only the fresh ones. `fresh` is
  // what this batch added past the recorded head, and after a failure here
  // the host re-sends a batch whose events are all below it. Billing only
  // fresh events would bill that re-send nothing, and the calls would never
  // be charged. The ledger key makes the whole batch safe to offer again: a
  // key already on the ledger inserts nothing and debits nothing.
  //
  // A failure here fails the request, and that is the durable choice. The
  // host's WAL cursor moves only on a 2xx, so it keeps the batch and ships it
  // again after its backoff. Everything this handler wrote is safe to write
  // twice: the session counters fold only frames past the recorded head, the
  // ClickHouse append keeps the newest row per seq, a body is stored by its
  // digest, the spend counter and the seal event were handled on the first
  // attempt, and the ledger dedups the charge. The one write that was not
  // safe, the control commands marked `sent`, now happens after this step.
  // Accepting the batch and logging instead would lose the charge for good
  // whenever the billing store blinked.
  //
  // The recording is never refused for a lack of units. `recordGovernedActions`
  // debits whatever the bucket holds, and an exhausted prepaid organisation is
  // refused at its next server-side action by the admission gate, not here.
  const billable = tachoToolCallEntries(
    input.events,
    (sessionUuid) => result.attribution.get(sessionUuid),
    { workspaceId: ctx.workspaceId, requestId: ctx.requestId ?? null, now },
  );
  if (billable.length > 0) {
    try {
      await recordGovernedActions({
        orgId: ctx.orgId,
        entries: billable,
        label: "tacho:tool_calls",
      });
    } catch (err) {
      logger.error(
        {
          err,
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          toolCalls: billable.length,
          alert: "tacho_tool_call_billing_failed",
        },
        "tacho.events.ingest: tool-call billing failed; the batch is refused so the host re-sends it, and the ledger bills each call once",
      );
      throw err;
    }
  }

  // The control envelope last, in its own transaction. Draining marks the
  // host's queued commands `sent`, and a `sent` row is offered again only once
  // its redelivery lease runs out (`drainCommands`). Drained inside the ingest
  // transaction, a failure after the commit (the ClickHouse append, the
  // billing step) left commands marked `sent` in a response the host never
  // received: a pause or a steer held back for that lease. Drained here, any
  // earlier failure leaves them queued, and the re-sent batch delivers them.
  const control = await withTenantDb((tx) =>
    controlEnvelope(tx as never, ctx, result.seen, new Date()),
  );

  return {
    accepted: input.events.length,
    event_ids: input.events.map((event) => event.event_id_idem),
    chain_breaks: [...result.chainBreaks, ...resent.breaks],
    body_rejections: bodyRejections,
    ...(proofRejections.length > 0
      ? { proof_rejections: proofRejections }
      : {}),
    control,
  };
};

/** Bodies written to the evidence store at once. */
const BODY_WRITE_CONCURRENCY = 8;
/** How long one body write may take before the batch is failed and re-sent. */
const BODY_WRITE_TIMEOUT_MS = 30_000;

/** Run `fn` over `items`, at most `limit` at once; rejects on the first failure. */
async function eachConcurrently<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await fn(items[index] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
}

/** `work`, or a rejection once `ms` have passed without an answer. */
async function withinTime<T>(
  work: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} took longer than ${ms} ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** What `compareResent` found about a batch's re-sent events, by `event_id_idem`. */
interface ResentVerdicts {
  /** Stored with the same hash: already landed, not written again. */
  landed: Set<string>;
  /** Stored with another hash: refused. */
  refused: Set<string>;
  /** Below the recorded head and not stored: the retry of a failed append. */
  missing: Set<string>;
  /** One chain break per refused event. */
  breaks: Array<{ session_uuid: string; at_seq: number; reason: string }>;
}

/**
 * Compare each event below its session's recorded head with the frame
 * ClickHouse holds at that seq. One read per session that re-sent anything,
 * of the hash, the content digest and the body reference only.
 */
async function compareResent(
  events: readonly TachoEvent[],
  recordedHeads: ReadonlyMap<string, number>,
): Promise<ResentVerdicts> {
  const out: ResentVerdicts = {
    landed: new Set(),
    refused: new Set(),
    missing: new Set(),
    breaks: [],
  };
  const bySession = new Map<string, TachoEvent[]>();
  for (const event of events) {
    const head = recordedHeads.get(event.session_uuid) ?? 0;
    if (event.seq >= head) continue;
    const list = bySession.get(event.session_uuid) ?? [];
    list.push(event);
    bySession.set(event.session_uuid, list);
  }
  for (const [sessionUuid, resent] of bySession) {
    const stored = await selectTachoStoredFrames({
      sessionUuid,
      seqs: resent.map((event) => event.seq),
    });
    for (const event of resent) {
      const row = stored.get(event.seq);
      if (row === undefined) {
        out.missing.add(event.event_id_idem);
      } else if (row.hash === event.hash) {
        out.landed.add(event.event_id_idem);
      } else {
        out.refused.add(event.event_id_idem);
        out.breaks.push({
          session_uuid: sessionUuid,
          at_seq: event.seq,
          reason: `seq ${event.seq} was re-sent with a hash other than the recorded frame's; the recorded frame stands`,
        });
      }
    }
  }
  return out;
}

/**
 * Answer a store that is refusing work as a refusal, or return and let the
 * caller treat the failure as the fault it is.
 *
 * The distinction is the whole of #3662. A ClickHouse node over its memory
 * limit, at its concurrent-query limit, or behind on its merges is refusing
 * for a reason this batch had no part in, and it accepts the same bytes once
 * the pressure passes. Thrown on, `store_overloaded` leaves the route as a 503
 * with a `Retry-After`; the raw error leaves it as a 500, which the host reads
 * as a server fault and ships the batch straight back into.
 *
 * Nothing is lost on either path. The host's WAL cursor advances only on a
 * 2xx, so a refused batch stays on disk, and a re-sent batch writes every
 * event ClickHouse does not yet hold, which is how a ClickHouse failure after
 * the Postgres commit recovers (see `compareResent`). What the refusal
 * changes is when the host tries again.
 */
function refuseIfStoreOverloaded(
  err: unknown,
  ctx: Scope,
  events: number,
): void {
  const overloaded = storeOverloadedFrom(err);
  if (overloaded === null) return;
  // Warn, not error: a store asking for room is a condition to wait out, and
  // logging it as a fault buries the faults this level is read for.
  logger.warn(
    {
      err,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      events,
      store: overloaded.store,
      retryAfterSeconds: overloaded.retryAfterSeconds,
    },
    "tacho.events.ingest: the store refused this batch under pressure; the host keeps it and ships it again",
  );
  throw overloaded;
}

type Tx = Parameters<Parameters<typeof withTenantDb>[0]>[0];
type Scope = { orgId: string; workspaceId: string };

async function rollupModels(
  tx: Tx,
  ctx: Scope,
  sessionId: string,
  events: TachoEvent[],
  now: Date,
): Promise<void> {
  const byModel = new Map<
    string,
    {
      requests: number;
      input: number;
      output: number;
      cacheRead: number;
      cacheCreation: number;
      thinking: number;
      cost: number;
      duration: number;
      canonical: string | null;
      provider: string | null;
    }
  >();
  for (const event of events) {
    if (event.kind !== "llm_call") continue;
    const body = event.body as Body;
    const model = str(body["model"]);
    if (!model) continue;
    const entry = byModel.get(model) ?? {
      requests: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
      thinking: 0,
      cost: 0,
      duration: 0,
      canonical: null,
      provider: null,
    };
    if (countsLlmCallUsage(event)) {
      entry.requests += 1;
      entry.input += num(body["input_tokens"]);
      entry.output += num(body["output_tokens"]);
      entry.cacheRead += num(body["cache_read_tokens"]);
      entry.cacheCreation += num(body["cache_creation_tokens"]);
      entry.cost += num(body["cost_usd_micros"]);
      entry.duration += num(body["api_duration_ms"]);
    }
    if (countsLlmCallSplit(event) || isObservedModelCall(event))
      entry.thinking += num(body["thinking_tokens"]);
    entry.canonical = entry.canonical ?? str(body["canonical_model"]);
    entry.provider = entry.provider ?? str(body["provider"]);
    byModel.set(model, entry);
  }
  for (const [model, entry] of byModel) {
    await tx
      .insert(schema.tachoSessionModels)
      .values({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        sessionId,
        model,
        canonicalModel: entry.canonical,
        provider: entry.provider,
        requests: entry.requests,
        inputTokens: entry.input,
        outputTokens: entry.output,
        cacheReadTokens: entry.cacheRead,
        cacheCreationTokens: entry.cacheCreation,
        thinkingTokens: entry.thinking,
        costMicros: entry.cost,
        apiDurationMs: entry.duration,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          schema.tachoSessionModels.sessionId,
          schema.tachoSessionModels.model,
        ],
        set: {
          requests: sql`${schema.tachoSessionModels.requests} + ${entry.requests}`,
          inputTokens: sql`${schema.tachoSessionModels.inputTokens} + ${entry.input}`,
          outputTokens: sql`${schema.tachoSessionModels.outputTokens} + ${entry.output}`,
          cacheReadTokens: sql`${schema.tachoSessionModels.cacheReadTokens} + ${entry.cacheRead}`,
          cacheCreationTokens: sql`${schema.tachoSessionModels.cacheCreationTokens} + ${entry.cacheCreation}`,
          thinkingTokens: sql`${schema.tachoSessionModels.thinkingTokens} + ${entry.thinking}`,
          costMicros: sql`${schema.tachoSessionModels.costMicros} + ${entry.cost}`,
          apiDurationMs: sql`${schema.tachoSessionModels.apiDurationMs} + ${entry.duration}`,
          updatedAt: now,
        },
      });
  }
}

/**
 * Re-derive the run's title from what the record now shows.
 *
 * It runs on every accepted batch rather than at seal, because a name that
 * arrives when the run ends is no use to someone watching the run. The
 * model-authored `name` and `summary` that `summarize_run` writes are the
 * better read once they exist; this is what the list shows until then, and
 * for every workspace recording `digest_only`, which that capability refuses
 * outright.
 *
 * Derived from place and counts, never from prompt text, so it says the same
 * thing at every retention setting. The place comes off the batch's own
 * events rather than a re-read of the session row: the facts are already in
 * hand, and a transaction does not need another round trip to learn them.
 */
async function refreshSessionTitle(
  tx: Tx,
  ctx: Scope,
  sessionId: string,
  events: TachoEvent[],
  now: Date,
  // As in `rollupFiles`: the observed half of the file count is only asked
  // for once the column exists. Before then the title counts the attested
  // writes alone, which is what it counted before that column was added.
  observedStatusColumn: boolean,
): Promise<void> {
  const place = events.find(
    (event) =>
      event.context?.cwd !== undefined ||
      event.context?.project_dir !== undefined ||
      event.context?.worktree_path !== undefined,
  )?.context;
  const branch = events.find((event) => event.context?.git_branch !== undefined)
    ?.context?.git_branch;
  if (place === undefined && branch === undefined) return;

  const [files, commands] = await Promise.all([
    tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.tachoSessionFiles)
      .where(sessionChangedFilesWhere(sessionId, observedStatusColumn)),
    tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.tachoSessionCommands)
      .where(eq(schema.tachoSessionCommands.sessionId, sessionId)),
  ]);

  const title = deriveSessionTitle({
    projectDir: place?.project_dir ?? null,
    cwd: place?.cwd ?? null,
    worktreePath: place?.worktree_path ?? null,
    gitBranch: branch ?? null,
    filesChanged: Number(files[0]?.count ?? 0),
    commandsRun: Number(commands[0]?.count ?? 0),
  });
  if (title === undefined) return;
  await tx
    .update(schema.tachoSessions)
    .set({ title, updatedAt: now })
    .where(eq(schema.tachoSessions.id, sessionId));
}

/**
 * Store the latest title the harness gave the session (`harness-title.ts`).
 * The update keeps a stored title whose frame is newer, so a batch that
 * arrives late cannot bring back an older name. It leaves `updated_at` alone:
 * the title is not input to the run's generated account.
 */
async function refreshHarnessTitle(
  tx: Tx,
  sessionId: string,
  events: TachoEvent[],
): Promise<void> {
  const latest = latestHarnessTitle(events);
  if (latest === null) return;
  await tx
    .update(schema.tachoSessions)
    .set({ harnessTitle: latest.title, harnessTitleAt: latest.at })
    .where(
      and(
        eq(schema.tachoSessions.id, sessionId),
        or(
          isNull(schema.tachoSessions.harnessTitleAt),
          lte(schema.tachoSessions.harnessTitleAt, latest.at),
        ),
      ),
    );
}

async function rollupCommands(
  tx: Tx,
  ctx: Scope,
  sessionId: string,
  events: TachoEvent[],
  now: Date,
): Promise<void> {
  for (const event of events) {
    if (event.kind !== "command") continue;
    const body = event.body as Body;
    const target = str(body["tool_target"]);
    if (!target) continue;
    await tx
      .insert(schema.tachoSessionCommands)
      .values({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        sessionId,
        seq: event.seq,
        toolUseId: str(body["tool_use_id"]),
        commandDigest:
          str(body["tool_input_digest"]) ?? `sha256:${"0".repeat(64)}`,
        commandHead: target,
        bashCommand: target.split(/\s+/, 1)[0] ?? null,
        durationMs:
          typeof body["tool_duration_ms"] === "number"
            ? body["tool_duration_ms"]
            : null,
        status: str(body["tool_status"]),
        cwd: event.context?.cwd ?? null,
        decision: str(body["policy_decision"]),
        decisionSource: str(body["tool_decision_source"]),
        policyRule: str(body["policy_rule"]),
        createdAt: now,
      })
      .onConflictDoNothing({
        target: [
          schema.tachoSessionCommands.sessionId,
          schema.tachoSessionCommands.seq,
        ],
      });
  }
}
