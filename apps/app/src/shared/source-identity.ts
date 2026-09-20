import { tomlSet } from "./toml-patch";
import { parseTomlSubset, tomlGet } from "./toml-subset";

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function validName(name: unknown, max: number): name is string {
  return typeof name === "string" && name.length <= max && NAME.test(name);
}

/** The root slug determines the agent filename. Invalid drafts have no inferred name. */
export function agentSourceSlug(source: string): string | null {
  const parsed = parseTomlSubset(source);
  if (!parsed.ok) return null;
  const slug = tomlGet(parsed.doc, "slug");
  return validName(slug, 18) ? slug : null;
}

/** Patch the root assignment without rewriting comments, prompts, or nested slugs. */
export function renameAgentSource(source: string, name: string): string | null {
  if (!validName(name, 18) || !parseTomlSubset(source).ok) return null;
  const renamed = tomlSet(source, null, "slug", `"${name}"`);
  return agentSourceSlug(renamed) === name ? renamed : null;
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

/** Skill names use plain frontmatter values, matching the proposal checks. */
export function skillSourceName(source: string): string | null {
  const lines = frontmatterLines(source);
  if (lines === null) return null;
  let name: string | undefined;
  for (const line of lines.slice(1, -1)) {
    const match = /^name\s*:\s*(.*)$/.exec(line.replace(/\r$/, ""));
    if (match !== null) name = (match[1] ?? "").trim();
  }
  return validName(name, 48) ? name : null;
}

/** Keep the skill body and every other field byte-for-byte when editing its name. */
export function renameSkillSource(source: string, name: string): string | null {
  if (!validName(name, 48)) return null;
  const lines = frontmatterLines(source);
  if (lines === null) return null;
  let offset = 0;
  let target: { start: number; end: number } | undefined;
  for (const line of lines) {
    const match = /^(name[^\S\r\n]*:[^\S\r\n]*)(.*?)(\s*)$/.exec(line);
    if (match !== null) {
      const start = offset + (match[1]?.length ?? 0);
      target = { start, end: start + (match[2]?.length ?? 0) };
    }
    offset += line.length + 1;
  }
  if (target !== undefined)
    return source.slice(0, target.start) + name + source.slice(target.end);
  const newline = source.startsWith("---\r\n") ? "\r\n" : "\n";
  const start = source.indexOf("\n") + 1;
  return `${source.slice(0, start)}name: ${name}${newline}${source.slice(start)}`;
}
