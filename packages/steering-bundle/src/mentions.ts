// mentions.ts: renders a body's @tool: mentions for each tool's exposure mode
// (steering-repo-spec, Records and mentions).
//
// A search-mode tool is absent from the agent's tool list, so a mention that
// names it would name a tool the agent cannot see. Publish writes the mention
// as the agent can call it: the tool's name in direct mode, and the server's
// call tool in search mode. A mode change then needs no edit to any record.
// @record: and @skill: mentions stay as written: the agent reads them with
// read_steering.
import type { Bundle } from "@oxagen/oxagen/steering-repo/bundle";
import { parseToolRef, TOOL_SEPARATOR } from "@oxagen/oxagen/steering-repo/names";

export type ExposureMode = "direct" | "search";

/** Each server's exposure mode, by server name. A server not listed is direct. */
export type ToolModes = ReadonlyMap<string, ExposureMode>;

const TOOL_MENTION = /@tool:([a-z0-9][a-z0-9._-]*[a-z0-9])/g;

/** How one tool is named to the agent in its server's mode. */
export function toolMentionText(name: string, modes: ToolModes): string {
  const ref = parseToolRef(name);
  if (ref === null) return name;
  if (modes.get(ref.server) !== "search") return name;
  return `call ${ref.server}${TOOL_SEPARATOR}call with tool ${ref.tool}`;
}

/** The body with every @tool: mention rendered for its tool's mode. */
export function renderMentions(body: string, modes: ToolModes): string {
  return body.replace(TOOL_MENTION, (_match, name: string) =>
    toolMentionText(name, modes),
  );
}

/**
 * The modes a published version's tool manifest records. Before the tools
 * compile, the manifest is null and every server reads as direct.
 */
export function toolModesOf(bundle: Pick<Bundle, "tools">): ToolModes {
  const modes = new Map<string, ExposureMode>();
  const servers: unknown = bundle.tools?.["servers"];
  if (!Array.isArray(servers)) return modes;
  for (const server of servers as unknown[]) {
    if (typeof server !== "object" || server === null) continue;
    const { name, exposure } = server as { name?: unknown; exposure?: { mode?: unknown } };
    if (typeof name !== "string") continue;
    if (exposure?.mode === "search") modes.set(name, "search");
    else if (exposure?.mode === "direct") modes.set(name, "direct");
  }
  return modes;
}
