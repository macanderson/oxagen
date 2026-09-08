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
// liveness; and the control envelope in the response.

import type { CapabilityHandler } from "@oxagen/oxagen";
import { tachoEventsIngest } from "@oxagen/oxagen/contracts/tacho.events.ingest";
import { schema, withTenantDb } from "@oxagen/database";
import { type TachoEvent, verifyChain } from "@oxagen/tacho";
import { insertTachoEvents } from "@oxagen/telemetry";
import { eq, sql } from "drizzle-orm";
import {
  type TachoHostRow,
  controlEnvelope,
  resolveEnrolledHost,
  tachoDenied,
  touchHost,
} from "./lib/tacho-host";
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

/** The insert values for a session row seen for the first time. */
function genesisRow(
  host: TachoHostRow,
  ctx: { orgId: string; workspaceId: string },
  events: TachoEvent[],
  now: Date,
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
    rootSessionUuid: first.root_session_uuid,
    parentSessionUuid: first.parent_session_uuid ?? null,
    subagentId: subagent?.subagent_id ?? null,
    subagentType: subagent?.subagent_type ?? null,
    spawnDepth: subagent?.spawn_depth ?? 0,
    spawnToolUseId: subagent?.spawn_tool_use_id ?? null,
    anthropicUserIdHash: anthropic.user_id_hash ?? null,
    anthropicUserEmail: anthropic.user_email ?? null,
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
    enforcementTier:
      first.agent.enforcement_tier ??
      (host.mode === "enforce" ? "harness" : "observe"),
    bundleMode: host.mode,
    genesisHash: first.seq === 0 ? first.hash : null,
    createdAt: now,
    updatedAt: now,
  };
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

  const result = await withTenantDb(async (tx) => {
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
    let newSessions = 0;

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
      if (existing) {
        if (first.seq < existing.seqCount) {
          // A re-send of rows already accepted: idempotent under the
          // (session_uuid, seq) key; verify it links to nothing new.
          ok = ok && true;
        } else if (first.seq !== existing.seqCount) {
          ok = false;
          breakSeq = first.seq;
          reason = `seq ${first.seq} follows recorded seq ${existing.seqCount - 1}: the sequence must be dense`;
        } else if (
          existing.lastHash !== null &&
          first.prev_hash !== existing.lastHash
        ) {
          ok = false;
          breakSeq = first.seq;
          reason = `seq ${first.seq} prev_hash does not match the recorded chain head`;
        }
        if (!existing.chainVerified) ok = false;
      } else if (first.seq !== 0) {
        ok = false;
        breakSeq = first.seq;
        reason = `first observed event has seq ${first.seq}, not 0`;
      }
      verified.set(sessionUuid, ok);
      if (!ok && breakSeq !== null)
        chainBreaks.push({
          session_uuid: sessionUuid,
          at_seq: breakSeq,
          reason,
        });

      const delta = emptyDelta();
      for (const event of events) foldDelta(delta, event);
      const terminal = terminalPatch(events, now);
      const { totalCostMicrosAuthoritative, ...terminalColumns } =
        terminal as Record<string, unknown> & {
          totalCostMicrosAuthoritative?: number;
        };
      const lastContext = last.context ?? {};
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
        filesRead: sql`${schema.tachoSessions.filesRead} + ${delta.filesRead}`,
        filesWritten: sql`${schema.tachoSessions.filesWritten} + ${delta.filesWritten}`,
        filesDeleted: sql`${schema.tachoSessions.filesDeleted} + ${delta.filesDeleted}`,
        commandsRun: sql`${schema.tachoSessions.commandsRun} + ${delta.commandsRun}`,
        networkCalls: sql`${schema.tachoSessions.networkCalls} + ${delta.networkCalls}`,
      };
      const common = {
        lastEventAt: now,
        seqCount: sql`GREATEST(${schema.tachoSessions.seqCount}, ${last.seq + 1})`,
        lastHash: last.hash,
        chainVerified: ok,
        ...(ok ? {} : { chainBreakAtSeq: breakSeq }),
        modelFinal: lastContext.model ?? null,
        permissionModeFinal: lastContext.permission_mode ?? null,
        gitHeadShaEnd: lastContext.git_head_sha ?? null,
        updatedAt: now,
        ...terminalColumns,
        ...increments,
      };

      if (existing) {
        await tx
          .update(schema.tachoSessions)
          .set(common)
          .where(eq(schema.tachoSessions.id, existing.id));
      } else {
        newSessions += 1;
        const row = genesisRow(host, ctx, events, now);
        await tx
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
            set: common,
          });
        // Counters on a fresh row start from the insert's zero defaults; apply the delta.
        await tx
          .update(schema.tachoSessions)
          .set(increments)
          .where(eq(schema.tachoSessions.sessionUuid, sessionUuid));
      }

      const sessionRow = await tx.query.tachoSessions.findFirst({
        where: eq(schema.tachoSessions.sessionUuid, sessionUuid),
        columns: { id: true },
      });
      const sessionId = sessionRow?.id;
      if (sessionId) {
        await rollupModels(tx, ctx, sessionId, events, now);
        await rollupFiles(tx, ctx, sessionId, events, now);
        await rollupCommands(tx, ctx, sessionId, events, now);
      }
    }

    if (newSessions > 0) {
      await tx
        .update(schema.tachoHosts)
        .set({
          sessionsCount: sql`${schema.tachoHosts.sessionsCount} + ${newSessions}`,
        })
        .where(eq(schema.tachoHosts.id, host.id));
    }
    await touchHost(tx as never, host, input.daemon, now, true);
    const control = await controlEnvelope(tx as never, ctx, host, now);
    return { chainBreaks, verified, control };
  });

  const inserts = input.events.map((event) => ({
    event,
    chainVerified: result.verified.get(event.session_uuid) ?? false,
  }));
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

  return {
    accepted: input.events.length,
    event_ids: input.events.map((event) => event.event_id_idem),
    chain_breaks: result.chainBreaks,
    control: result.control,
  };
};

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
