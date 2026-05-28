import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadSkillFile } from "./loader.js";
import type { Skill } from "./types.js";

// Recursive scan for `*.skill.md` so authors can organise built-in skills
// into category subdirectories without touching the loader. The depth is
// bounded by the filesystem; we do not follow symlinks.
export async function scanSkillsDir(root: string): Promise<Skill[]> {
  const results: Skill[] = [];
  await walk(root, results);
  return results;
}

async function walk(dir: string, out: Skill[]): Promise<void> {
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const info = await stat(full).catch(() => null);
    if (!info) continue;
    if (info.isDirectory()) {
      await walk(full, out);
      continue;
    }
    if (info.isFile() && entry.endsWith(".skill.md")) {
      const skill = await loadSkillFile(full, { source: "builtin" });
      out.push(skill);
    }
  }
}
