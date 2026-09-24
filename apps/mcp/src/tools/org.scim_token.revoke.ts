import { type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { orgScimTokenRevoke } from "@oxagen/oxagen/contracts/org.scim_token.revoke";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

// Revoking is on MCP; minting and rotating are not, because their answer is
// the token itself and a tool result lands in an agent's transcript (#3734).
export const schema = {};

export const metadata: ToolMetadata = {
  name: orgScimTokenRevoke.name,
  description: orgScimTokenRevoke.description,
  annotations: {
    readOnlyHint: false,
    // The identity provider can no longer push until someone mints a token.
    destructiveHint: true,
    idempotentHint: true,
  },
};

export default async function orgScimTokenRevokeTool() {
  const ctx = await buildContext(headers());
  const output = await invoke(orgScimTokenRevoke.name, {}, ctx, {
    surface: "mcp",
  });
  return orgScimTokenRevoke.output.parse(output);
}
