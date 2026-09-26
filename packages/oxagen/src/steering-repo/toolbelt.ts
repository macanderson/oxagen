// toolbelt.ts: `toolbelt/v1`, a named toolbelt in tools/toolbelts/
// (steering-repo-spec, Toolbelts). The folder is empty on day one, when every
// agent gets the workspace's imported tools. The format is fixed now so a
// later lane reads the same file.
import { z } from "zod";
import { toolSideEffectClassSchema } from "../contracts/tool.classification";
import { toolbeltSlugSchema } from "../contracts/toolbelt.shared";
import { toolTargetSchema } from "./common";
import { uniqueArray } from "./json-schema";

export const toolbeltSchema = z
  .object({
    schema: z.literal("toolbelt/v1"),
    name: toolbeltSlugSchema.describe(
      "The toolbelt's name and the file's name: tools/toolbelts/<name>.toml.",
    ),
    label: z.string().min(1).max(80),
    description: z.string().min(1).max(200).optional(),
    tools: uniqueArray(toolTargetSchema, "tools", 1).describe(
      "Tool names across servers, and <server>__* for every imported tool of one server.",
    ),
    side_effects: uniqueArray(toolSideEffectClassSchema, "side_effects", 1)
      .optional()
      .describe("Keep only tools whose side effect is one of these."),
  })
  .strict();
export type ToolbeltFile = z.output<typeof toolbeltSchema>;
