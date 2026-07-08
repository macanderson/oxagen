import { readFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  skillFrontmatterSchema,
  type Skill,
  type SkillReference,
} from "./types";

// Frontmatter delimiter is the conventional triple-dash on its own line.
// Allow leading whitespace so authors can format the file freely.
const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;

// References-block detector: the loader scans for a "## References" heading
// (any depth >= 2) followed by a markdown list of paths. Anything outside the
// block is ignored. Bodies are not inlined here — `loadSkillFile` resolves
// them lazily by reading sibling files.
const REFERENCES_HEADING_RE = /^#{2,}\s+References\s*$/im;
const LIST_ITEM_RE = /^[-*]\s+([^\s].*?)(?:\s+→.*)?$/gm;

export interface ParseSkillOptions {
  // Source defaults to "builtin"; tenant-defined skills set this to "tenant"
  // before merge so callers can attribute provenance.
  source?: "builtin" | "tenant";
  version?: string;
}

export function parseSkill(raw: string, options: ParseSkillOptions = {}): Skill {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) {
    throw new Error("Skill file is missing YAML frontmatter");
  }
  const [, yamlBlock, body] = match;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- js-yaml parseYaml() returns any; Zod parse below validates the shape.
  const parsedYaml = parseYaml(yamlBlock ?? "");
  const frontmatter = skillFrontmatterSchema.parse(parsedYaml);

  const references = collectReferencePaths(body ?? "").map<SkillReference>(
    (path) => ({ path, body: "" }),
  );

  return {
    slug: frontmatter.name,
    name: frontmatter.name,
    description: frontmatter.description,
    metadata: frontmatter.metadata,
    body: (body ?? "").trim(),
    references,
    source: options.source ?? "builtin",
    version: options.version ?? "1.0.0",
  };
}

export async function loadSkillFile(
  path: string,
  options: ParseSkillOptions = {},
): Promise<Skill> {
  const raw = await readFile(path, "utf8");
  const skill = parseSkill(raw, options);
  // Resolve reference paths relative to the skill file's directory so
  // skill authors can drop neighbouring docs alongside the .skill.md.
  const baseDir = dirname(path);
  const resolved: SkillReference[] = await Promise.all(
    skill.references.map(async (ref) => ({
      path: ref.path,
      body: await readFile(resolvePath(baseDir, ref.path), "utf8").catch(
        (err: unknown) => {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") {
            console.warn("[skills] failed to read reference file", {
              path: resolvePath(baseDir, ref.path),
              error: err,
            });
          }
          return "";
        },
      ),
    })),
  );
  return { ...skill, references: resolved };
}

// Fenced code blocks (``` … ```) are documentation, not content — a skill that
// *explains* the References syntax (e.g. skill-builder) would otherwise have its
// example paths mistaken for real references. Strip fences before scanning.
const FENCED_BLOCK_RE = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm;

function collectReferencePaths(body: string): string[] {
  const withoutFences = body.replace(FENCED_BLOCK_RE, "");
  const headingMatch = REFERENCES_HEADING_RE.exec(withoutFences);
  if (!headingMatch) return [];
  const after = withoutFences.slice(headingMatch.index + headingMatch[0].length);
  // Stop at the next heading so we only capture the References block itself.
  const nextHeading = /\n#{1,6}\s+\S/.exec(after);
  const block = nextHeading ? after.slice(0, nextHeading.index) : after;
  const paths: string[] = [];
  for (const m of block.matchAll(LIST_ITEM_RE)) {
    const raw = m[1]?.trim();
    if (raw) paths.push(raw);
  }
  return paths;
}
