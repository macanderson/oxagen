/**
 * promote_instruction_to_steering: turn one instruction-file statement that
 * contradicts a steering record into a proposal for that record (#4518,
 * ADR-254).
 *
 * It takes a finding from list_code_repository_findings and compares its
 * statement with today's records again. A contradiction becomes a proposal
 * for a new version of the record it contradicts, with the statement as the
 * record's text and the pull request and file line as evidence. The record
 * keeps its lineage, kind, force, and scope, and a constraint takes its
 * effect from the statement's words. The proposal's steering PR opens at
 * once and runs the six checks. Nothing steers until that PR merges.
 *
 * Refused, with nothing written, for a repeat (`already_in_steering`), for a
 * statement that matches no record now (`finding_resolved`), for a statement
 * over 2,000 characters (`statement_too_long`), for a finding whose proposal
 * is still open (`already_proposed`), and while another PR is open on the
 * record (`lineage_pr_open`).
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { proposalStatusSchema } from "./context.steering.shared";

export const instructionPromote = registerCapability({
  name: "promote_instruction_to_steering",
  domain: "repository",
  description:
    "Propose a new version of the steering record an instruction-file statement contradicts, with the statement as its text, and open the proposal's steering PR. Takes a finding id from list_code_repository_findings. Refused for a repeat, for a statement that matches no record now, and while another PR is open on the record. Nothing steers until the PR merges.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"],
  layers: ["schema", "api", "mcp", "cli", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  agent: { requiresApproval: true, riskLevel: "medium", category: "governance" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z
    .object({
      finding_id: z
        .string()
        .regex(/^crf_[0-9A-Za-z]+$/)
        .describe("The finding's id, from list_code_repository_findings"),
    })
    .strict(),
  output: z
    .object({
      proposal_id: z.string().describe("The proposal it opened (prp_…)"),
      lineage: z.string().describe("The record the proposal revises"),
      status: proposalStatusSchema.describe(
        "Where the proposal's steering PR stopped",
      ),
      pull_request: z
        .object({ number: z.number().int().positive(), url: z.string() })
        .strict()
        .nullable(),
    })
    .strict(),
});

export type InstructionPromoteInput = z.output<typeof instructionPromote.input>;
export type InstructionPromoteOutput = z.output<
  typeof instructionPromote.output
>;
