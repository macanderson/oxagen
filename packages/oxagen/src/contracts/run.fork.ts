/**
 * `fork_run`: a new attempt that replays a recording up to a frame and runs
 * live from there (Mission Control spec §8.4 `fork`; ADR-058 decision 3).
 *
 * Frames 0–N replay from the recording; the next model call runs live; tool
 * results after N are served from the recorded cassette when the input
 * digest matches and denied otherwise. Oxagen mints the attempt and records
 * its provenance (`agent_run_attempts.forked_from_run_seq`, paired with the
 * attempt it branches from); the harness that consumes the cassette is the
 * engine that admitted the run (ADR-043), which resumes the attempt through
 * evidence ingress.
 *
 * The recorded grade gates the write: a run graded below `fork` is refused
 * with `conflict`, and so is a branch point that a frame with no retained
 * body precedes, because the cassette would have a hole before the fork. The
 * grade is the one the seal recorded; nothing here recomputes it.
 *
 * Org Owner, Admin or Member, checked in the handler (`assertOrgRole`,
 * ARCHITECTURE.md §3.2), so the capability has no MCP surface: an MCP context
 * carries no user. The input takes either run id; a wrapped session (`tse_…`)
 * has no attempt row to mint and is refused by name (`conflict`,
 * `fork_requires_ledger_run`), whatever grade it recorded.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { frameSeqSchema } from "./run.frame_body.get";
import { runPublicIdSchema } from "./run.list";

export const attemptPublicIdSchema = z
  .string()
  .regex(/^arat_[0-9a-z]+$/, "an attempt public id (arat_…)");

export const runFork = registerCapability({
  name: "fork_run",
  domain: "run",
  description:
    "Mint a new attempt of an evidence-ledger run that replays the recording up to a frame and runs live from there; refused unless the seal recorded grade fork and every frame before the branch point kept its body.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  agent: { requiresApproval: false, riskLevel: "medium", category: "run" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z
    .object({
      runId: runPublicIdSchema,
      /** The last recorded frame the fork replays, as a decimal `run_seq` ≥ 1. */
      fromSeq: frameSeqSchema.refine((v) => v !== "0", "fromSeq is at least 1"),
    })
    .strict(),
  output: z
    .object({
      attemptId: attemptPublicIdSchema,
      attemptNumber: z.number().int().positive(),
    })
    .strict(),
});

export type RunForkInput = z.output<typeof runFork.input>;
export type RunForkOutput = z.output<typeof runFork.output>;
