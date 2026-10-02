/**
 * `propose_steering`: an agent opens a steering PR on its workspace's steering
 * repo from files, a title, its rationale, and frames of its run as evidence
 * (steering-repo-spec, Agent use). It needs no clone.
 *
 * Oxagen writes each record's `provenance` itself: `source: proposal`, the
 * run as `uri`, and the proposing agent as `agent`, which Oxagen takes from
 * the request's credential and never from tool input. Oxagen writes `id` and
 * `hash` when the PR merges. So a record that types `id` or `hash`, names its
 * own `provenance.agent`, or claims `provenance.source: run` is refused, and
 * so is a change to a file only Oxagen writes: `policy/schema.cedarschema`, a
 * server's `tools.lock.json`, the ledger under `steering/promotions/`, and the
 * managed block in AGENTS.md, CLAUDE.md, or README.md.
 *
 * The branch starts with the folder the files change (steering-repo-spec,
 * Steering PR flow): steering/, tools/, agents/, or policy/, workspace/ for a
 * file at the repository root, and memory/ for steering/memory/. The PR runs
 * the steering checks and reports them as the "Oxagen steering" check, and
 * nothing steers until a person merges it.
 *
 * The spec proposed the name `steering_propose`. ADR-025 puts the verb first,
 * so the capability is `propose_steering`.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { repoPathSchema } from "../steering-repo/common";
import { STEERING_PR_MAX_FILES } from "../steering-repo/names";

/** The longest file a proposal writes: 1 MB, the size limit of a skill folder's asset. */
export const STEERING_PROPOSE_FILE_MAX = 1_048_576;

/** The most frames one proposal cites. */
export const STEERING_PROPOSE_EVIDENCE_MAX = 20;

export const steeringProposeFileSchema = z
  .object({
    path: repoPathSchema
      .max(512)
      .describe(
        "The file's path in the steering repo, such as steering/billing/aintel.billing.refunds-over-100.md.",
      ),
    content: z
      .string()
      .max(STEERING_PROPOSE_FILE_MAX)
      .nullable()
      .describe(
        "The file's full text, UTF-8. Null deletes the file. Leave id, hash, and provenance out of a record: Oxagen writes them.",
      ),
  })
  .strict();
export type SteeringProposeFile = z.output<typeof steeringProposeFileSchema>;

export const steeringProposeInputSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe("The steering PR's title, such as Ask before refunds over $100."),
    rationale: z
      .string()
      .trim()
      .min(1)
      .max(4000)
      .describe("Why the change should merge. The reviewer reads it in the PR."),
    evidence: z
      .array(z.number().int().min(0))
      .max(STEERING_PROPOSE_EVIDENCE_MAX)
      .default([])
      .describe(
        "Frame numbers in this run that show why the change is needed. Leave empty if you do not know them.",
      ),
    files: z
      .array(steeringProposeFileSchema)
      .min(1)
      .max(STEERING_PR_MAX_FILES)
      .describe(
        "Every file the PR writes or deletes, all under one folder: steering/, tools/, agents/, policy/, steering/memory/, or the repository root.",
      ),
  })
  .strict();
export type SteeringProposeInput = z.input<typeof steeringProposeInputSchema>;

export const steeringProposeOutputSchema = z
  .object({
    number: z.number().int().positive().describe("The steering PR's number."),
    url: z.string().describe("The steering PR's page on GitHub or GitLab."),
    branch: z.string(),
    head_sha: z
      .string()
      .describe("The commit the PR opened at, which the Oxagen steering check ran on."),
    agent: z.string().describe("The agent Oxagen wrote into each record's provenance."),
    run: z.string().describe("The run Oxagen wrote into each record's provenance."),
  })
  .strict();
export type SteeringProposeOutput = z.output<typeof steeringProposeOutputSchema>;

export const steeringPropose = registerCapability({
  name: "propose_steering",
  domain: "context",
  description:
    "Open a steering PR on the workspace's steering repo from files, a title, your rationale, and frames of this run as evidence. Put every file under one folder: steering/, tools/, agents/, policy/, steering/memory/, or the repository root. Leave id, hash, and provenance out of a record: Oxagen writes provenance with your agent and run, and writes id and hash on merge. Files only Oxagen writes are refused. The PR runs the steering checks, and nothing steers until a person merges it.",
  mode: "sync",
  surfaces: ["mcp"],
  layers: ["schema", "mcp", "unit", "docs"],
  scoped: true,
  // Opening a PR calls no model. The PR's checks and merge are not metered either.
  noBillingGate: true,
  mutates: true,
  agent: { requiresApproval: false, riskLevel: "medium", category: "governance" },
  sensitivity: "medium",
  defaultEffect: "deny",
  // The roles propose_record grants. A Viewer reads steering and proposes none.
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: steeringProposeInputSchema,
  output: steeringProposeOutputSchema,
});
