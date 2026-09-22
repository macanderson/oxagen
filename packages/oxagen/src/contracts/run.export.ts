/**
 * `export_run`: the signed, verifiable bundle for one sealed run (Mission
 * Control spec §13.4 "Exports produce a verifiable bundle: segments,
 * attestations, key ids, and a verifier script"; App. E; ADR-058).
 *
 * The capability queues an export job and answers its id; the bundle is
 * built off the request path from the run's frames (as NDJSON), its Merkle
 * root, an Ed25519 attestation by the deployment's attester key over the
 * run's seal figures, the public key that verifies it, and a verifier script
 * that recomputes the root and checks the signature with no Oxagen code.
 * The job is recorded in `evidence.run_exports`. `get_run_export` reads it
 * back and mints the download URL, and `oxagen verify` checks the bundle.
 *
 * A live run cannot be exported: the seal is what the attestation signs.
 * Org Owner or Admin only, checked in the handler (`assertOrgRole`,
 * ARCHITECTURE.md §3.2).
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { runPublicIdSchema } from "./run.list";

export const runExportIdSchema = z
  .string()
  .regex(/^rexp_[0-9a-z]+$/, "a run export id (rexp_…)");

export const runExport = registerCapability({
  name: "export_run",
  domain: "run",
  description:
    "Queue a signed, offline-verifiable evidence bundle for one sealed run: frame envelopes as NDJSON, the Merkle root, an attestation, the verifying key id and a verifier script.",
  mode: "async",
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "run" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z
    .object({
      runId: runPublicIdSchema,
    })
    .strict(),
  output: z
    .object({
      exportId: runExportIdSchema,
      status: z.literal("queued"),
    })
    .strict(),
});

export type RunExportInput = z.output<typeof runExport.input>;
export type RunExportOutput = z.output<typeof runExport.output>;
