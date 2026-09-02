import { readFile } from "node:fs/promises";
import {
  parseArtifactToml,
  resolveContainedPath,
} from "@oxagen/agent-artifacts";
import {
  skillMetadataProjectionSchema,
  type Skill,
  type SkillReference,
} from "./types";

export interface ParseSkillOptions {
  /** Provenance stamped on the result. Defaults to `"builtin"`. */
  source?: "builtin" | "tenant";
  /** Version stamped on the result. Defaults to `"1.0.0"`. */
  version?: string;
}

/**
 * Parse one canonical `skill.toml` document into a {@link Skill}. Pure and
 * synchronous — reference bodies stay empty here; {@link loadSkillFile} fills
 * them from disk.
 *
 * Throws if the document is not valid artifact TOML, is not `kind = "skill"`,
 * or fails the metadata projection (a slug must be kebab-case, and both name
 * and description must be non-empty).
 */
export function parseSkill(
  raw: string,
  options: ParseSkillOptions = {},
): Skill {
  const artifact = parseArtifactToml(raw);
  if (artifact.kind !== "skill") {
    throw new Error(
      `invalid_skill_artifact: expected skill, received ${artifact.kind}`,
    );
  }
  const projection = skillMetadataProjectionSchema.parse({
    name: artifact.name,
    description: artifact.description,
    metadata: artifact.metadata,
  });
  return {
    slug: artifact.name,
    name: artifact.name,
    description: artifact.description,
    metadata: projection.metadata,
    body: artifact.instructions.trim(),
    references: artifact.references.map((path) => ({ path, body: "" })),
    source: options.source ?? "builtin",
    version: options.version ?? "1.0.0",
  };
}

/**
 * Read a `skill.toml` from disk and resolve every declared reference body.
 *
 * A malformed manifest rejects — the caller decides whether that is fatal. A
 * reference that escapes the bundle directory also rejects. A reference that is
 * merely unreadable degrades to an empty body and is logged.
 */
export async function loadSkillFile(
  path: string,
  options: ParseSkillOptions = {},
): Promise<Skill> {
  const raw = await readFile(path, "utf8");
  const skill = parseSkill(raw, options);
  const references: SkillReference[] = await Promise.all(
    skill.references.map(async (reference) => {
      const contained = await resolveContainedPath(path, reference.path);
      return {
        path: reference.path,
        // An unreadable reference degrades to an empty body so one bad sibling
        // file does not sink the whole skill — but every failure is logged,
        // ENOENT included, so a manifest pointing at a file nobody shipped is
        // visible instead of silently yielding an empty reference.
        body: await readFile(contained, "utf8").catch((error: unknown) => {
          const code = (error as NodeJS.ErrnoException).code;
          console.warn(
            code === "ENOENT"
              ? "[skills] reference file missing — using empty body"
              : "[skills] failed to read reference file — using empty body",
            {
              skill: path,
              reference: reference.path,
              resolved: contained,
              error,
            },
          );
          return "";
        }),
      };
    }),
  );
  return { ...skill, references };
}
