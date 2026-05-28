import { workspaceCreate } from "@oxagen/oxagen/capabilities/workspace.create";
import { workspaceCreateHandler } from "@oxagen/handlers/workspace.create";
import { placeholderContext } from "../context.js";
import type { McpTool } from "../server.js";

export const workspaceCreateTool: McpTool = {
  name: workspaceCreate.name,
  description: workspaceCreate.description,
  invoke: async (raw) => {
    const input = workspaceCreate.input.parse(raw);
    const output = await workspaceCreateHandler(input, placeholderContext());
    return workspaceCreate.output.parse(output);
  },
};
