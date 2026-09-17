import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { tachoHostList } from "@oxagen/oxagen/contracts/tacho.host.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...tachoHostList.input.shape,
  status: tachoHostList.input.shape.status.describe(
    "Only hosts in this state (active, paused, suspended, revoked)",
  ),
  limit: tachoHostList.input.shape.limit.describe("How many hosts to return"),
  cursor: tachoHostList.input.shape.cursor.describe(
    "Opaque cursor from a previous page's nextCursor",
  ),
};

export const metadata: ToolMetadata = {
  name: tachoHostList.name,
  description:
    // Names the tier in the tool description, because a model reading a fleet
    // listing has to know that `harnesses` and `tiers` say different things:
    // one is which apps are covered, the other is what that coverage means.
    "List the machines enrolled as Tacho hosts in this workspace with their status, liveness, counters, and the enforcement tier each of their harnesses reaches (harness = wrapped through a hook, records every action but is client-attested; gateway = connected through the MCP gateway, records only Oxagen tool calls but refuses them server-side).",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function tachoHostListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(tachoHostList.name, args, ctx, {
    surface: "mcp",
  });
  return tachoHostList.output.parse(output);
}
