import type { ImportPlatform, UnresolvedTool } from "./types.js";

export const TOOL_MAPPING_VERSION = "2026-07-21.1";

const MAPPINGS: Record<
  ImportPlatform,
  Readonly<Record<string, readonly string[]>>
> = {
  claude: {
    Read: ["read_file", "list_dir", "glob", "grep"],
    Write: ["write_file"],
    Edit: ["edit_file"],
    Grep: ["grep"],
    Glob: ["glob"],
    Bash: ["bash"],
    WebFetch: ["fetch_web"],
    WebSearch: ["search_web"],
  },
  codex: {
    read_file: ["read_file"],
    write_file: ["write_file"],
    edit_file: ["edit_file"],
    list_dir: ["list_dir"],
    glob: ["glob"],
    grep: ["grep"],
    bash: ["bash"],
  },
  cursor: {
    Read: ["read_file", "list_dir", "glob", "grep"],
    Write: ["write_file"],
    Edit: ["edit_file"],
    Terminal: ["bash"],
    Shell: ["bash"],
    Grep: ["grep"],
  },
  "oxagen-legacy": {
    Read: ["read_file", "list_dir", "glob", "grep"],
    Write: ["write_file"],
    Edit: ["edit_file"],
    Grep: ["grep"],
    Glob: ["glob"],
    Bash: ["bash"],
  },
};

export function mapForeignTools(
  platform: ImportPlatform,
  names: readonly string[],
  catalog: ReadonlySet<string>,
  mcpMappings: Readonly<Record<string, string>> = {},
): { mapped: string[]; unresolved: UnresolvedTool[]; mappingVersion: string } {
  const mapped: string[] = [];
  const unresolved: UnresolvedTool[] = [];
  const seen = new Set<string>();

  for (const sourceName of names) {
    let targets: readonly string[] | undefined;
    const mcpMatch = /^mcp__([^_]+)__(.+)$/.exec(sourceName);
    if (mcpMatch) {
      const key = `${mcpMatch[1]}:${mcpMatch[2]}`;
      const resolved = mcpMappings[key];
      if (resolved) targets = [resolved];
      else {
        unresolved.push({ sourceName, reason: "ambiguous_mcp" });
        continue;
      }
    } else {
      targets = MAPPINGS[platform][sourceName];
      if (!targets && platform === "codex" && catalog.has(sourceName)) {
        targets = [sourceName];
      }
    }

    if (!targets) {
      unresolved.push({ sourceName, reason: "unknown_mapping" });
      continue;
    }
    const unavailable = targets.filter((target) => !catalog.has(target));
    if (unavailable.length > 0) {
      unresolved.push({
        sourceName,
        reason: "target_unavailable",
        suggestedTargets: [...targets],
      });
      continue;
    }
    for (const target of targets) {
      if (!seen.has(target)) mapped.push(target);
      seen.add(target);
    }
  }

  return { mapped, unresolved, mappingVersion: TOOL_MAPPING_VERSION };
}
