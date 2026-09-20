// propose_skill — add or replace a governed skill as a pull request against the
// workspace's main repository (MC spec §10.2, §10.6; Appendix E; ADR-090;
// roadmap creation-spec §4).
//
// A skill is a file, `.oxagen/skills/<name>/SKILL.md`, with a version and a
// digest. Nothing here writes a row: the call cuts the branch `skills/<name>`
// from the production branch, commits the file (and, for an uploaded bundle,
// the files beside it), and opens the pull request. The skill exists when a
// person merges it, which is also the only place a reviewer can stop it.
//
// The six checks run before anything reaches GitHub, and a failed check writes
// nothing: frontmatter, version, digest, grants, the secret and PII scan, and
// the load cost against the workspace's search budget. They are pure functions
// exported from this module, so the wizard shows the same verdicts the handler
// enforces while the operator is still editing the file.
//
// Roles: org Owner or Admin, asserted in the handler (INV-29; Appendix E: the
// five Skills writes are org Owner or Admin). An API key carries no user to
// hold that role, so the capability ships on the API alone, as open_context_pr
// and commit_agent_definition do. A skill write spends no governed action
// units: `noBillingGate: true` (ARCHITECTURE.md §1.5).
import { z } from "zod";
import { registerCapability } from "../registry";

/** Where governed skills live in the main repository (MC spec §10.2). */
export const SKILL_DIR = ".oxagen/skills";
/** The workspace's skills config; `[search] budget` caps a skill's load cost. */
export const SKILLS_CONFIG_PATH = ".oxagen/skills.toml";
/**
 * The search budget when `.oxagen/skills.toml` names none, in tokens. The
 * mockup's config (`sk-cfg.json`) carries 6,000, and a workspace that has not
 * written its own gets the same ceiling rather than none.
 */
export const DEFAULT_SKILL_LOAD_BUDGET = 6000;
/** The longest SKILL.md the call accepts, in UTF-16 units. */
export const SKILL_BODY_MAX = 64 * 1024;
/** Files an uploaded bundle may carry beside its SKILL.md. */
export const SKILL_BUNDLE_FILES_MAX = 16;

/** A skill's directory name: lowercase kebab-case, as the mockup derives it. */
export const skillNameSchema = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "a skill name is lowercase kebab-case");

/**
 * A path inside the skill's directory: relative, forward slashes, no `..`, no
 * leading dot segment, and never SKILL.md itself (that is `body`).
 */
export const skillFilePathSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^(?!.*(?:^|\/)\.)(?!.*\/\/)[A-Za-z0-9_-][A-Za-z0-9._/-]*$/,
    "a relative path inside the skill's directory",
  )
  .refine((p) => p !== "SKILL.md", "SKILL.md is the body, not a bundle file");

export function skillPath(name: string): string {
  return `${SKILL_DIR}/${name}/SKILL.md`;
}

export function skillBranch(name: string): string {
  return `skills/${name}`;
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** `[major, minor, patch]`, or null for anything that is not plain semver. */
export function parseSemver(v: string): [number, number, number] | null {
  const m = SEMVER.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Negative when `a` is lower, zero when equal, positive when higher. */
export function compareSemver(
  a: [number, number, number],
  b: [number, number, number],
): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** The next patch version, the bump a changed body needs (skill-source.md). */
export function bumpPatch(v: string): string | null {
  const p = parseSemver(v);
  return p ? `${p[0]}.${p[1]}.${p[2] + 1}` : null;
}

/**
 * A skill's load cost in tokens, estimated at four characters a token. It is
 * an estimate and every surface labels it so: the tokenizer that counts it
 * for real is the model's, and the model is the harness's choice.
 */
export function estimateSkillTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Frontmatter keys that would let a skill carry authority. A harness reads
 * `allowed-tools` as a grant, and a skill cannot add a tool or raise a tier
 * (MC spec §10.6; creation-spec §6: "Let a record, a skill or a tool manifest
 * grant authority" is on the never list). The toolbelt decides.
 */
export const GRANTING_FRONTMATTER_KEYS = [
  "allowed-tools",
  "tools",
  "permissions",
  "grants",
  "tier",
  "role",
] as const;

const SECRET_PATTERNS: readonly { kind: string; re: RegExp }[] = [
  { kind: "aws_access_key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: "github_token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { kind: "github_pat", re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { kind: "private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: "slack_token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/ },
  { kind: "stripe_live_key", re: /\b[sr]k_live_[A-Za-z0-9]{16,}\b/ },
  { kind: "openai_key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/ },
  { kind: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/ },
  {
    kind: "us_ssn",
    re: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/,
  },
];

/** The first credential- or PII-shaped string in `text`, by kind, or null. */
export function scanForSecrets(text: string): string | null {
  for (const { kind, re } of SECRET_PATTERNS) if (re.test(text)) return kind;
  return null;
}

/**
 * `[search] budget = N` from `.oxagen/skills.toml`, or null when the file or
 * the key is absent. Only the one key is read; the config's full grammar is
 * the resolver's.
 */
export function readSearchBudget(config: string | null): number | null {
  if (config === null) return null;
  let inSearch = false;
  for (const raw of config.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    const table = /^\[([^\]]+)\]$/.exec(line);
    if (table) {
      inSearch = table[1]?.trim() === "search";
      continue;
    }
    const m = inSearch ? /^budget\s*=\s*(\d+)$/.exec(line) : null;
    if (m) return Number(m[1]);
  }
  return null;
}

export const SKILL_CHECK_NAMES = [
  "frontmatter",
  "version",
  "digest",
  "grants",
  "secrets",
  "load_cost",
] as const;
export type SkillCheckName = (typeof SKILL_CHECK_NAMES)[number];

export type SkillCheck = {
  name: SkillCheckName;
  passed: boolean;
  /** Why it failed, as a stable code the surfaces name in their own words; null when it passed. */
  code: string | null;
};

const skillCheckSchema = z
  .object({
    name: z.enum(SKILL_CHECK_NAMES),
    passed: z.boolean(),
    code: z.string().nullable(),
  })
  .strict();

export const skillPropose = registerCapability({
  name: "propose_skill",
  domain: "skill",
  description:
    "Add or replace a governed skill as a pull request: cut skills/<name> from the main repository's production branch, commit .oxagen/skills/<name>/SKILL.md and any bundle files, and open the pull request. Six checks (frontmatter, version, digest, grants, secret and PII scan, load cost against the search budget) run first, and a failed check writes nothing. The skill exists on merge.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  agent: {
    requiresApproval: true,
    riskLevel: "medium",
    category: "governance",
  },
  sensitivity: "high",
  defaultEffect: "deny",
  // Appendix E: the Skills writes are org Owner or Admin; no workspace role
  // reaches them on its own.
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z
    .object({
      /**
       * How the file arrived: drafted from a description, or read out of an
       * uploaded bundle. Recorded on the pull request body. The registry path
       * (a pin by digest) waits on a skill registry, which has no store yet.
       */
      origin: z.enum(["describe", "upload"]),
      /** The skill's directory under `.oxagen/skills/`; a replacement names the existing one. */
      name: skillNameSchema,
      /** The SKILL.md bytes, exactly as the operator last saw them. */
      body: z.string().min(1).max(SKILL_BODY_MAX),
      /** The other files of an uploaded bundle, committed beside SKILL.md. */
      files: z
        .array(
          z
            .object({
              path: skillFilePathSchema,
              content: z.string().max(SKILL_BODY_MAX),
            })
            .strict(),
        )
        .max(SKILL_BUNDLE_FILES_MAX)
        .default([]),
      /** What the operator described; the pull request carries it as the rationale. */
      rationale: z.string().max(4000).optional(),
    })
    .strict(),
  output: z
    .object({
      name: z.string(),
      path: z.string(),
      branch: z.string(),
      /** `owner/name` of the main repository the pull request targets. */
      repository: z.string(),
      /** The production branch it merges into. */
      baseRef: z.string(),
      version: z.string(),
      /** The version merged today when this replaces a skill; null for a new one. */
      replaces: z.string().nullable(),
      /** `sha256:<hex>` of the canonical SKILL.md bytes as committed; the checks take it again at merge. */
      digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      /** Estimated load cost in tokens, and the budget it was held against. */
      tokens: z.number().int().nonnegative(),
      budget: z.number().int().positive(),
      checks: z.array(skillCheckSchema),
      commitSha: z.string().min(1),
      pullRequest: z
        .object({ number: z.number().int().positive(), url: z.string() })
        .strict(),
    })
    .strict(),
});

export type SkillProposeInput = z.output<typeof skillPropose.input>;
export type SkillProposeOutput = z.output<typeof skillPropose.output>;
