/**
 * `summarize_run`: the generated name and summary of a sealed run (Mission
 * Control mockup 2821-2835; plan gap G14; ADR-058).
 *
 * A fast-tier model reads the run's transcript and writes what changed. The
 * result is stored on the run with the model id and the instant it was
 * produced, labelled generated wherever it renders, and never stands in for
 * the record: the frames are the record, and the interface offers "Check it
 * against the frames".
 *
 * The model call runs off the request path: the capability queues the job
 * and answers `queued`; `get_run` carries `name` and `summary` once the job
 * has written them. The call goes through `@oxagen/ai` on the organisation's
 * funding source and is metered like every other model call.
 *
 * A `digest_only` run is never summarised: there are no bodies for a model
 * to read, and a summary written from receipts alone would be the
 * placeholder the interface forbids. The refusal is `conflict`. A live run is
 * refused the same way: the record is not yet complete.
 *
 * Org Owner, Admin or Member, checked in the handler (`assertOrgRole`,
 * ARCHITECTURE.md §3.2).
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { runPublicIdSchema } from "./run.list";

export const runSummarize = registerCapability({
  name: "summarize_run",
  domain: "run",
  description:
    "Queue a fast-tier model to read a sealed run's transcript and write its generated name and summary; refused on a live run and on a digest_only recording.",
  mode: "async",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "run" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z
    .object({
      runId: runPublicIdSchema,
    })
    .strict(),
  output: z
    .object({
      runId: runPublicIdSchema,
      status: z.literal("queued"),
    })
    .strict(),
});

export type RunSummarizeInput = z.output<typeof runSummarize.input>;
export type RunSummarizeOutput = z.output<typeof runSummarize.output>;
