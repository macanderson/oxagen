/**
 * One Tacho session's flight-recorder index: the full session row, its
 * subagent chains, per-model usage, files touched, commands run, incidents,
 * and checkpoints (docs/specs/tacho/data-model.md section 3).
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { sessionSummarySchema } from "../tacho/schemas";

const modelUsageSchema = z
  .object({
    model: z.string(),
    canonicalModel: z.string().nullable(),
    provider: z.string().nullable(),
    requests: z.number().int(),
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
    cacheReadTokens: z.number().int(),
    cacheCreationTokens: z.number().int(),
    thinkingTokens: z.number().int(),
    costMicros: z.number().int(),
  })
  .strict();

const fileSchema = z
  .object({
    path: z.string(),
    reads: z.number().int(),
    writes: z.number().int(),
    edits: z.number().int(),
    deletes: z.number().int(),
    firstSeq: z.number().int(),
    lastSeq: z.number().int(),
  })
  .strict();

const commandSchema = z
  .object({
    seq: z.number().int(),
    toolUseId: z.string().nullable(),
    commandHead: z.string(),
    bashCommand: z.string().nullable(),
    status: z.string().nullable(),
    durationMs: z.number().int().nullable(),
    decision: z.string().nullable(),
    policyRule: z.string().nullable(),
  })
  .strict();

const incidentSchema = z
  .object({
    incidentId: z.string(),
    kind: z.string(),
    severity: z.number().int(),
    detectedAt: z.string(),
    detectedBy: z.string(),
    resolvedAt: z.string().nullable(),
  })
  .strict();

export const tachoSessionGet = registerCapability({
  name: "get_tacho_session",
  domain: "tacho",
  description:
    "Read one Tacho session's flight-recorder index: totals, subagent chains, model usage, files, commands, incidents, and checkpoints.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow" },
    workspace: {},
  },
  input: z.object({ sessionUuid: z.string().uuid() }).strict(),
  output: z
    .object({
      session: sessionSummarySchema.extend({
        anthropicUserEmail: z.string().nullable(),
        entrypoint: z.string().nullable(),
        terminalType: z.string().nullable(),
        permissionModeInitial: z.string().nullable(),
        permissionModeFinal: z.string().nullable(),
        effort: z.string().nullable(),
        endReason: z.string().nullable(),
        terminalReason: z.string().nullable(),
        projectDir: z.string().nullable(),
        gitRemoteDigest: z.string().nullable(),
        gitHeadShaStart: z.string().nullable(),
        worktreeBranch: z.string().nullable(),
        inputTokens: z.number().int(),
        outputTokens: z.number().int(),
        cacheReadTokens: z.number().int(),
        cacheCreationTokens: z.number().int(),
        thinkingTokens: z.number().int(),
        durationMs: z.number().int().nullable(),
        linesAdded: z.number().int(),
        linesRemoved: z.number().int(),
        numSubagents: z.number().int(),
        policyDenies: z.number().int(),
        genesisHash: z.string().nullable(),
        lastHash: z.string().nullable(),
        completenessGaps: z.array(z.string()),
        replayGrade: z.string().nullable(),
        toolsAvailable: z.array(z.string()).nullable(),
        mcpServers: z.unknown().nullable(),
        envSnapshot: z.record(z.string(), z.string()).nullable(),
      }),
      children: z.array(sessionSummarySchema).max(500),
      models: z.array(modelUsageSchema).max(64),
      files: z.array(fileSchema).max(1000),
      commands: z.array(commandSchema).max(1000),
      incidents: z.array(incidentSchema).max(500),
      checkpointCount: z.number().int(),
    })
    .strict(),
});

export type TachoSessionGetInput = z.output<typeof tachoSessionGet.input>;
export type TachoSessionGetOutput = z.output<typeof tachoSessionGet.output>;
