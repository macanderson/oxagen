import { parse, stringify } from "smol-toml";
import { parseDocument } from "yaml";
import { HandlerError } from "@oxagen/oxagen";
import { proposedRecordSchema } from "@oxagen/oxagen/contracts/context.steering.shared";
import { readSkillFrontmatter } from "./skill-validation";
import type { ConfigurationSource } from "./configuration-clone-source";

function invalid(): never {
  throw new HandlerError({
    code: "conflict",
    reason: "clone_source_invalid",
    message:
      "The published configuration cannot be read as a supported clone source",
  });
}
function parseSource(text: string) {
  try {
    return parse(text);
  } catch {
    return invalid();
  }
}
export function clonedConfigurationText(
  original: ConfigurationSource,
  slug: string,
  name: string,
) {
  if (original.kind === "skill") {
    const frontmatter = readSkillFrontmatter(original.source);
    if (!frontmatter || frontmatter.fields.name !== original.slug)
      return invalid();
    const lines = original.source.replace(/\r\n/g, "\n").split("\n");
    const header = parseDocument(
      lines.slice(1, frontmatter.bodyStart - 1).join("\n"),
      { uniqueKeys: true },
    );
    header.set("name", slug);
    return `---\n${String(header)}---\n${lines.slice(frontmatter.bodyStart).join("\n")}`;
  }
  const file = parseSource(original.source);
  if (file.schema !== "context-record/v0.1" || !Array.isArray(file.record))
    return invalid();
  const rows: unknown[] = file.record;
  const raw = rows.find(
    (row) =>
      typeof row === "object" &&
      row !== null &&
      "lineage_id" in row &&
      row.lineage_id === original.slug,
  );
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("steering" in raw) ||
    typeof raw.steering !== "object" ||
    raw.steering === null ||
    !("force" in raw.steering)
  )
    return invalid();
  const proposed = proposedRecordSchema.safeParse({
    lineageId: slug,
    label: name,
    kind: "kind" in raw ? raw.kind : undefined,
    force: raw.steering.force,
    sharingScope: "sharing_scope" in raw ? raw.sharing_scope : undefined,
    statement: "statement" in raw ? raw.statement : undefined,
    ...(original.constraintEffect
      ? { constraintEffect: original.constraintEffect }
      : {}),
  });
  if (!proposed.success) return invalid();
  return stringify(proposed.data);
}

/** The explicit identity fields in the editor own the new file's identity. */
export function applyCloneIdentity(
  input: import("@oxagen/oxagen/configuration-clone").ConfigurationCloneDraft,
): string {
  if (input.kind === "skill") {
    const fm = readSkillFrontmatter(input.source);
    if (!fm) return invalid();
    const lines = input.source.replace(/\r\n/g, "\n").split("\n");
    const header = parseDocument(lines.slice(1, fm.bodyStart - 1).join("\n"), {
      uniqueKeys: true,
    });
    header.set("name", input.slug);
    return `---\n${String(header)}---\n${lines.slice(fm.bodyStart).join("\n")}`;
  }
  const doc = parseSource(input.source);
  return stringify({ ...doc, lineageId: input.slug, label: input.name });
}
