/**
 * list_workspace_memories: the Memories tab's list (memory-collection spec,
 * Memories tab and Use counting; ADR-245).
 *
 * The list ranks memories by uses, then by the newest use, then by the
 * newest capture. Memories that say the same thing share one group: the
 * same statement hash, or the 0.8 word-overlap test the curator uses, within
 * one repository. The highest ranked memory speaks for its group, and the
 * page counts groups.
 *
 * The filters are state (waiting and in_pr when none is named), harness,
 * agent, repository, and the Claude Code memory type. The list groups the
 * 2,000 highest ranked memories that match, and `truncated` says when more
 * matched.
 *
 * A read. It writes nothing, and the in-app agent never receives it.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { repoRefSchema } from "../steering-repo/common";
import { tachoHarnessSchema } from "../tacho/schemas";
import {
  workspaceMemoryGroupSchema,
  workspaceMemoryStateSchema,
  workspaceMemoryTypeSchema,
} from "./steering.memories.shared";

/** The most memories one list groups. A larger match sets `truncated`. */
export const WORKSPACE_MEMORIES_GROUPED_MAX = 2_000;

export const steeringMemoriesList = registerCapability({
  name: "list_workspace_memories",
  domain: "context",
  description:
    "List the workspace's memories ranked by uses, then the newest use, then the newest capture, with memories that say the same thing grouped. Filter by state (waiting and in_pr by default), harness, agent, repository, and memory type.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"],
  layers: ["schema", "api", "mcp", "cli", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z
    .object({
      states: z
        .array(workspaceMemoryStateSchema)
        .min(1)
        .max(5)
        .default(["waiting", "in_pr"])
        .describe("The states to list. Defaults to waiting and in_pr."),
      harness: tachoHarnessSchema
        .optional()
        .describe("Only memories this harness keeps."),
      agent: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .optional()
        .describe("Only memories this agent wrote, by lineage."),
      repository: repoRefSchema
        .optional()
        .describe("Only memories scoped to this repository, such as github.com/acme/api."),
      type: workspaceMemoryTypeSchema
        .optional()
        .describe("Only memories of this Claude Code type: user, feedback, project, or reference."),
      limit: z.number().int().min(1).max(200).default(50),
      offset: z.number().int().nonnegative().default(0),
    })
    .strict(),
  output: z
    .object({
      groups: z.array(workspaceMemoryGroupSchema),
      /** Groups across every page. */
      total_groups: z.number().int().nonnegative(),
      /** Memories that matched, up to the 2,000 the list groups. */
      total_memories: z.number().int().nonnegative(),
      /** True when more than 2,000 memories matched and only the top ones were grouped. */
      truncated: z.boolean(),
      /** The workspace's waiting memories, whatever the filters, for the tab's count. */
      waiting: z.number().int().nonnegative(),
    })
    .strict(),
});

export type SteeringMemoriesListInput = z.output<
  typeof steeringMemoriesList.input
>;
export type SteeringMemoriesListOutput = z.output<
  typeof steeringMemoriesList.output
>;
