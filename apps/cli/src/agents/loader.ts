/**
 * loader.ts — Discover and parse named agent definitions.
 *
 * Sources, lowest → highest precedence (later overrides an earlier one by name):
 *   1. ~/.config/oxagen/agents/*.md            (user)
 *   2. <project>/.claude/agents/*.md           (Claude Code interop)
 *   3. <project>/.oxagen/agents/*.md           (oxagen project agents)
 *   4. settings.json `agents` (inline map)     (project/local, via the resolver)
 *
 * Each markdown file has YAML-ish frontmatter (name/description/tools/model) and
 * a body that becomes the system prompt. We parse the small, single-line subset
 * Claude Code's agent files use — no YAML dependency.
 */
import { join, basename } from "node:path";
import { homedir } from "node:os";
import {
  loadSettings,
  type ResolveSettingsOptions,
} from "../settings/resolve.js";
import {
  loadMarkdownRegistry,
  readMarkdownFile,
} from "../lib/markdown-registry.js";
import { oxagenProjectDir } from "../lib/oxagen-project-paths.js";
import type { AgentDefinition } from "./types.js";

export { parseFrontmatter } from "../lib/markdown-registry.js";

export interface LoadAgentsOptions {
  /** Project root (where `.oxagen`/`.claude` live). Defaults to process.cwd(). */
  cwd?: string;
  /** Override the user agents dir (testing). */
  userAgentsDir?: string;
  /** Resolver overrides so inline `settings.agents` is read from the same place (testing). */
  settingsOptions?: ResolveSettingsOptions;
}

/** Parse a `tools:` value: `a, b` or `[a, b]` → ["a","b"]; empty → undefined. */
export function parseToolList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const inner = value.trim().replace(/^\[/, "").replace(/\]$/, "");
  const list = inner
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}

function agentFromMarkdown(
  path: string,
): { key: string; value: AgentDefinition } | null {
  const fm = readMarkdownFile(path);
  if (!fm) return null;
  const { data, body } = fm;
  const name = data["name"] || basename(path).replace(/\.md$/, "");
  const description = data["description"] ?? "";
  if (!name || !body.trim()) return null; // a usable agent needs a name and a prompt
  return {
    key: name,
    value: {
      name,
      description,
      systemPrompt: body,
      tools: parseToolList(data["tools"]),
      model: data["model"] || undefined,
      // `skills` / `mcpServers` use the same comma-or-bracket list syntax as
      // `tools`, so the same parser applies.
      skills: parseToolList(data["skills"]),
      mcpServers: parseToolList(data["mcpServers"]),
      source: path,
    },
  };
}

/**
 * Load every agent definition visible from `cwd`, merged by name across sources.
 * Returns the registry keyed by agent name.
 */
export function loadAgents(
  opts: LoadAgentsOptions = {},
): Map<string, AgentDefinition> {
  const cwd = opts.cwd ?? process.cwd();
  const userDir =
    opts.userAgentsDir ?? join(homedir(), ".config", "oxagen", "agents");
  const registry = loadMarkdownRegistry(
    [userDir, join(cwd, ".claude", "agents"), oxagenProjectDir("agents", cwd)],
    agentFromMarkdown,
  );

  // Inline definitions in settings.json (highest precedence).
  const settings = loadSettings({
    cwd,
    ...opts.settingsOptions,
    noCache: true,
  }).settings;
  const inline = (settings as { agents?: Record<string, unknown> }).agents;
  if (inline && typeof inline === "object") {
    for (const [name, value] of Object.entries(inline)) {
      if (!value || typeof value !== "object") continue;
      const v = value as {
        description?: string;
        prompt?: string;
        tools?: string[];
        model?: string;
        skills?: string[];
        mcpServers?: string[];
      };
      if (!v.prompt) continue;
      registry.set(name, {
        name,
        description: v.description ?? "",
        systemPrompt: v.prompt,
        tools:
          Array.isArray(v.tools) && v.tools.length > 0 ? v.tools : undefined,
        model: v.model,
        skills:
          Array.isArray(v.skills) && v.skills.length > 0 ? v.skills : undefined,
        mcpServers:
          Array.isArray(v.mcpServers) && v.mcpServers.length > 0
            ? v.mcpServers
            : undefined,
        source: "settings.json",
      });
    }
  }

  return registry;
}

/** Resolve one agent by name (or null). Convenience over {@link loadAgents}. */
export function getAgent(
  name: string,
  opts: LoadAgentsOptions = {},
): AgentDefinition | null {
  return loadAgents(opts).get(name) ?? null;
}
