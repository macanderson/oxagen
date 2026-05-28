import { scanSkillsDir } from "./filesystem.js";
import type { Skill, SkillDbAdapter } from "./types.js";

export interface SkillRegistry {
  list(filter?: string): Promise<Skill[]>;
  get(slug: string): Promise<Skill | undefined>;
  refresh(): Promise<void>;
}

export interface CreateSkillRegistryOptions {
  fsRoot: string;
  // Optional adapter that yields tenant-defined skills. Callers wire this
  // to a Drizzle query in the API handler; the skills package stays
  // database-agnostic.
  dbAdapter?: SkillDbAdapter;
}

export function createSkillRegistry(
  options: CreateSkillRegistryOptions,
): SkillRegistry {
  let cache: Skill[] | null = null;

  async function load(): Promise<Skill[]> {
    if (cache) return cache;
    const fs = await scanSkillsDir(options.fsRoot);
    const tenant = options.dbAdapter ? await options.dbAdapter() : [];
    // Tenant skills win on slug collision — workspaces can shadow built-ins
    // intentionally without filesystem edits.
    const merged = new Map<string, Skill>();
    for (const skill of fs) merged.set(skill.slug, skill);
    for (const skill of tenant) merged.set(skill.slug, skill);
    cache = Array.from(merged.values());
    return cache;
  }

  return {
    async list(filter) {
      const skills = await load();
      if (!filter) return skills;
      const needle = filter.toLowerCase();
      return skills.filter(
        (s) =>
          s.slug.toLowerCase().includes(needle) ||
          s.name.toLowerCase().includes(needle) ||
          s.description.toLowerCase().includes(needle),
      );
    },
    async get(slug) {
      const skills = await load();
      return skills.find((s) => s.slug === slug);
    },
    async refresh() {
      cache = null;
    },
  };
}
