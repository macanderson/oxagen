import type { CapabilityHandler } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { tachoSessionGet } from "@oxagen/oxagen/contracts/tacho.session.get";
import { schema, withTenantDb } from "@oxagen/database";
import { and, asc, count, desc, eq } from "drizzle-orm";
import {
  sessionFileReadColumns,
  sessionReadColumns,
} from "./lib/tacho-gateway-columns";
import { hostPublicIds, sessionSummary } from "./tacho.session.list";

export const tachoSessionGetHandler: CapabilityHandler<
  typeof tachoSessionGet
> = async (input, ctx) =>
  withTenantDb(async (tx) => {
    const row = await tx.query.tachoSessions.findFirst({
      where: and(
        eq(schema.tachoSessions.sessionUuid, input.sessionUuid),
        eq(schema.tachoSessions.orgId, ctx.orgId),
        eq(schema.tachoSessions.workspaceId, ctx.workspaceId),
      ),
      // Reading a session must not require the gateway column to exist yet
      // (discussion_r4040558842).
      columns: await sessionReadColumns(tx),
    });
    if (!row) {
      throw new CapabilityError(
        "get_tacho_session",
        "invalid_input",
        "Tacho session not found",
      );
    }
    // Resolved before the fan-out: `Promise.all` would otherwise start each
    // probe concurrently, and they answer from one per-process cache anyway.
    const childColumns = await sessionReadColumns(tx);
    const fileColumns = await sessionFileReadColumns(tx);
    // Every read names the caller's org and workspace as well as the session,
    // as the session read above does: a local stack runs with the RLS bypass
    // on, and RLS alone is not the fence there.
    const [children, models, files, commands, incidents, checkpoints] =
      await Promise.all([
        tx.query.tachoSessions.findMany({
          where: and(
            eq(schema.tachoSessions.parentSessionUuid, row.sessionUuid),
            eq(schema.tachoSessions.orgId, ctx.orgId),
            eq(schema.tachoSessions.workspaceId, ctx.workspaceId),
          ),
          orderBy: [asc(schema.tachoSessions.startedAt)],
          limit: 500,
          columns: childColumns,
        }),
        tx.query.tachoSessionModels.findMany({
          where: and(
            eq(schema.tachoSessionModels.sessionId, row.id),
            eq(schema.tachoSessionModels.orgId, ctx.orgId),
            eq(schema.tachoSessionModels.workspaceId, ctx.workspaceId),
          ),
          limit: 64,
        }),
        tx.query.tachoSessionFiles.findMany({
          where: and(
            eq(schema.tachoSessionFiles.sessionId, row.id),
            eq(schema.tachoSessionFiles.orgId, ctx.orgId),
            eq(schema.tachoSessionFiles.workspaceId, ctx.workspaceId),
          ),
          orderBy: [asc(schema.tachoSessionFiles.firstSeq)],
          limit: 1000,
          // A relational read selects every column the schema declares, so this
          // one names `observed_status` from the moment the declaration landed —
          // and raises 42703 until the migration does. Nothing below reads it;
          // it is projected away only so that reading a run does not go dark
          // for the deploy-before-migrate window
          // (discussion_r4051911079).
          columns: fileColumns,
        }),
        tx.query.tachoSessionCommands.findMany({
          where: and(
            eq(schema.tachoSessionCommands.sessionId, row.id),
            eq(schema.tachoSessionCommands.orgId, ctx.orgId),
            eq(schema.tachoSessionCommands.workspaceId, ctx.workspaceId),
          ),
          orderBy: [asc(schema.tachoSessionCommands.seq)],
          limit: 1000,
        }),
        tx.query.tachoIncidents.findMany({
          where: and(
            eq(schema.tachoIncidents.sessionId, row.id),
            eq(schema.tachoIncidents.orgId, ctx.orgId),
            eq(schema.tachoIncidents.workspaceId, ctx.workspaceId),
          ),
          orderBy: [desc(schema.tachoIncidents.detectedAt)],
          limit: 500,
        }),
        tx
          .select({ value: count() })
          .from(schema.tachoCheckpoints)
          .where(
            and(
              eq(schema.tachoCheckpoints.sessionId, row.id),
              eq(schema.tachoCheckpoints.orgId, ctx.orgId),
              eq(schema.tachoCheckpoints.workspaceId, ctx.workspaceId),
            ),
          ),
      ]);
    const hosts = await hostPublicIds(tx, [row, ...children]);
    const hostPublicId = row.hostId ? (hosts.get(row.hostId) ?? null) : null;
    return {
      session: {
        ...sessionSummary(row, hostPublicId),
        entrypoint: row.entrypoint,
        terminalType: row.terminalType,
        permissionModeInitial: row.permissionModeInitial,
        permissionModeFinal: row.permissionModeFinal,
        effort: row.effort,
        endReason: row.endReason,
        terminalReason: row.terminalReason,
        projectDir: row.projectDir,
        gitRemoteDigest: row.gitRemoteDigest,
        gitHeadShaStart: row.gitHeadShaStart,
        worktreeBranch: row.worktreeBranch,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheCreationTokens: row.cacheCreationTokens,
        thinkingTokens: row.thinkingTokens,
        durationMs: row.durationMs,
        linesAdded: row.linesAdded,
        linesRemoved: row.linesRemoved,
        numSubagents: row.numSubagents,
        policyDenies: row.policyDenies,
        genesisHash: row.genesisHash,
        lastHash: row.lastHash,
        completenessGaps: Array.isArray(row.completenessGaps)
          ? (row.completenessGaps as string[])
          : [],
        replayGrade: row.replayGrade,
        toolsAvailable: Array.isArray(row.toolsAvailable)
          ? (row.toolsAvailable as string[])
          : null,
        mcpServers: row.mcpServers ?? null,
        envSnapshot: (row.envSnapshot as Record<string, string> | null) ?? null,
      },
      children: children.map((child) =>
        sessionSummary(
          child,
          child.hostId ? (hosts.get(child.hostId) ?? null) : null,
        ),
      ),
      models: models.map((model) => ({
        model: model.model,
        canonicalModel: model.canonicalModel,
        provider: model.provider,
        requests: model.requests,
        inputTokens: model.inputTokens,
        outputTokens: model.outputTokens,
        cacheReadTokens: model.cacheReadTokens,
        cacheCreationTokens: model.cacheCreationTokens,
        thinkingTokens: model.thinkingTokens,
        costMicros: model.costMicros,
      })),
      files: files.map((file) => ({
        path: file.path,
        reads: file.reads,
        writes: file.writes,
        edits: file.edits,
        deletes: file.deletes,
        firstSeq: file.firstSeq,
        lastSeq: file.lastSeq,
      })),
      commands: commands.map((command) => ({
        seq: command.seq,
        toolUseId: command.toolUseId,
        commandHead: command.commandHead,
        bashCommand: command.bashCommand,
        status: command.status,
        durationMs: command.durationMs,
        decision: command.decision,
        policyRule: command.policyRule,
      })),
      incidents: incidents.map((incident) => ({
        incidentId: incident.publicId,
        kind: incident.kind,
        severity: incident.severity,
        detectedAt: incident.detectedAt.toISOString(),
        detectedBy: incident.detectedBy,
        resolvedAt: incident.resolvedAt?.toISOString() ?? null,
      })),
      checkpointCount: Number(checkpoints[0]?.value ?? 0),
    };
  });
