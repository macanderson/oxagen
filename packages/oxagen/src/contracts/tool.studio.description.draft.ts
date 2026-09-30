import { z } from "zod";
import { registerCapability } from "../registry";
import { studioServerNameSchema, studioToolNameSchema } from "./tool.studio.draft.save";

/**
 * A suggested description for one tool, for the Draft button on Studio's tool
 * panel (mcp-studio-spec, lane M9). The handler builds the folder the way
 * list_studio_findings does, finds the tool, and asks the in-app agent to
 * describe it from its definition. The call bills as in-app agent spend.
 *
 * It writes nothing. Studio shows the suggestion, and a person who keeps it
 * saves it as a describe op with save_studio_draft.
 */
export const toolStudioDescriptionDraft = registerCapability({
  name: "draft_studio_description",
  domain: "tool",
  description:
    "Draft a description for one tool in a Studio server folder with the in-app agent. Returns a suggestion of at most 1,024 characters and writes nothing. Bills as in-app agent spend.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
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
      /** The tool's tools.toml key, its served name, or the upstream name it selects. */
      tool: studioToolNameSchema,
    })
    .strict(),
  output: z.object({
    server: z.string(),
    /** The tool as the input named it. */
    tool: z.string(),
    /** The suggestion. Nothing is saved until a person keeps it. */
    description: z.string().min(1).max(1024),
  }),
});

export type ToolStudioDescriptionDraftInput = z.output<typeof toolStudioDescriptionDraft.input>;
export type ToolStudioDescriptionDraftOutput = z.output<typeof toolStudioDescriptionDraft.output>;
