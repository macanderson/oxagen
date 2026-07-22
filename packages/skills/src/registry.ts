import { scanSkillsDir } from "./filesystem";
import type { Skill, SkillDbAdapter } from "./types";

export interface SkillRegistry {
  list(filter?: string): Promise<Skill[]>;
  get(slug: string): Promise<Skill | undefined>;
  refresh(): Promise<void>;
}

export interface CreateSkillRegistryOptions {
  // Optional embedded builtins (bundle-safe module data). Prefer this over
  // `fsRoot` for platform runtimes — see builtin.ts. Forms the base layer.
  builtins?: Skill[];
  // Optional filesystem directory of `skill.toml` bundles. Used by the CLI, which
  // ships the markdown, and by dev where the files are on disk. Overrides
  // embedded builtins on slug collision so a local edit takes effect.
  fsRoot?: string;
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
    // Merge order = precedence: embedded builtins (base) < filesystem (dev/CLI
    // override) < tenant (workspace shadow). Later layers win on slug collision.
    const merged = new Map<string, Skill>();
    for (const skill of options.builtins ?? []) merged.set(skill.slug, skill);
    if (options.fsRoot) {
      for (const skill of await scanSkillsDir(options.fsRoot)) {
        merged.set(skill.slug, skill);
      }
    }
    const tenant = options.dbAdapter ? await options.dbAdapter() : [];
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
