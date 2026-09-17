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
// What lands: every event in ClickHouse `tacho_events`; the session rows,
// per-model rollups, files touched, and commands run in Postgres; the host's
// liveness; and the control envelope in the response. A batch that carried
// cost adds it to the spend-budget counter (ADR-060 §5), and an `agent_stop`
// on a root session emits `cost/run.sealed` so the rollup job rebuilds the
// run's `cost.run_totals` row from its frames (ADR-060 §3).
//
// Proof (ADR-064): each fresh `proof.observed` frame writes its verdict row
// (lib/proof.ts) under the run it is part of, the root session named by its
// `root_session_uuid`, whichever session's chain carried it. A verdict reaching
// a root sealed before it asks the rollup for the run's row again, so the row
// carries it.
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
import { HandlerError } from "@oxagen/oxagen/handler-error";
import { PROOF_OBSERVED_KIND } from "@oxagen/run-evidence";
import {
  TACHO_GATEWAY_TIER,
  type TachoEvent,
  verifyChain,
} from "@oxagen/tacho";
import {
  insertTachoEvents,
  selectTachoEvents,
  type TachoEventInsert,
} from "@oxagen/telemetry";
import { recordSpend } from "@oxagen/billing";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { evidenceStore } from "@oxagen/run-ledger/evidence-store";
import { unlockOnboardingGate } from "./lib/onboarding";
import {
  gatewayInvocationColumnReady,
  sessionGatewayColumnReady,
} from "./lib/tacho-gateway-columns";
import { eventClient } from "./event-client";
import { recordProofFrames } from "./lib/proof";
import {
  type TachoHostRow,
  controlEnvelope,
  readWorkspaceRetention,
  resolveEnrolledHost,
  tachoDenied,
  touchHost,
} from "./lib/tacho-host";
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
  };
}

/** Fold one event into the session's counters. Model usage counts only the OTel log view. */
export function foldDelta(delta: SessionDelta, event: TachoEvent): void {
  const body = event.body as Body;
  switch (event.kind) {
    case "turn_start":
      delta.numTurns += 1;
      delta.numPrompts += 1;
      break;
    case "llm_call":
      if (
        event.source === "otel_log" ||
        event.source === "collector" ||
        event.source === "hook"
      ) {
        delta.numModelCalls += 1;
        delta.inputTokens += num(body["input_tokens"]);
        delta.outputTokens += num(body["output_tokens"]);
        delta.cacheReadTokens += num(body["cache_read_tokens"]);
        delta.cacheCreationTokens += num(body["cache_creation_tokens"]);
        delta.totalCostMicros += num(body["cost_usd_micros"]);
      }
      if (event.source === "transcript") {
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
      break;
    case "network":
      delta.networkCalls += 1;
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
): string {
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
    harnessVersion: first.agent.harness_version ?? null,
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
 * `common` with the seal taken back out.
 *
 * Used on the INSERT's conflict path by a batch that did not derive `gateway`:
 * it cannot know whether the row it is conflicting with is on a higher tier, so
 * a `replayGrade` computed from its own tier must not land. Everything else in
 * `common` — the head, the counters, the terminal facts' siblings — is safe,
 * because none of it is signed.
 */
function withoutTerminal(
  common: Record<string, unknown>,
  terminalColumns: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...common };
  for (const key of Object.keys(terminalColumns)) delete out[key];
  return out;
}

/** Terminal facts from an `agent_stop`, when the batch carries one. */
function terminalPatch(
  events: TachoEvent[],
  now: Date,
): Record<string, unknown> {
  const stop = [...events]
    .reverse()
    .find((event) => event.kind === "agent_stop");
  if (!stop) return {};
  const body = stop.body as Body;
  const outcome = str(body["session_outcome"]);
  const patch: Record<string, unknown> = {
    endedAt: new Date(stop.ts),
    sealedAt: now,
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

export const tachoEventsIngestHandler: CapabilityHandler<
  typeof tachoEventsIngest
> = async (input, ctx) => {
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
    if (
      input.events.some(
        (event) => event.agent.host_enrollment_id !== host.publicId,
      )
    ) {
      throw tachoDenied(capability, "Forbidden: event names another host");
    }
    const retention = await readWorkspaceRetention(
      tx as never,
      ctx.orgId,
      ctx.workspaceId,
    );
    return { host, retention };
  });

  // Bodies next: verified against the chain, then written content-addressed
  // before any row references them. A rejected body leaves its frame without
  // one; the seal records the gap.
  const verified = verifyBatchBodies(input.events, input.bodies);
  const bodyRejections: BodyRejection[] = [...verified.rejected];
  const retained: VerifiedBody[] = [];
  if (retention.mode === "digest_only") {
    for (const body of verified.accepted)
      bodyRejections.push({
        event_id_idem: body.eventIdIdem,
        reason: "retention_digest_only",
      });
  } else {
    retained.push(...verified.accepted);
  }
  const bytesRefs = new Map<string, string>();
  for (const body of retained) {
    const { ref } = await evidenceStore().put({
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      runId: body.sessionUuid,
      digest: body.digest,
      contentType: body.contentType,
      bytes: body.bytes,
    });
    bytesRefs.set(body.eventIdIdem, ref);
  }

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
    // What the batch changed about spend: cost each session added, and the
    // root sessions it sealed. Both are acted on after the transaction.
    const spendDeltas: { micros: number; at: Date }[] = [];
    const rollupRoots: string[] = [];
    // The batch's fresh `proof.observed` frames, by the root session they belong to.
    const proofsByRoot = new Map<string, TachoEvent[]>();
    let newSessions = 0;
    // The sessions whose writes the statement refused: the row they conflicted
    // with is sealed, or is a different chain wearing the same uuid. Their
    // events are not that session's evidence and must not be acknowledged.
    const refusedSessions = new Set<string>();
    // …and the subset of those refusals that are TRANSIENT: the row moved under
    // the read this batch was folded against. Unlike a sealed row or a
    // different genesis, that one succeeds on a re-read, so the batch must come
    // back rather than be acknowledged and dropped.
    const staleSessions = new Set<string>();
    // The first root session this batch opened: the run the onboarding gate
    // records when this is the organization's first frame (#2967).
    let firstOpenedRunId: string | null = null;
    // Resolved on the first genesis row of the batch; every session a host
    // opens has the same operator, and a batch of continuations never asks.
    let initiatingPrincipalId: string | null | undefined;
    // Asked once for the whole batch rather than per session: the answer is
    // per-process and cached, and a batch cannot straddle a migration it holds
    // a transaction across.
    const sessionGatewayColumn = await sessionGatewayColumnReady(tx);
    // Which of this batch's chains the control plane's own records say it
    // served a gateway call for (#3221). One grouped read for the whole batch,
    // and skipped entirely when no promotion is possible — including while
    // `tacho.gateway_chains` is still an unapplied migration, where
    // naming the table would raise 42P01 and abort the transaction.
    const gatewayInvocations = await gatewayInvocationsFor(
      tx,
      host,
      [...bySession.keys()],
      await gatewayInvocationColumnReady(tx),
    );

    for (const [sessionUuid, events] of bySession) {
      events.sort((a, b) => a.seq - b.seq);
      const first = events[0] as TachoEvent;
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
          // What the chain proved it was when it opened. The gateway states
          // the same hash on every call, and a tier rises only when the two
          // agree (#3221).
          genesisHash: true,
          // The session's own server-clock birth. A gateway call the control
          // plane served before this chain existed is not evidence about it.
          createdAt: true,
        },
      });
      if (existing && existing.hostId !== host.id) {
        throw tachoDenied(
          capability,
          "Forbidden: session belongs to another host",
        );
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

      const delta = emptyDelta();
      for (const event of fresh) foldDelta(delta, event);
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
      const derivedTier = enforcementTierOf(
        chainRecord,
        host,
        ok,
        sessionGatewayColumn,
        sessionGenesisHash,
      );
      const promoteToGateway =
        existing !== undefined &&
        // Truthiness, matching `terminal` just below: a row read without the
        // column is as unsealed as one that is null, and either way an absent
        // seal must not read as a sealed one.
        !existing.sealedAt &&
        existing.enforcementTier !== TACHO_GATEWAY_TIER &&
        derivedTier === TACHO_GATEWAY_TIER;
      const effectiveTier = existing
        ? promoteToGateway
          ? TACHO_GATEWAY_TIER
          : existing.enforcementTier
        : derivedTier;
      // The grade is computed once, at seal: a sealed session is never
      // sealed again, whatever a later batch carries.
      // The genesis hash THIS batch's own derivation promoted on, or null when
      // it did not promote. Read by the insert's conflict path, where
      // `existing` is stale by construction.
      //
      // One value rather than a boolean and a hash kept beside it: the conflict
      // path needs both, and they have to be the same decision. `gateway` is
      // never derived from a null hash — `enforcementTierOf` requires it on
      // both sides — so the null branch below is unreachable rather than a
      // default, and if that ever stopped being true it falls to the
      // conservative side on its own.
      const promotedOnGenesis =
        derivedTier === TACHO_GATEWAY_TIER ? sessionGenesisHash : null;
      const terminal = existing?.sealedAt ? {} : terminalPatch(fresh, now);
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
      const tail = fresh.at(-1);
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
      };
      const common = {
        lastEventAt: now,
        seqCount: sql`GREATEST(${schema.tachoSessions.seqCount}, ${last.seq + 1})`,
        chainVerified: ok,
        ...(ok ? {} : { chainBreakAtSeq: breakSeq }),
        ...(tail
          ? {
              lastHash: tail.hash,
              modelFinal: tail.context?.model ?? null,
              permissionModeFinal: tail.context?.permission_mode ?? null,
              gitHeadShaEnd: tail.context?.git_head_sha ?? null,
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
              enforcementTier: TACHO_GATEWAY_TIER,
              // What raised it. A tier that rose must point at the evidence.
              // Guarded on the column's presence in its own right rather than
              // leaning on `promoteToGateway` being unreachable without the
              // host column: that coupling holds today and is invisible to
              // anyone changing either half.
              ...(sessionGatewayColumn
                ? { gatewayObservedAt: chainRecord?.at ?? null }
                : {}),
            }
          : {}),
        updatedAt: now,
        ...terminalColumns,
        ...increments,
      };

      // What the INSERT's conflict path applies, which is not the same thing.
      //
      // `common` is computed from `existing`, and on the insert path `existing`
      // is the read that preceded the INSERT — it says nothing about the row
      // this statement is now conflicting with. Two first-ingest requests can
      // both read no row and derive DIFFERENT tiers, because a gateway call
      // recorded between their two reads is visible to one and not the other.
      //
      // `common` then carries a `replayGrade` computed from the loser's tier
      // and no `enforcementTier` at all — the tier is only set on the promotion
      // path, which needs an `existing`. The winner's tier and the loser's
      // signed grade end up on one sealed row, and a sealed session is never
      // regraded.
      //
      // So the two move together here, in the only two shapes that are both
      // consistent and monotonic:
      //
      //   - the loser derived `gateway`: write the tier WITH the grade. That is
      //     a rise, which is the direction this tier is allowed to move, and
      //     the pair comes from one derivation.
      //   - the loser derived anything else: it cannot know whether the winner
      //     is on a higher tier, so it must not write a grade computed from its
      //     own. The seal is dropped and the session is sealed by a later batch,
      //     through the existing-session path, which reads the real row.
      //
      // `setWhere` still refuses an already-sealed row outright: a seal is
      // final, and neither shape above may overwrite one — and on the rise it
      // also refuses a row whose stored genesis is not the one the promotion
      // was derived from.
      const conflictSet =
        promotedOnGenesis !== null
          ? {
              ...common,
              enforcementTier: TACHO_GATEWAY_TIER,
              ...(sessionGatewayColumn
                ? { gatewayObservedAt: chainRecord?.at ?? null }
                : {}),
            }
          : withoutTerminal(common, terminalColumns);

      // The row this INSERT's conflict path may land on must be the chain this
      // batch IS, whatever tier it derived.
      //
      // `genesis_hash` is INSERT-only — the conflict path never rewrites it —
      // so a row that got there first wearing this session uuid keeps its own
      // genesis while this batch writes its head, its chain verdict, its
      // counters and its rollups onto it. The result is one row whose
      // `genesis_hash` and `last_hash` are the endpoints of two different
      // chains, recorded `chain_verified = true` with no chain break, so
      // nothing announces it; and because `chain_verified` is sticky false once
      // the real chain's next `prev_hash` misses, the real chain is graded
      // broken for the rest of its life and that verdict is signed into the
      // seal.
      //
      // This predicate used to be conditioned on the promotion
      // (discussion_r4042105761), which asked the identity question only for
      // the rare batch that derives `gateway`. Identity is not a property of
      // the tier: a batch whose genesis differs from the stored row is a
      // different chain claiming the same name whatever tier it is on, and
      // nothing it carries belongs on that row. Widening it costs the
      // promotion branch nothing — `promotedOnGenesis` is `sessionGenesisHash`
      // or null, so the promotion case is the same predicate it already was.
      //
      // Null is a batch that cannot answer: one that does not open at seq 0 and
      // so has no genesis of its own. It falls back to the seal guard alone,
      // exactly as before.
      const landsOnThisChain =
        sessionGenesisHash !== null
          ? and(
              isNull(schema.tachoSessions.sealedAt),
              eq(schema.tachoSessions.genesisHash, sessionGenesisHash),
            )
          : isNull(schema.tachoSessions.sealedAt);

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
          .set(common)
          .where(
            and(
              eq(schema.tachoSessions.id, existing.id),
              eq(schema.tachoSessions.seqCount, existing.seqCount),
              eq(
                schema.tachoSessions.enforcementTier,
                existing.enforcementTier,
              ),
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
          derivedTier === TACHO_GATEWAY_TIER ? (chainRecord?.at ?? null) : null,
          sessionGenesisHash,
        );
        const written = await tx
          .insert(schema.tachoSessions)
          .values({
            ...row,
            ...terminalColumns,
            chainVerified: ok,
            chainBreakAtSeq: ok ? null : breakSeq,
            lastHash: last.hash,
            seqCount: last.seq + 1,
          } as typeof schema.tachoSessions.$inferInsert)
          .onConflictDoUpdate({
            target: schema.tachoSessions.sessionUuid,
            set: conflictSet,
            // Only while the row is not already sealed.
            //
            // `common` here was computed as though no row existed — `existing`
            // was read before the INSERT, so it says nothing about the row this
            // statement is now conflicting with. That is harmless for the
            // counters and the head, and it is not harmless for the seal: two
            // first-ingest requests for the same session can both read
            // `existing === undefined`, derive different tiers, and the loser
            // then writes ITS `replayGrade` over the winner's row while leaving
            // the winner's `enforcementTier` alone, because the tier is only
            // set on the promotion path. The result is a sealed session whose
            // signed grade was computed from a tier it does not carry, and a
            // sealed session is never regraded.
            //
            // The guard is the invariant this file already states everywhere
            // else — a sealed session is final — made true under concurrency
            // rather than only under the read that preceded the insert. The
            // losing batch's counters go with it, which is the right trade:
            // they are a duplicate of a sealed session's, and a wrong signed
            // grade is not recoverable while a missing increment is.
            //
            // And the row must be the chain this batch is: `landsOnThisChain`
            // carries the seal guard together with the genesis match, so a
            // mismatch drops the whole update rather than part of it.
            setWhere: landsOnThisChain,
          })
          // Whether the statement did anything. `ON CONFLICT DO UPDATE` with a
          // `setWhere` that does not hold returns no rows, and that is the only
          // way to find out: the guard is evaluated inside the statement,
          // against the row it actually hit.
          //
          // Named rather than bare, like every other RETURNING in this file: a
          // bare one asks for every column the schema declares and fails on a
          // pending migration (`tacho-column-projection.test.ts`).
          .returning({
            id: schema.tachoSessions.id,
            // Whether this statement INSERTED the row, as opposed to updating
            // one that was already there. `xmax = 0` is true only of a tuple
            // this transaction created; an `ON CONFLICT DO UPDATE` that took
            // the update path returns the row with a non-zero `xmax`.
            //
            // `newSessions` used to be incremented from `existing === undefined`
            // — the read that preceded the INSERT — so two concurrent genesis
            // requests both counted, inflating `hosts.sessions_count`, and a
            // refused batch could be mistaken for an organisation's first run
            // by the onboarding gate.
            inserted: sql<boolean>`xmax = 0`,
          });
        accepted = written.length > 0;
        inserted = written[0]?.inserted === true;
        if (inserted) newSessions += 1;
        // Counters on a fresh row start from the insert's zero defaults; apply
        // the delta — but only if the row is this batch's to touch.
        //
        // This update used to be unconditional, which quietly undid the guard
        // above: the upsert correctly changed nothing, and then the counters
        // landed on the sealed or unrelated row anyway, leaving its aggregate
        // evidence inconsistent with the seal it is supposed to be final under.
        // A guard that only covers some of a batch's writes is not a guard.
        if (accepted) {
          await tx
            .update(schema.tachoSessions)
            .set(increments)
            .where(eq(schema.tachoSessions.sessionUuid, sessionUuid));
        }
      }
      // Refused on either path: the row this batch hit is sealed, is a
      // different chain wearing the same uuid, or moved under the read its
      // frames were folded against. Its events are not that session's evidence
      // and nothing of it is written.
      //
      // Reported as a chain break rather than silently dropped: the daemon
      // already surfaces these (`onChainBreak`), so an operator sees that a
      // batch was not recorded instead of wondering where it went.
      if (!accepted) {
        refusedSessions.add(sessionUuid);
        // Which kind of refusal. The existing-session path loses only to the
        // optimistic guard, which is a stale read and nothing worse; the insert
        // path's conflict is a sealed row or a different chain, which no retry
        // can turn into an acceptance.
        if (existing) staleSessions.add(sessionUuid);
        chainBreaks.push({
          session_uuid: sessionUuid,
          at_seq: first.seq,
          reason:
            "this session is already sealed, begins with a different genesis, or moved under the read this batch was folded against; the batch was not recorded",
        });
      }

      const sessionRow = await tx.query.tachoSessions.findFirst({
        where: eq(schema.tachoSessions.sessionUuid, sessionUuid),
        columns: { id: true, publicId: true, parentSessionUuid: true },
      });
      const sessionId = sessionRow?.id;
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
        await rollupModels(tx, ctx, sessionId, fresh, now);
        await rollupFiles(tx, ctx, sessionId, fresh, now);
        await rollupCommands(tx, ctx, sessionId, fresh, now);
      }
      if (accepted) {
        for (const event of fresh) {
          if (event.kind !== PROOF_OBSERVED_KIND) continue;
          const frames = proofsByRoot.get(event.root_session_uuid) ?? [];
          frames.push(event);
          proofsByRoot.set(event.root_session_uuid, frames);
        }
        if (delta.totalCostMicros > 0)
          spendDeltas.push({ micros: delta.totalCostMicros, at: now });
      }
      if (
        accepted &&
        sessionRow &&
        sessionRow.parentSessionUuid === null &&
        "sealedAt" in terminalColumns
      )
        rollupRoots.push(sessionRow.publicId);
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
    const seen = await touchHost(tx as never, host, input.daemon, now, true);
    const control = await controlEnvelope(tx as never, ctx, seen, now);
    return {
      chainBreaks,
      refusedSessions,
      staleSessions,
      verified,
      recordedHeads,
      control,
      spendDeltas,
      rollupRoots,
    };
  });

  // The spend counter is best-effort: the batch is accepted once the rows
  // are written, and the counter write may not fail the intake.
  for (const spend of result.spendDeltas) {
    try {
      await recordSpend({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        at: spend.at,
        micros: BigInt(spend.micros),
      });
    } catch (err) {
      logger.error(
        { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
        "tacho.events.ingest: spend counter write failed",
      );
    }
  }
  const storedRefs = await storedBytesRefs(
    input.events,
    result.recordedHeads,
    bytesRefs,
  );
  // Nothing derived from `event.anthropic` is stored. The producer chooses that
  // block, so any stable value computed from it and readable back would be an
  // oracle: submit the hash of a guessed address, read the result, compare it
  // to a colleague's row. The session's person is `initiatingPrincipalId` /
  // `initiatingUserId`, which this deployment issues rather than the harness
  // reports (#3072).
  // A stale-read refusal is RETRIED, not acknowledged.
  //
  // The two refusals are not the same. A sealed row or a different genesis is
  // permanent: no re-send turns it into an acceptance, so the batch is
  // acknowledged, reported as a chain break, and not written. A lost optimistic
  // guard is neither — the row simply moved between this request's read and its
  // write, and the same batch succeeds against a fresh read.
  //
  // Acknowledging that one loses it. The shipper marks the whole submitted
  // batch shipped on any success (`spool.ts`, `markShipped(batch)`), while this
  // handler excluded the session from Postgres and ClickHouse — so a terminal
  // batch would be deleted from the WAL without ever being recorded, leaving
  // the session unsealed and its frames gone.
  //
  // `conflict` maps to 409, which is neither `ControlUnreachable` nor the
  // 400/422 the shipper quarantines on: it takes the "keep the batch, back off"
  // branch, and the next attempt reads the row as it now is. Thrown before the
  // ClickHouse write so the attempt leaves nothing half-written; the Postgres
  // work of the accepted sessions is committed and idempotent under a re-send,
  // because `fresh` is filtered by the head those writes advanced.
  if (result.staleSessions.size > 0) {
    throw new HandlerError({
      code: "conflict",
      reason: "session_moved_under_read",
      message: `${result.staleSessions.size} session(s) in this batch changed between the read and the write; re-send it`,
    });
  }

  // Only the events whose session accepted them reach ClickHouse.
  //
  // `tacho_events` is a ReplacingMergeTree keyed by session and seq, so a
  // refused batch's frames would REPLACE the winning chain's rows for the same
  // sequences: the authoritative session rejected the batch and its raw
  // evidence overwrote the accepted chain's anyway.
  //
  // The RESPONSE still acknowledges them, and deliberately. The daemon's
  // shipper marks the whole submitted batch shipped on any success — it does
  // not read `event_ids` — so withholding them does not make it re-send, it
  // makes it delete the only remaining copy. And a re-send would not help
  // either: a refused batch belongs to a chain that cannot be recorded under
  // that uuid, or to a session already sealed, so retrying it forever is the
  // other way to be wrong. The refusal is reported as a chain break instead,
  // which the daemon already surfaces.
  const kept = input.events.filter(
    (event) => !result.refusedSessions.has(event.session_uuid),
  );
  const inserts: TachoEventInsert[] = kept.map((event) => {
    const bytesRef =
      bytesRefs.get(event.event_id_idem) ?? storedRefs.get(event.event_id_idem);
    return {
      event,
      chainVerified: result.verified.get(event.session_uuid) ?? false,
      ...(bytesRef === undefined ? {} : { bytesRef }),
    };
  });
  try {
    await insertTachoEvents(inserts);
  } catch (err) {
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
  for (const runId of new Set(result.rollupRoots)) {
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

  return {
    // Every submitted event, not just `kept`. See the note above: the shipper
    // does not read `event_ids`, and the contract requires at least one, so an
    // all-refused batch answered with zero is an `invalid_output` the daemon
    // retries for ever.
    accepted: input.events.length,
    event_ids: input.events.map((event) => event.event_id_idem),
    chain_breaks: result.chainBreaks,
    body_rejections: bodyRejections,
    control: result.control,
  };
};

/**
 * The body references already stored for re-sent events that carry content
 * and ship no body in this batch, keyed by `event_id_idem`. The batch
 * re-inserts every event (that is how a ClickHouse failure after the Postgres
 * commit recovers), and `tacho_events` keeps the newest row per seq, so a row
 * written without its reference would serve a body the seal counted as
 * `digest_only`. A stored reference is carried only onto an event with the
 * same content digest.
 */
async function storedBytesRefs(
  events: readonly TachoEvent[],
  recordedHeads: ReadonlyMap<string, number>,
  shipped: ReadonlyMap<string, string>,
): Promise<Map<string, string>> {
  const bySession = new Map<string, TachoEvent[]>();
  for (const event of events) {
    const head = recordedHeads.get(event.session_uuid) ?? 0;
    if (event.seq >= head || !event.content?.digest) continue;
    if (shipped.has(event.event_id_idem)) continue;
    const list = bySession.get(event.session_uuid) ?? [];
    list.push(event);
    bySession.set(event.session_uuid, list);
  }
  const refs = new Map<string, string>();
  for (const [sessionUuid, resent] of bySession) {
    const seqs = resent.map((event) => event.seq);
    const low = Math.min(...seqs);
    const rows = await selectTachoEvents({
      sessionUuid,
      afterSeq: low - 1,
      limit: Math.max(...seqs) - low + 1,
    });
    const stored = new Map(rows.map((row) => [row.seq, row]));
    for (const event of resent) {
      const row = stored.get(event.seq);
      if (
        row &&
        row.bytesRef !== "" &&
        row.contentDigest === event.content?.digest
      )
        refs.set(event.event_id_idem, row.bytesRef);
    }
  }
  return refs;
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
    if (
      event.source === "otel_log" ||
      event.source === "collector" ||
      event.source === "hook"
    ) {
      entry.requests += 1;
      entry.input += num(body["input_tokens"]);
      entry.output += num(body["output_tokens"]);
      entry.cacheRead += num(body["cache_read_tokens"]);
      entry.cacheCreation += num(body["cache_creation_tokens"]);
      entry.cost += num(body["cost_usd_micros"]);
      entry.duration += num(body["api_duration_ms"]);
    }
    if (event.source === "transcript")
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

async function rollupFiles(
  tx: Tx,
  ctx: Scope,
  sessionId: string,
  events: TachoEvent[],
  now: Date,
): Promise<void> {
  const byPath = new Map<
    string,
    {
      reads: number;
      writes: number;
      edits: number;
      deletes: number;
      first: number;
      last: number;
      bytes: number;
    }
  >();
  for (const event of events) {
    if (event.kind !== "tool_call" && event.kind !== "file_io") continue;
    if (event.kind === "tool_call" && event.source !== "hook") continue;
    const body = event.body as Body;
    const kind = str(body["effect_kind"]);
    const target = str(body["tool_target"]);
    if (!target || !kind || !kind.startsWith("file_")) continue;
    if (event.kind === "tool_call" && kind !== "file_read") continue;
    const entry = byPath.get(target) ?? {
      reads: 0,
      writes: 0,
      edits: 0,
      deletes: 0,
      first: event.seq,
      last: event.seq,
      bytes: 0,
    };
    if (kind === "file_read") entry.reads += 1;
    else if (kind === "file_write") {
      entry.writes += 1;
      entry.bytes += num(body["tool_input_bytes"]);
    } else if (kind === "file_edit") entry.edits += 1;
    else if (kind === "file_delete") entry.deletes += 1;
    entry.first = Math.min(entry.first, event.seq);
    entry.last = Math.max(entry.last, event.seq);
    byPath.set(target, entry);
  }
  for (const [path, entry] of byPath) {
    await tx
      .insert(schema.tachoSessionFiles)
      .values({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        sessionId,
        path,
        reads: entry.reads,
        writes: entry.writes,
        edits: entry.edits,
        deletes: entry.deletes,
        bytesWritten: entry.bytes,
        firstSeq: entry.first,
        lastSeq: entry.last,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          schema.tachoSessionFiles.sessionId,
          schema.tachoSessionFiles.path,
        ],
        set: {
          reads: sql`${schema.tachoSessionFiles.reads} + ${entry.reads}`,
          writes: sql`${schema.tachoSessionFiles.writes} + ${entry.writes}`,
          edits: sql`${schema.tachoSessionFiles.edits} + ${entry.edits}`,
          deletes: sql`${schema.tachoSessionFiles.deletes} + ${entry.deletes}`,
          bytesWritten: sql`${schema.tachoSessionFiles.bytesWritten} + ${entry.bytes}`,
          lastSeq: sql`GREATEST(${schema.tachoSessionFiles.lastSeq}, ${entry.last})`,
          updatedAt: now,
        },
      });
  }
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
