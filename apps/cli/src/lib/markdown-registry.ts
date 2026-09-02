/**
 * markdown-registry.ts — Shared plumbing behind the markdown-backed registries
 * (`../rules/` and `../prompts/`): frontmatter parsing, merging directories of
 * `.md` files into a precedence-ordered Map, and scaffolding a fresh starter
 * file. Each registry supplies its own field mapping and id derivation via a
 * `parseEntry` callback — this module only owns the walk, the merge-by-key,
 * and the file I/O.
 *
 * Agents and slash commands do NOT use this module: they are canonical TOML
 * artifacts parsed by `@oxagen/agent-artifacts` (see `../agents/loader.ts` and
 * `../slash/loader.ts`).
 */
import {
  readFileSync,
  readdirSync,
  existsSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join, dirname } from "node:path";

export interface Frontmatter {
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
  const body = text
    .slice(end + 4)
    .replace(/^\r?\n/, "")
    .trim();
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

/** Read and frontmatter-parse one markdown file; `null` if it can't be read. */
export function readMarkdownFile(path: string): Frontmatter | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  return parseFrontmatter(raw);
}

/**
 * Load every `.md` file across `dirs`, in precedence order (a later dir
 * overrides an earlier one by key). `parseEntry` maps a file path to its
 * registry key + value, or `null` to skip the file.
 */
export function loadMarkdownRegistry<T>(
  dirs: string[],
  parseEntry: (path: string) => { key: string; value: T } | null,
): Map<string, T> {
  const registry = new Map<string, T>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const file of files.sort()) {
      const entry = parseEntry(join(dir, file));
      if (entry) registry.set(entry.key, entry.value);
    }
  }
  return registry;
}

/** Write a starter markdown file to `<dir>/<name>.md`, unless it already exists. */
export function scaffoldMarkdownFile(opts: {
  dir: string;
  name: string;
  template: (name: string) => string;
}): { path: string; created: boolean } {
  const path = join(opts.dir, `${opts.name}.md`);
  if (existsSync(path)) return { path, created: false };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, opts.template(opts.name), "utf8");
  return { path, created: true };
}
