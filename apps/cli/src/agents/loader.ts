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
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { loadSettings, type ResolveSettingsOptions } from "../settings/resolve.js";
import type { AgentDefinition } from "./types.js";

export interface LoadAgentsOptions {
  /** Project root (where `.oxagen`/`.claude` live). Defaults to process.cwd(). */
  cwd?: string;
  /** Override the user agents dir (testing). */
  userAgentsDir?: string;
  /** Resolver overrides so inline `settings.agents` is read from the same place (testing). */
  settingsOptions?: ResolveSettingsOptions;
}

interface Frontmatter {
  data: Record<string, string>;
  body: string;
}

/** Split `---\n…\n---\nbody` into single-line key/value frontmatter + body. */
export function parseFrontmatter(raw: string): Frontmatter {
  const text = raw.replace(/^﻿/, "");
  if (!text.startsWith("---")) return { data: {}, body: text.trim() };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { data: {}, body: text.trim() };
  const header = text.slice(3, end).trim();
  const body = text.slice(end + 4).replace(/^\r?\n/, "").trim();
  const data: Record<string, string> = {};
  for (const line of header.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    let value = trimmed.slice(colon + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) data[key] = value;
  }
  return { data, body };
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

function defFromMarkdown(path: string): AgentDefinition | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const { data, body } = parseFrontmatter(raw);
  const name = data["name"] || basename(path).replace(/\.md$/, "");
  const description = data["description"] ?? "";
  if (!name || !body.trim()) return null; // a usable agent needs a name and a prompt
  return {
    name,
    description,
    systemPrompt: body,
    tools: parseToolList(data["tools"]),
    model: data["model"] || undefined,
    source: path,
  };
}

function loadDir(dir: string, into: Map<string, AgentDefinition>): void {
  if (!existsSync(dir)) return;
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return;
  }
  for (const file of files.sort()) {
    const def = defFromMarkdown(join(dir, file));
    if (def) into.set(def.name, def);
  }
}

/**
 * Load every agent definition visible from `cwd`, merged by name across sources.
 * Returns the registry keyed by agent name.
 */
export function loadAgents(opts: LoadAgentsOptions = {}): Map<string, AgentDefinition> {
  const cwd = opts.cwd ?? process.cwd();
  const userDir = opts.userAgentsDir ?? join(homedir(), ".config", "oxagen", "agents");
  const registry = new Map<string, AgentDefinition>();

  loadDir(userDir, registry);
  loadDir(join(cwd, ".claude", "agents"), registry);
  loadDir(join(cwd, ".oxagen", "agents"), registry);

  // Inline definitions in settings.json (highest precedence).
  const settings = loadSettings({ cwd, ...opts.settingsOptions, noCache: true }).settings;
  const inline = (settings as { agents?: Record<string, unknown> }).agents;
  if (inline && typeof inline === "object") {
    for (const [name, value] of Object.entries(inline)) {
      if (!value || typeof value !== "object") continue;
      const v = value as { description?: string; prompt?: string; tools?: string[]; model?: string };
      if (!v.prompt) continue;
      registry.set(name, {
        name,
        description: v.description ?? "",
        systemPrompt: v.prompt,
        tools: Array.isArray(v.tools) && v.tools.length > 0 ? v.tools : undefined,
        model: v.model,
        source: "settings.json",
      });
    }
  }

  return registry;
}

/** Resolve one agent by name (or null). Convenience over {@link loadAgents}. */
export function getAgent(name: string, opts: LoadAgentsOptions = {}): AgentDefinition | null {
  return loadAgents(opts).get(name) ?? null;
}
