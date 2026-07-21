import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadSkillFile } from "./loader";
import type { Skill } from "./types";

// Recursive scan for `skill.toml` bundles so authors can organise built-in skills
// into category subdirectories without touching the loader. The depth is
// bounded by the filesystem; we do not follow symlinks.
export async function scanSkillsDir(root: string): Promise<Skill[]> {
  const results: Skill[] = [];
  await walk(root, results);
  return results;
}

async function walk(dir: string, out: Skill[]): Promise<void> {
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[skills] failed to read directory", { dir, error: err });
    }
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, out);
      continue;
    }
    if (entry.isFile() && entry.name === "skill.toml") {
      try {
        const skill = await loadSkillFile(full, { source: "builtin" });
        out.push(skill);
      } catch (err: unknown) {
        // A single corrupt or unparseable skill file must not abort the whole
        // scan and break every skill lookup for the process. Surface the
        // offending path so the author can fix it; continue with the rest.
        console.warn("[skills] failed to load skill file — skipping", {
          path: full,
          error: err,
        });
      }
    }
  }
}
