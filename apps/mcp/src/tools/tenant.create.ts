import { tenantCreate } from "@oxagen/oxagen/capabilities/tenant.create";
import { tenantCreateHandler } from "@oxagen/handlers/tenant.create";
import { placeholderContext } from "../context.js";
import type { McpTool } from "../server.js";

export const tenantCreateTool: McpTool = {
  name: tenantCreate.name,
  description: tenantCreate.description,
  invoke: async (raw) => {
    const input = tenantCreate.input.parse(raw);
    const output = await tenantCreateHandler(input, placeholderContext());
    return tenantCreate.output.parse(output);
  },
};
