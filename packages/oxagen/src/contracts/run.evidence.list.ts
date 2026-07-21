import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * run.evidence.list → list_run_evidence
 *
 * Read-only listing of RunEvidenceManifestV1 summaries for the workspace, newest
 * first, with keyset pagination on created_at. Backs the evidence-ledger read
 * surface: which governed attempts have attested evidence, under what authority,
 * with how many changed files and context frames.
 *
 * Filters: by `runId` (all attempts of one run) and/or `repositoryId` (manifests
 * whose local checkout was of that repository). Postgres-only — change/frame
 * counts are derived from the child tables, never from ClickHouse.
 *
 * Org + workspace scoped, read-only.
 */

export const runEvidenceList = registerCapability({
  name: "list_run_evidence",
  domain: "run",
  description:
    "List RunEvidenceManifestV1 summaries for the workspace, newest first, with keyset pagination — run/attempt, evidence authority, digest, and changed-file + context-frame counts.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"] as const,
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    runId: z
      .string()
      .optional()
      .describe("Filter to evidence manifests for one run"),
    repositoryId: z
      .string()
      .uuid()
      .optional()
      .describe("Filter to manifests whose checkout was of this repository"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .describe("Max manifests to return (1–100)"),
    cursor: z
      .string()
      .datetime()
      .optional()
      .describe(
        "Keyset cursor: return manifests created strictly before this ISO timestamp",
      ),
  }),
  output: z.object({
    manifests: z.array(
      z.object({
        id: z.string().describe("publicId of the evidence manifest"),
        runId: z.string(),
        attemptId: z.string().nullable(),
        evidenceAuthority: z.enum([
          "runner_observed",
          "provider_observed",
          "client_attested",
          "inferred",
        ]),
        manifestDigest: z.string(),
        createdAt: z.string(),
        changeCount: z
          .number()
          .int()
          .describe("Number of changed-file evidence rows in this manifest"),
        frameCount: z
          .number()
          .int()
          .describe("Number of context-frame rows in this manifest"),
      }),
    ),
    nextCursor: z
      .string()
      .nullable()
      .describe(
        "Pass as `cursor` to fetch the next page; null when no more rows",
      ),
  }),
});

export type RunEvidenceListInput = z.output<typeof runEvidenceList.input>;
export type RunEvidenceListOutput = z.output<typeof runEvidenceList.output>;
