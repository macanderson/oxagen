/**
 * list_code_repository_findings: the instruction-file statements in the
 * workspace's linked code repositories that repeat or contradict a steering
 * record, for the Repositories page's Instruction files section (#4518,
 * ADR-253).
 *
 * The Oxagen check on a linked repository's pull requests (#5112) stores the
 * statements it flags: the file, the line, the text, and the pull request and
 * commit it read. This read compares each stored statement with the
 * workspace's active steering records again, with the check's own test, so a
 * record revised or retired since the check ran changes the answer at once. A
 * statement that matches no record now is left out. Each repository is named
 * by the workspace's binding (`rpb_…`), and a repository the workspace no
 * longer links is left out.
 *
 * A read. It writes nothing and runs no model.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import {
  proposalStatusSchema,
  repositoryProviderSchema,
} from "./context.steering.shared";

const instant = z.string().datetime({ offset: true });

/** How a stored statement relates to a steering record today. */
export const codeRepositoryFindingKindSchema = z.enum([
  "repeat",
  "contradiction",
]);

/** One flagged statement, compared with today's records. */
export const codeRepositoryFindingSchema = z
  .object({
    id: z
      .string()
      .regex(/^crf_[0-9A-Za-z]+$/)
      .describe("The finding's id, which promote_instruction_to_steering takes"),
    path: z.string().describe("The instruction file, such as AGENTS.md"),
    line: z
      .number()
      .int()
      .min(1)
      .describe("The line the statement starts on, at the commit the check read"),
    statement: z.string().describe("The statement's text"),
    kind: codeRepositoryFindingKindSchema.describe(
      "repeat when it says what the record says, contradiction when it says the opposite",
    ),
    record: z
      .object({
        lineage: z.string(),
        label: z.string().nullable(),
        path: z
          .string()
          .nullable()
          .describe("Where the record lives in the steering repo, or null"),
      })
      .strict()
      .describe("The steering record the statement repeats or contradicts"),
    pull_request: z
      .object({
        number: z.number().int().positive(),
        url: z.string(),
        state: z
          .enum(["open", "merged"])
          .describe("merged once the line reached the default branch"),
        head_sha: z.string().describe("The commit the check read"),
      })
      .strict(),
    file_url: z.string().describe("The line on the host, at that commit"),
    checked_at: instant,
    proposal: z
      .object({ id: z.string(), status: proposalStatusSchema })
      .strict()
      .nullable()
      .describe(
        "The proposal promote_instruction_to_steering opened from it, or null",
      ),
  })
  .strict();

export const codeRepositoryFindingsList = registerCapability({
  name: "list_code_repository_findings",
  domain: "repository",
  description:
    "List the instruction-file statements in the workspace's linked code repositories that repeat or contradict an active steering record. The Oxagen check on each pull request stores the statements it flags, and this read compares them with today's records, so a statement that no longer matches any record is left out. Each finding names its file, line, pull request, and the record it matches.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"],
  layers: ["schema", "api", "mcp", "cli", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z.object({}).strict(),
  output: z
    .object({
      repositories: z.array(
        z
          .object({
            repository_id: z
              .string()
              .describe("The workspace's binding of the repository (rpb_…)"),
            provider: repositoryProviderSchema,
            full_name: z.string().describe("owner/name on the host"),
            findings: z.array(codeRepositoryFindingSchema),
          })
          .strict(),
      ),
    })
    .strict(),
});

export type CodeRepositoryFindingsListOutput = z.output<
  typeof codeRepositoryFindingsList.output
>;
export type CodeRepositoryFinding = z.output<
  typeof codeRepositoryFindingSchema
>;
