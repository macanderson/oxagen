// load_tools: the belt definitions meta-tool outside a turn (MC spec §6.6).
// The belt here is the registry's capabilities exposed on the `agent`
// surface that the org is entitled to, the filter materializeTools() builds
// the in-app agent's tools through; a name outside it describes nothing and
// travels back as unknown.
import type {
  ToolsLoadInput,
  ToolsLoadOutput,
} from "@oxagen/oxagen/contracts/tools.load";
import { getOxagenRegistry, type RegistryCapability } from "../registry-loader";
import { inputJsonSchema } from "../runtime/engine/tools";
import { isMutatingCapability } from "../runtime/materialize-tools";
import { createEntitlementFilter } from "../runtime/plugin-entitlement";
import type { CapabilityContext } from "../types";

/**
 * The capabilities the in-app agent may call: those exposed on the agent
 * surface, less any a plugin claims that the org has not installed.
 */
export async function assistantBelt(
  ctx: CapabilityContext,
): Promise<RegistryCapability[]> {
  const { listCapabilities, getSurfaces } = await getOxagenRegistry();
  const isEntitled = createEntitlementFilter(ctx);
  const belt: RegistryCapability[] = [];
  for (const cap of listCapabilities()) {
    if (getSurfaces(cap).includes("agent") && (await isEntitled(cap.name)))
      belt.push(cap);
  }
  return belt;
}

export async function toolsLoadHandler(
  input: ToolsLoadInput,
  ctx: CapabilityContext,
): Promise<ToolsLoadOutput> {
  const belt = new Map(
    (await assistantBelt(ctx)).map((cap) => [cap.name, cap]),
  );
  const tools: ToolsLoadOutput["tools"] = [];
  const unknown: string[] = [];
  for (const name of input.names) {
    const cap = belt.get(name);
    if (!cap) {
      unknown.push(name);
      continue;
    }
    const schema = await inputJsonSchema(cap.input);
    tools.push({
      name: cap.name,
      description: cap.description,
      inputSchema:
        typeof schema === "object" && schema !== null && !Array.isArray(schema)
          ? (schema as Record<string, unknown>)
          : { type: "object" },
      riskLevel: cap.agent?.riskLevel ?? "low",
      requiresApproval: cap.agent?.requiresApproval === true,
      readOnly: !isMutatingCapability(cap),
    });
  }
  return { tools, unknown };
}
