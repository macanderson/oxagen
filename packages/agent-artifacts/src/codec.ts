import { parse, stringify } from "smol-toml";
import { artifactSchema } from "./schemas";
import type { Artifact } from "./types";
import { AgentArtifactError } from "./errors";

/**
 * Reads artifact TOML into a validated artifact.
 *
 * Line endings are normalized to `\n` first so the same file authored on
 * Windows and on macOS parses — and later hashes — identically. The
 * `schema_version` check runs before validation so a future artifact gets a
 * "this build is too old" error instead of a wall of unknown-field complaints.
 *
 * @throws {AgentArtifactError} `invalid_artifact_toml` if the bytes are not
 * TOML, `unsupported_schema_version` if the version is not 1, or
 * `invalid_artifact` if validation fails.
 */
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

/**
 * Writes an artifact back out as the one canonical TOML spelling for its
 * contents — the bytes `hashArtifact` hashes.
 *
 * Determinism comes from re-validating first: the parse result's keys follow
 * the schema's declaration order rather than the caller's, and defaults are
 * filled in, so two artifacts with the same meaning serialize to the same
 * bytes. Output always ends in exactly one newline.
 *
 * That guarantee stops at the two open-ended maps in the schema — a skill's
 * `metadata` and an invocation's `input`. Zod keeps a map's keys in the order
 * they arrived, so the same pairs written in a different order serialize to
 * different bytes and therefore hash differently. Build those maps in a fixed
 * order if the hash has to be reproducible.
 *
 * TOML has no null, and the two ways a null can reach here both go badly.
 * `smol-toml` drops a null-valued key without complaint, which turns a
 * `literal = null` binding into an empty table that `parseArtifactToml` then
 * rejects; a null inside an array throws a bare `TypeError` out of the
 * serializer. Keep nulls out of `literal` values.
 *
 * @throws {z.ZodError} if `value` does not validate — unlike
 * `parseArtifactToml`, this does not wrap the failure in `AgentArtifactError`.
 */
export function serializeArtifactToml(value: Artifact): string {
  const artifact = artifactSchema.parse(value);
  const serialized = stringify(artifact as unknown as Record<string, unknown>)
    .replaceAll("\r\n", "\n")
    .trimEnd();
  return `${serialized}\n`;
}
