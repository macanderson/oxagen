import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
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
  source?: "builtin" | "tenant";
  version?: string;
}

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

export async function loadSkillFile(
  path: string,
  options: ParseSkillOptions = {},
): Promise<Skill> {
  const raw = await readFile(path, "utf8");
  const skill = parseSkill(raw, options);
  const baseDir = dirname(path);
  const references: SkillReference[] = await Promise.all(
    skill.references.map(async (reference) => {
      const contained = await resolveContainedPath(path, reference.path);
      return {
        path: reference.path,
        body: await readFile(contained, "utf8").catch((error: unknown) => {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") {
            console.warn("[skills] failed to read reference file", {
              path: contained,
              baseDir,
              error,
            });
          }
          return "";
        }),
      };
    }),
  );
  return { ...skill, references };
}
