// Loaded only by the skill proposal handler, never by the capability registry.
import { parseDocument } from "yaml";
import {
  compareSemver,
  estimateSkillTokens,
  GRANTING_FRONTMATTER_KEYS,
  parseSemver,
  scanForSecrets,
  type SkillCheck,
} from "@oxagen/oxagen/contracts/skill.propose";

export type SkillFrontmatter = {
  /** Every `key: value` line between the fences, in order. */
  fields: Record<string, string>;
  /** The line after the closing fence; the body starts there. */
  bodyStart: number;
};

/** Parse a YAML mapping without aliases or duplicate keys. Invalid YAML fails closed. */
export function readSkillFrontmatter(text: string): SkillFrontmatter | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") return null;
  const close = lines.indexOf("---", 1);
  if (close < 0) return null;
  try {
    const doc = parseDocument(lines.slice(1, close).join("\n"), {
      uniqueKeys: true,
    });
    if (doc.errors.length > 0) return null;
    const value: unknown = doc.toJS({ maxAliasCount: 0 });
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return null;
    const fields: Record<string, string> = Object.create(null) as Record<
      string,
      string
    >;
    for (const [key, item] of Object.entries(value)) {
      if (key === "<<") return null;
      // Retain every key for the grant check, including keys with structured values.
      fields[key] = typeof item === "string" ? item : "";
    }
    return { fields, bodyStart: close + 1 };
  } catch {
    return null;
  }
}

/**
 * The six checks over a proposed SKILL.md and the files beside it, as the
 * handler runs them before anything reaches GitHub. `replacing` is the
 * version merged on the production branch today, or null for a new skill;
 * `budget` is the workspace's search budget in tokens. The digest check here
 * asserts the canonical bytes can be hashed (the file is text with LF line
 * ends); the digest itself is taken again at merge.
 */
export function checkSkill(args: {
  name: string;
  body: string;
  files: readonly { path: string; content: string }[];
  replacing: string | null;
  budget: number;
}): SkillCheck[] {
  const fm = readSkillFrontmatter(args.body);
  const f = fm?.fields ?? {};
  const version = f.version === undefined ? null : parseSemver(f.version);
  const replaced = args.replacing === null ? null : parseSemver(args.replacing);

  const frontmatter: SkillCheck =
    fm === null
      ? { name: "frontmatter", passed: false, code: "frontmatter_missing" }
      : !f.name || !f.version || !f.scope
        ? {
            name: "frontmatter",
            passed: false,
            code: "frontmatter_incomplete",
          }
        : f.name !== args.name
          ? { name: "frontmatter", passed: false, code: "name_mismatch" }
          : { name: "frontmatter", passed: true, code: null };

  const versionCheck: SkillCheck =
    version === null
      ? { name: "version", passed: false, code: "version_not_semver" }
      : replaced !== null && compareSemver(version, replaced) <= 0
        ? { name: "version", passed: false, code: "version_not_greater" }
        : { name: "version", passed: true, code: null };

  const digest: SkillCheck = args.body.includes("\u0000")
    ? { name: "digest", passed: false, code: "not_text" }
    : { name: "digest", passed: true, code: null };

  const granting = GRANTING_FRONTMATTER_KEYS.find((k) => k in f);
  const grants: SkillCheck =
    granting === undefined
      ? { name: "grants", passed: true, code: null }
      : { name: "grants", passed: false, code: `grants_${granting}` };

  const leaked = [args.body, ...args.files.map((x) => x.content)]
    .map(scanForSecrets)
    .find((k) => k !== null);
  const secrets: SkillCheck =
    leaked === undefined
      ? { name: "secrets", passed: true, code: null }
      : { name: "secrets", passed: false, code: `secret_${leaked}` };

  const load: SkillCheck =
    estimateSkillTokens(args.body) > args.budget
      ? { name: "load_cost", passed: false, code: "over_budget" }
      : { name: "load_cost", passed: true, code: null };

  return [frontmatter, versionCheck, digest, grants, secrets, load];
}
