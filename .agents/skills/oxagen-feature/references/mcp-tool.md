# MCP tool

The MCP tool mirrors the capability exactly. It imports the same shared schemas and calls the same business-logic function as the API route, so parity is structural. If the API can do it, the tool can, and vice versa.

```ts
// packages/mcp-server/src/tools/<capability-name>.ts
import { <camelName>Input, <camelName>Capability } from "@oxagen/capabilities/<capability-name>";
import { run<PascalName> } from "@oxagen/capabilities/lib/<capability-name>";
import { logger } from "../logger";
import type { McpServer } from "../server";

export function register<PascalName>(server: McpServer) {
  server.tool(
    "<capability.name>",                 // same dotted name as the registry
    <camelName>Capability.description,
    <camelName>Input,                    // SAME schema object as the API
    async (input, ctx) => {
      const caller = ctx.caller;          // tenant + workspace scope from MCP session
      logger.debug("mcp <capability> invoked", { tenant: caller.tenantId });
      const result = await run<PascalName>(caller, input);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );
}
```

## Rules

- Import the identical Zod schema and the identical `run<PascalName>` function the API uses. Two call sites, one implementation.
- Tool name equals the capability's dotted registry name. The manifest checks this match.
- Resolve tenant and workspace scope from the MCP session caller, never from tool input.
- For async/batch capabilities, the tool returns the job handle, same as the API, and a companion status tool reads it. Do not make the MCP path block when the API path does not.
- Register the tool in the server's tool list so the manifest sees it.
