import { readSkillFrontmatter } from "@oxagen/oxagen/skill-frontmatter";

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function validName(name: unknown, max: number): name is string {
  return typeof name === "string" && name.length <= max && NAME.test(name);
}

/** Locate the same plain frontmatter fences that propose_skill reads. */
function frontmatterLines(source: string): string[] | null {
  const lines = source.split("\n");
  if (lines[0]?.replace(/\r$/, "") !== "---") return null;
  const close = lines.findIndex(
    (line, index) => index > 0 && line.replace(/\r$/, "") === "---",
  );
  return close < 0 ? null : lines.slice(0, close + 1);
}

/** Decode names with the same YAML reader as the proposal handler. */
export function skillSourceName(source: string): string | null {
  const name = readSkillFrontmatter(source)?.fields.name;
  return validName(name, 48) ? name : null;
}

/** Keep the skill body and every other field byte-for-byte when editing its name. */
export function renameSkillSource(source: string, name: string): string | null {
  if (!validName(name, 48)) return null;
  const lines = frontmatterLines(source);
  if (lines === null || readSkillFrontmatter(source) === null) return null;
  let offset = 0;
  let target: { start: number; end: number } | undefined;
  for (const line of lines) {
    const match =
      /^((?:name|"name"|'name')[^\S\r\n]*:[^\S\r\n]*)(.*?)(\s*)$/.exec(line);
    if (match !== null) {
      const start = offset + (match[1]?.length ?? 0);
      target = { start, end: start + (match[2]?.length ?? 0) };
    }
    offset += line.length + 1;
  }
  if (target !== undefined) {
    const renamed =
      source.slice(0, target.start) + name + source.slice(target.end);
    return skillSourceName(renamed) === name ? renamed : null;
  }
  // A structured or escaped name key cannot be safely patched by the line editor.
  if (readSkillFrontmatter(source)?.fields.name !== undefined) return null;
  const newline = source.startsWith("---\r\n") ? "\r\n" : "\n";
  const start = source.indexOf("\n") + 1;
  return `${source.slice(0, start)}name: ${name}${newline}${source.slice(start)}`;
}
