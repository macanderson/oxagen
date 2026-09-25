import {
  readSkillFrontmatter,
  renameSkillFrontmatterName,
} from "@oxagen/oxagen/skill-frontmatter";

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function validName(name: unknown, max: number): name is string {
  return typeof name === "string" && name.length <= max && NAME.test(name);
}

/** Decode names with the same YAML reader as the proposal handler. */
export function skillSourceName(source: string): string | null {
  const name = readSkillFrontmatter(source)?.fields.name;
  return validName(name, 48) ? name : null;
}

/** Keep the skill body and every other field byte-for-byte when editing its name. */
export function renameSkillSource(source: string, name: string): string | null {
  if (!validName(name, 48)) return null;
  const renamed = renameSkillFrontmatterName(source, name);
  return renamed !== null && skillSourceName(renamed) === name ? renamed : null;
}
