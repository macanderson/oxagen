/**
 * `get_run_export`: where one run export stands, and a link to download it
 * once it is built (Mission Control spec §13.4, App. E; ADR-058).
 *
 * `export_run` queues the bundle and answers an id. This reads that id back:
 * the status the job has reached (`queued`, `building`, `ready`, `failed`),
 * the bundle's digest, size, Merkle root and frame count once it is ready,
 * the job's error if it failed, and a download URL that expires.
 *
 * The URL carries a signed token instead of a session, so the person who
 * receives the bundle (an outside auditor on a clean machine) can fetch it
 * with nothing but the link, until it expires. Reading this capability again
 * mints a fresh one. The bundle's digest is inside the token, so a link can
 * only ever fetch the bytes this read described.
 *
 * Org Owner or Admin only, the same gate as `export_run`, checked in the
 * handler (`assertOrgRole`, ARCHITECTURE.md §3.2). An export id from another
 * workspace reads as `not_found`.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { runExportIdSchema } from "./run.export";
import { runPublicIdSchema } from "./run.list";

/** The statuses `evidence.run_exports` holds, in the order the job moves. */
export const RUN_EXPORT_STATUSES = [
  "queued",
  "building",
  "ready",
  "failed",
] as const;

/** How long a minted download URL works. */
export const RUN_EXPORT_DOWNLOAD_TTL_SECONDS = 15 * 60;

const sha256Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const runExportGet = registerCapability({
  name: "get_run_export",
  domain: "run",
  description:
    "Read one run export: its status, the bundle's digest and size once it is built, the error if the job failed, and a download URL that expires.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"],
  layers: ["schema", "api", "mcp", "cli", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  agent: { requiresApproval: false, riskLevel: "low", category: "run" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z
    .object({
      exportId: runExportIdSchema,
    })
    .strict(),
  output: z
    .object({
      exportId: runExportIdSchema,
      runId: runPublicIdSchema,
      status: z.enum(RUN_EXPORT_STATUSES),
      createdAt: z.string().datetime(),
      completedAt: z.string().datetime().nullable(),
      /** sha256 over the zip as stored; `oxagen verify` does not need it. */
      bundleDigest: sha256Digest.nullable(),
      /** Null on a bundle built before the size was recorded. */
      bundleBytes: z.number().int().nonnegative().nullable(),
      merkleRoot: sha256Digest.nullable(),
      frameCount: z.number().int().nonnegative().nullable(),
      error: z.string().nullable(),
      /** Set only when the bundle is ready. */
      download: z
        .object({
          url: z.string().min(1),
          expiresAt: z.string().datetime(),
        })
        .strict()
        .nullable(),
    })
    .strict(),
});

export type RunExportGetInput = z.output<typeof runExportGet.input>;
export type RunExportGetOutput = z.output<typeof runExportGet.output>;
