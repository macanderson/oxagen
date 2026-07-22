import { createHash } from "node:crypto";
import {
  parseArtifactToml,
  serializeArtifactToml,
  type SkillArtifact,
} from "@oxagen/agent-artifacts";
import { parse as parseYaml } from "yaml";

/**
 * Classification of a persisted `agent.skill_versions.body`.
 *
 * The TOML cutover made canonical `skill.toml` the stored form, but rows
 * written before it still hold Markdown with YAML frontmatter. Those rows now
 * fail every read path that calls `canonicalizeSkillArtifact`, so they must be
 * converted — but only when the conversion is unambiguous. A row we cannot
 * convert with certainty is reported, never guessed at.
 *
 * This module is pure: it neither reads nor writes the database, so the
 * decision rules are unit-testable without a tenant or a connection.
 */
export type SkillBodyClassification =
  | { kind: "canonical"; artifact: SkillArtifact }
  | { kind: "convertible"; artifact: SkillArtifact; content: string }
  | { kind: "ambiguous"; reason: AmbiguityReason; detail?: string };

export type AmbiguityReason =
  | "non_skill_toml"
  | "no_frontmatter"
  | "unparseable_frontmatter"
  | "missing_description"
  | "empty_instructions"
  | "unsafe_reference"
  | "invalid_slug"
  | "invalid_artifact";

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** SHA-256 hex over a body, matching the skill_versions.checksum contract. */
export function hashSkillBody(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

function splitFrontmatter(
  raw: string,
): { data: Record<string, unknown>; body: string } | null {
  const normalized = raw.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) return null;
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) return null;
  let parsed: unknown;
  try {
    parsed = parseYaml(normalized.slice(4, end));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return null;
  return {
    data: parsed as Record<string, unknown>,
    body: normalized.slice(end + 5).trim(),
  };
}

/** A contained, bundle-relative path — the same rule the artifact schema applies. */
function isContainedPath(value: string): boolean {
  if (value.startsWith("/") || value.startsWith("\\")) return false;
  return !value
    .replaceAll("\\", "/")
    .split("/")
    .some((segment) => segment === ".." || segment === "");
}

function stringList(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    if (!value.every((item) => typeof item === "string")) return null;
    return value as string[];
  }
  return null;
}

/**
 * Decide what to do with one stored skill body.
 *
 * `slug` is the row's workspace-unique identity and is authoritative for the
 * artifact name — the frontmatter `name` was a display value and is not
 * trusted to define identity.
 */
export function classifySkillBody(
  body: string,
  options: { slug: string },
): SkillBodyClassification {
  // 1. Already canonical? Then this row needs nothing — which is what makes
  //    the backfill idempotent under reruns.
  try {
    const artifact = parseArtifactToml(body);
    return artifact.kind === "skill"
      ? { kind: "canonical", artifact }
      : {
          kind: "ambiguous",
          reason: "non_skill_toml",
          detail: `parsed as kind="${artifact.kind}"`,
        };
  } catch {
    // Not TOML — fall through to the legacy Markdown path.
  }

  if (!KEBAB.test(options.slug))
    return {
      kind: "ambiguous",
      reason: "invalid_slug",
      detail: options.slug,
    };

  const parsed = splitFrontmatter(body);
  if (!parsed)
    return {
      kind: "ambiguous",
      reason: body.trimStart().startsWith("---")
        ? "unparseable_frontmatter"
        : "no_frontmatter",
    };

  const description =
    typeof parsed.data.description === "string"
      ? parsed.data.description.trim()
      : "";
  if (!description) return { kind: "ambiguous", reason: "missing_description" };

  if (!parsed.body) return { kind: "ambiguous", reason: "empty_instructions" };

  const references = stringList(parsed.data.references);
  if (references === null)
    return {
      kind: "ambiguous",
      reason: "unsafe_reference",
      detail: "references is not a list of strings",
    };
  const escaping = references.find((path) => !isContainedPath(path));
  if (escaping)
    return { kind: "ambiguous", reason: "unsafe_reference", detail: escaping };

  // Only carry metadata we can represent losslessly as string→string.
  const metadata: Record<string, string> = {};
  for (const key of ["weight", "category"]) {
    const value = parsed.data[key];
    if (typeof value === "string" && value.trim()) metadata[key] = value.trim();
  }

  const artifact: SkillArtifact = {
    schema_version: 1,
    kind: "skill",
    name: options.slug,
    description,
    instructions: parsed.body,
    references,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };

  // Never emit something the runtime cannot read back.
  let content: string;
  try {
    content = serializeArtifactToml(artifact);
    parseArtifactToml(content);
  } catch (error) {
    return {
      kind: "ambiguous",
      reason: "invalid_artifact",
      detail: error instanceof Error ? error.message : "serialization failed",
    };
  }

  return { kind: "convertible", artifact, content };
}

export interface SkillVersionRow {
  id: string;
  publicId: string;
  orgId: string;
  workspaceId: string;
  skillId: string;
  slug: string;
  versionNumber: number;
  body: string;
  legacyBody: string | null;
}

export interface BackfillPlanItem {
  row: SkillVersionRow;
  classification: SkillBodyClassification;
}

export interface BackfillPlan {
  convertible: BackfillPlanItem[];
  canonical: BackfillPlanItem[];
  ambiguous: BackfillPlanItem[];
}

/**
 * Partition rows into what will be converted, what is already fine, and what a
 * human must look at. A row that already carries `legacyBody` was converted by
 * an earlier run and is treated as canonical regardless of its current body —
 * re-running must never double-convert or overwrite preserved provenance.
 */
export function planSkillBackfill(
  rows: readonly SkillVersionRow[],
): BackfillPlan {
  const plan: BackfillPlan = { convertible: [], canonical: [], ambiguous: [] };
  for (const row of rows) {
    if (row.legacyBody !== null) {
      plan.canonical.push({
        row,
        classification: classifySkillBody(row.body, { slug: row.slug }),
      });
      continue;
    }
    const classification = classifySkillBody(row.body, { slug: row.slug });
    if (classification.kind === "convertible")
      plan.convertible.push({ row, classification });
    else if (classification.kind === "canonical")
      plan.canonical.push({ row, classification });
    else plan.ambiguous.push({ row, classification });
  }
  return plan;
}

/** Human-readable summary for the script's dry-run report. */
export function formatBackfillReport(plan: BackfillPlan): string {
  const lines = [
    `convertible: ${plan.convertible.length}`,
    `already canonical: ${plan.canonical.length}`,
    `ambiguous (left untouched): ${plan.ambiguous.length}`,
  ];
  if (plan.ambiguous.length > 0) {
    lines.push("", "Ambiguous rows — review each before any conversion:");
    const byReason = new Map<string, number>();
    for (const item of plan.ambiguous) {
      if (item.classification.kind !== "ambiguous") continue;
      byReason.set(
        item.classification.reason,
        (byReason.get(item.classification.reason) ?? 0) + 1,
      );
    }
    for (const [reason, count] of [...byReason].sort())
      lines.push(`  ${reason}: ${count}`);
    for (const item of plan.ambiguous.slice(0, 20)) {
      if (item.classification.kind !== "ambiguous") continue;
      lines.push(
        `  ${item.row.publicId} (${item.row.slug} v${item.row.versionNumber}) — ${item.classification.reason}${
          item.classification.detail ? `: ${item.classification.detail}` : ""
        }`,
      );
    }
    if (plan.ambiguous.length > 20)
      lines.push(`  … and ${plan.ambiguous.length - 20} more`);
  }
  return lines.join("\n");
}
