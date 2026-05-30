import { organizationCreate } from "@oxagen/oxagen/contracts/organization.create";
import { organizationCreateHandler } from "@oxagen/handlers/organization.create";
import { placeholderContext } from "../context.js";
import type { McpTool } from "../server.js";

export const organizationCreateTool: McpTool = {
  name: organizationCreate.name,
  description: organizationCreate.description,
  invoke: async (raw) => {
    const input = organizationCreate.input.parse(raw);
    const output = await organizationCreateHandler(input, placeholderContext());
    return organizationCreate.output.parse(output);
  },
};
