import {
  parseArtifactToml,
  serializeArtifactToml,
  type SkillArtifact,
} from "@oxagen/agent-artifacts";

/** Narrow the open built-in metadata projection to canonical TOML strings. */
export function canonicalSkillMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (!metadata) return undefined;
  const entries = Object.entries(metadata).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export interface CanonicalSkillArtifact {
  artifact: SkillArtifact;
  content: string;
  referencesPayload: Array<{ path: string; body: string }>;
}

/** Validate untrusted TOML and normalize it before any persistence. */
export function canonicalizeSkillArtifact(
  untrustedContent: string,
): CanonicalSkillArtifact {
  const artifact = parseArtifactToml(untrustedContent);
  if (artifact.kind !== "skill") {
    throw new Error(
      `invalid_skill_artifact: expected skill, received ${artifact.kind}`,
    );
  }
  return {
    artifact,
    content: serializeArtifactToml(artifact),
    referencesPayload: artifact.references.map((path) => ({ path, body: "" })),
  };
}
