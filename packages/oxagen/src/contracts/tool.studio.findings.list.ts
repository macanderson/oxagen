import { z } from "zod";
import { registerCapability } from "../registry";
import { studioServerNameSchema } from "./tool.studio.draft.save";
import { studioFindingSchema, studioTokensSchema } from "./tool.studio.review.open";

/**
 * The tool checks' findings on one server folder, for Studio's findings panel
 * (mcp-studio-spec, lane M9). The handler builds the folder the way Review
 * does (compile, lock, and lint) from the saved draft, or from the folder on
 * the production branch when the server has no draft. It writes nothing.
 *
 * An imported tool with no risk, side effect, or egress comes back as a
 * `missing_classification` error, where Review refuses the draft. A folder
 * that does not compile or lock is refused with `conflict`, as Review
 * refuses it, because lint has no folder to read.
 */
export const toolStudioFindingsList = registerCapability({
  name: "list_studio_findings",
  domain: "tool",
  description:
    "List the tool checks' findings on one server folder: the saved draft, or the production folder when there is no draft. Each finding names its level, tool, field, message, and fix. Writes nothing.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  // Compiling and linting a folder spends no model tokens.
  noBillingGate: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "governance" },
  sensitivity: "medium",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  input: z
    .object({
      /** The folder name under tools/servers/. */
      server: studioServerNameSchema,
    })
    .strict(),
  output: z.object({
    server: z.string(),
    /** "draft" when the saved draft was checked, "published" when the production folder was. */
    basis: z.enum(["draft", "published"]),
    /** The draft revision checked, or null for the production folder. */
    revision: z.number().int().min(1).nullable(),
    tokens: studioTokensSchema,
    /** Errors first, then warnings, then infos. */
    findings: z.array(studioFindingSchema),
  }),
});

export type ToolStudioFindingsListInput = z.output<typeof toolStudioFindingsList.input>;
export type ToolStudioFindingsListOutput = z.output<typeof toolStudioFindingsList.output>;
