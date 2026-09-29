import { z } from "zod";
import { registerCapability } from "../registry";
import { studioDraftSchema, studioServerNameSchema } from "./tool.studio.draft.save";

/**
 * Read Studio's draft for one server folder (lane M11, ADR-224): the staged
 * edits `save_studio_draft` stored, or null when the folder has none. The
 * source is summarized by type and size, never echoed.
 */
export const toolStudioDraftGet = registerCapability({
  name: "get_studio_draft",
  domain: "tool",
  description:
    "Read Studio's draft for one server folder: the staged edits, server.toml, a summary of the source, the revision, and the steering PR Review opened from it. Null when the folder has no draft.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
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
  output: z.object({ draft: studioDraftSchema.nullable() }),
});

export type ToolStudioDraftGetInput = z.output<typeof toolStudioDraftGet.input>;
export type ToolStudioDraftGetOutput = z.output<typeof toolStudioDraftGet.output>;
