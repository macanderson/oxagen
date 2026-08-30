import type { Artifact } from "@oxagen/agent-artifacts";
import { mapForeignTools, TOOL_MAPPING_VERSION } from "./tool-mappings.js";
import type { ImportCandidate, NormalizedImport } from "./types.js";

export function normalizeArtifactSlug(value: string): string {
  return (
    value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "imported-artifact"
  );
}

function normalizeModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const lower = model.toLowerCase();
  if (
    lower.includes("haiku") ||
    lower.includes("mini") ||
    lower.includes("fast")
  )
    return "fast";
  if (lower.includes("opus") || lower.includes("max")) return "powerful";
  if (lower.includes("sonnet") || lower.includes("balanced")) return "balanced";
  return model;
}

export function normalizeImportCandidate(
  candidate: ImportCandidate,
  options: {
    toolCatalog: ReadonlySet<string>;
    mcpMappings?: Readonly<Record<string, string>>;
  },
): NormalizedImport {
  const name = normalizeArtifactSlug(candidate.name);
  let artifact: Artifact;
  // Skills and commands carry no tool mapping, so they record the catalogue's
  // current version verbatim; agents overwrite it with the version the mapper
  // actually applied. Never re-spell the literal here — a bump in
  // tool-mappings.ts must reach every receipt.
  let mappingVersion: string = TOOL_MAPPING_VERSION;
  const diagnostics = [...candidate.diagnostics];

  if (candidate.kind === "agent") {
    const mapping = mapForeignTools(
      candidate.platform,
      candidate.toolNames,
      options.toolCatalog,
      options.mcpMappings,
    );
    mappingVersion = mapping.mappingVersion;
    artifact = {
      schema_version: 1,
      kind: "agent",
      name,
      description: candidate.description || "Imported agent",
      ...(normalizeModel(candidate.model)
        ? { model: normalizeModel(candidate.model) }
        : {}),
      developer_instructions: candidate.body,
      tools: mapping.mapped,
      skills: candidate.skillNames.map(normalizeArtifactSlug),
      unresolved_tools: mapping.unresolved.map((entry) => entry.sourceName),
    };
    diagnostics.push(
      ...mapping.unresolved.map((entry) => ({
        code: `unresolved_tool_${entry.reason}`,
        message: `${entry.sourceName} was preserved for review`,
      })),
    );
  } else if (candidate.kind === "skill") {
    artifact = {
      schema_version: 1,
      kind: "skill",
      name,
      description: candidate.description || "Imported skill",
      instructions: candidate.body,
      references: candidate.references,
    };
  } else {
    artifact = {
      schema_version: 1,
      kind: "command",
      name,
      description: candidate.description || "Imported command",
      prompt: candidate.body,
      ...(normalizeModel(candidate.model)
        ? { model: normalizeModel(candidate.model) }
        : {}),
    };
  }

  return {
    candidate,
    artifact,
    state:
      artifact.kind === "agent" && artifact.unresolved_tools.length > 0
        ? "needs_review"
        : "ready",
    diagnostics,
    mappingVersion,
  };
}
