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
