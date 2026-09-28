// session.ts: the skills a run receives at session start (steering-repo-spec,
// Scope and binding).
//
// The server chooses the skills here, from the workspace's and the
// organization's published versions, and sends them in the policy bundle.
// The collector writes them where the harness reads user skills and removes
// them at session end (`placeSkills` and `removeSkills` in
// `@oxagen/tacho/skills`).
//
// This module reads assets through `ReadAsset` and hashes with node:crypto,
// so it has its own entry point (`@oxagen/steering-bundle/session`) and stays
// out of the gateway's imports.
import { createHash } from "node:crypto";
import type { Bundle, BundleRecord } from "@oxagen/oxagen/steering-repo/bundle";
import { readSteeringRecord } from "@oxagen/oxagen/steering-repo/record";
import { SKILL_NAME_MAX, type SessionSkill, type SkillFile } from "@oxagen/tacho/skills";
import { renderMentions, toolModesOf } from "./mentions";
import { RecordFileError } from "./read";
import type { BundleSource, Delivery } from "./render";
import { compareText } from "./tree";

export type { SessionSkill, SkillFile } from "@oxagen/tacho/skills";

/**
 * The folder name for a skill: its lineage with dots as hyphens, since Claude
 * Code and Codex take lowercase letters, digits, and hyphens. A name past 64
 * characters keeps its first 55 and ends with 8 characters of the lineage's
 * hash, so two long lineages stay apart.
 *
 * With `digest`, every name ends with the hash. runSkills asks for it when two
 * of a run's lineages differ only in a dot and a hyphen, such as
 * `a-intel.brand.voice` and `a-intel.brand-voice`, which would share a folder.
 */
export function skillFolderName(lineage: string, options: { digest?: boolean } = {}): string {
  const name = lineage.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (options.digest !== true && name.length <= SKILL_NAME_MAX) return name;
  const digest = createHash("sha256").update(lineage).digest("hex").slice(0, 8);
  return `${name.slice(0, SKILL_NAME_MAX - 9).replace(/-+$/, "")}-${digest}`;
}

/** Give each skill that shares its folder name with another the name that ends with its lineage's hash. */
function separateNames(skills: SessionSkill[]): void {
  const counts = new Map<string, number>();
  for (const skill of skills) counts.set(skill.name, (counts.get(skill.name) ?? 0) + 1);
  for (const skill of skills) {
    if ((counts.get(skill.name) ?? 0) > 1) {
      skill.name = skillFolderName(skill.lineage, { digest: true });
    }
  }
}

/** Reads one file of a published version by its blob. A skill asset may be binary. */
export type ReadAsset = (
  source: BundleSource,
  bundle: Bundle,
  file: { path: string; blob: string },
) => Promise<string | Uint8Array>;

function textOf(content: string | Uint8Array): string {
  return typeof content === "string" ? content : new TextDecoder().decode(content);
}

/**
 * The skills a run on `repository` receives: every skill in the workspace's
 * and the organization's published versions whose `repos` is unset or names
 * the repository. A workspace skill wins over an organization skill of the
 * same lineage.
 */
export async function runSkills(
  delivery: Delivery,
  repository: string | null,
  readAsset: ReadAsset,
): Promise<SessionSkill[]> {
  const chosen = new Map<string, { record: BundleRecord; source: BundleSource; bundle: Bundle }>();
  const sources: BundleSource[] = ["organization", "workspace"];
  for (const source of sources) {
    const bundle = delivery[source];
    if (bundle === null) continue;
    for (const record of bundle.records) {
      if (record.kind !== "skill") continue;
      if (
        record.repos !== undefined &&
        (repository === null || !record.repos.includes(repository))
      ) {
        continue;
      }
      chosen.set(record.lineage, { record, source, bundle });
    }
  }
  const skills: SessionSkill[] = [];
  for (const { record, source, bundle } of chosen.values()) {
    const read = readSteeringRecord(
      textOf(await readAsset(source, bundle, { path: record.path, blob: record.blob })),
    );
    if (!read.ok) throw new RecordFileError(record.path);
    const folder = record.path.slice(0, record.path.lastIndexOf("/") + 1);
    const files: SkillFile[] = [];
    for (const file of record.files ?? []) {
      if (!file.path.startsWith(folder)) continue;
      files.push({
        path: file.path.slice(folder.length),
        content: await readAsset(source, bundle, file),
      });
    }
    files.sort((a, b) => compareText(a.path, b.path));
    skills.push({
      lineage: record.lineage,
      name: skillFolderName(record.lineage),
      description: record.description ?? record.label,
      body: renderMentions(read.body, toolModesOf(bundle)),
      files,
      source,
      version: bundle.version,
    });
  }
  separateNames(skills);
  return skills.sort((a, b) => compareText(a.name, b.name));
}
