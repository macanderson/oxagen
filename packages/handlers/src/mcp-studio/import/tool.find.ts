// tool.find.ts: find one tool in a built Studio folder by the name a person
// types. Draft (description.draft.ts) and Try it (tool.try.ts) both name a
// tool the same way, so they share this lookup.
import type { CompiledTool, UpstreamTool } from "@oxagen/mcp-studio";
import { selectedName, type BuiltFolder } from "./build";

/** One tool in a built folder, imported or only offered by the source. */
export interface StudioToolTarget {
  /** The tools.toml key, or null for a tool the folder has not imported. */
  key: string | null;
  /** The name the agent sees: the served name, or the upstream name before import. */
  name: string;
  title: string | undefined;
  /** The description the tool is served with today, when it has one. */
  current: string | undefined;
  upstream: UpstreamTool;
  inputSchema: unknown;
  outputSchema: unknown;
  classification: CompiledTool["classification"] | null;
}

function compiledTarget(key: string, tool: CompiledTool): StudioToolTarget {
  return {
    key,
    name: tool.definition.name,
    title: tool.definition.title,
    current: tool.definition.description,
    upstream: tool.upstream,
    inputSchema: tool.definition.inputSchema,
    outputSchema: tool.definition.outputSchema,
    classification: tool.classification,
  };
}

/**
 * The tool `name` names, in this order: a tools.toml key, a served name, the
 * upstream name a compiled tool selects, then a tool the source offers.
 */
export function findStudioTool(folder: BuiltFolder, name: string): StudioToolTarget | null {
  const entries = Object.entries(folder.tools);
  const byKey = Object.hasOwn(folder.tools, name) ? folder.tools[name] : undefined;
  if (byKey !== undefined) return compiledTarget(name, byKey);
  const served = entries.find(([, tool]) => tool.definition.name === name);
  if (served !== undefined) return compiledTarget(...served);
  const selecting = entries.find(([, tool]) => selectedName(tool.upstream) === name || tool.upstream.name === name);
  if (selecting !== undefined) return compiledTarget(...selecting);
  const offered =
    folder.offered.find((tool) => selectedName(tool) === name) ?? folder.offered.find((tool) => tool.name === name);
  if (offered === undefined) return null;
  return {
    key: null,
    name: offered.name,
    title: offered.title,
    current: offered.description,
    upstream: offered,
    inputSchema: offered.inputSchema,
    outputSchema: offered.outputSchema,
    classification: null,
  };
}
