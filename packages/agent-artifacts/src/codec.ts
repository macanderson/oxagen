import { parse, stringify } from "smol-toml";
import { artifactSchema } from "./schemas";
import type { Artifact } from "./types";
import { AgentArtifactError } from "./errors";

export function parseArtifactToml(raw: string): Artifact {
  let parsed: unknown;
  try {
    parsed = parse(raw.replaceAll("\r\n", "\n"));
  } catch (error) {
    throw new AgentArtifactError(
      "invalid_artifact_toml",
      "TOML parsing failed",
      {
        cause: error,
      },
    );
  }

  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "schema_version" in parsed &&
    parsed.schema_version !== 1
  ) {
    throw new AgentArtifactError(
      "unsupported_schema_version",
      `expected schema_version 1, received ${String(parsed.schema_version)}`,
    );
  }

  const result = artifactSchema.safeParse(parsed);
  if (!result.success) {
    throw new AgentArtifactError(
      "invalid_artifact",
      result.error.issues
        .map(
          (issue) => `${issue.path.join(".") || "artifact"}: ${issue.message}`,
        )
        .join("; "),
      { cause: result.error },
    );
  }
  return result.data;
}

export function serializeArtifactToml(value: Artifact): string {
  const artifact = artifactSchema.parse(value);
  const serialized = stringify(artifact as unknown as Record<string, unknown>)
    .replaceAll("\r\n", "\n")
    .trimEnd();
  return `${serialized}\n`;
}
