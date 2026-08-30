import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadSkillFile } from "./loader";
import type { Skill } from "./types";

// Recursive scan for `skill.toml` bundles, reached only through the registry's
// opt-in `fsRoot` option — platform runtimes use the embedded builtins instead
// (see builtin.ts). Recursion is unbounded in depth but terminates: a symlink
// reports neither `isDirectory()` nor `isFile()` from `readdir(withFileTypes)`,
// so symlinked directories are never descended into and symlinked manifests are
// never read, which also rules out a symlink cycle.
//
// Bundles nested more than one directory below the root are found here but NOT
// by the CLI, whose discovery is deliberately one level deep
// (apps/cli/src/skills/loader.ts). Keep shipped bundles flat.
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
