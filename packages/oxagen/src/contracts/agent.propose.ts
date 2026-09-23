// propose_agent: write an agent that does not exist yet, as a pull request
// against the workspace's main repository (MC spec §6.2 "Identity in Postgres,
// definition in git", §10.2; roadmap creation-spec §1, the agent wizard).
//
// New agent is not Register an agent. `register_agent` mints an identity for
// an agent that already runs somewhere. This call writes no row: it cuts the
// branch `agents/<slug>` from the production branch, commits the definition
// `.oxagen/agents/<slug>.toml` and the subagent file generated from it, and
// opens the pull request. Register the agent after merge to create its identity.
//
// Six checks run before anything reaches GitHub, and a failed check writes
// nothing: the schema, the key, the belt, authority, the budget, and the
// secret and PII scan. They are pure functions exported from this module,
// over a parsed file, so the wizard and the handler hold the file to the same
// rules.
//
// The generated file is `.claude/agents/<slug>.md`. Claude Code and Cursor read
// subagents there, and Stella adopts them from `.claude/` (ADR-101). Codex
// documents no subagent file, so it gets none.
//
// Roles: org Owner or Admin, asserted in the handler (INV-29). The call needs the same organization role as `register_agent`. An
// API key carries no user to hold that role, so the capability ships on the
// API alone, as `propose_skill` does. It spends no governed action units:
// `noBillingGate: true`.
import { z } from "zod";
import { registerCapability } from "../registry";
import {
  AGENT_DEFINITION_DIR,
  AGENT_DEFINITION_SCHEMA,
} from "./agent.definition.commit";
import { agentHarnessSchema } from "./agent.list";
import { scanForSecrets } from "./skill.propose";

/** Where the generated subagent file goes: Claude Code, Cursor and Stella read it (ADR-101). */
export const GENERATED_AGENT_DIR = ".claude/agents";
/** The longest definition the call accepts, in UTF-16 units. */
export const AGENT_SOURCE_MAX = 64 * 1024;
/** The side-effect classes a definition may ask for without a mandate (MC spec §6.2). */
export const AGENT_SIDE_EFFECTS = ["read", "write"] as const;

/** The agent's slug, the file name and the last part of its key: as `register_agent` takes it. */
export const agentSlugSchema = z
  .string()
  .min(1)
  .max(18)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "lowercase words joined by hyphens");

export function agentDefinitionPath(slug: string): string {
  return `${AGENT_DEFINITION_DIR}/${slug}.toml`;
}

export const SUBAGENT_FILE_HARNESSES: readonly string[] = [
  "claude-code",
  "cursor",
  "stella",
];

export function generatedAgentPath(slug: string): string {
  return `${GENERATED_AGENT_DIR}/${slug}.md`;
}

export function agentBranch(slug: string): string {
  return `agents/${slug}`;
}

export const AGENT_CHECK_NAMES = [
  "schema",
  "key",
  "belt",
  "authority",
  "budget",
  "secrets",
] as const;
export type AgentCheckName = (typeof AGENT_CHECK_NAMES)[number];

export type AgentCheck = {
  name: AgentCheckName;
  passed: boolean;
  /** Why it failed, as a stable code the surfaces name in their own words; null when it passed. */
  code: string | null;
};

/** A parsed TOML document, as whichever parser read it hands it over. */
export type AgentDefinitionDoc = Record<string, unknown>;

function own(doc: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(doc, key) ? doc[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** The definition's `tools`: the belt it asks for. Empty when the key is absent or not a list of strings. */
export function beltOf(doc: AgentDefinitionDoc | null): string[] {
  const tools = doc === null ? undefined : own(doc, "tools");
  return isStringList(tools) ? tools : [];
}

/** The definition's `[instructions] body`, or the empty string. */
export function instructionsOf(doc: AgentDefinitionDoc): string {
  const table = own(doc, "instructions");
  const body = isRecord(table) ? own(table, "body") : undefined;
  return typeof body === "string" ? body : "";
}

/** What a belt pattern can resolve to: the workspace registry's tools and the kernel's capabilities. */
export type BeltRegistry = {
  /** Every tool in the workspace registry, by slug, with the version numbers it holds. */
  tools: readonly { slug: string; versions: readonly number[] }[];
  /** Capability names a definition may name outright. */
  capabilities: readonly string[];
};

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "i");
}

/**
 * Whether one `tools` pattern resolves to something that exists: `slug`,
 * `slug@N`, `slug@*` or a glob such as `github__*`. A pattern that resolves to
 * nothing fails the belt check, because a request for a tool nobody
 * registered is a typo nobody would catch until a run needed it.
 */
export function resolvesInRegistry(
  pattern: string,
  registry: BeltRegistry,
): boolean {
  const at = pattern.lastIndexOf("@");
  const name = at < 0 ? pattern : pattern.slice(0, at);
  const version = at < 0 ? null : pattern.slice(at + 1);
  if (name === "") return false;
  if (version !== null && version !== "*" && !/^[1-9]\d*$/.test(version))
    return false;
  const matches = globToRegExp(name);
  const tools = registry.tools.filter((t) => matches.test(t.slug));
  const toolHit =
    version === null || version === "*"
      ? tools.length > 0
      : tools.some((t) => t.versions.includes(Number(version)));
  if (toolHit) return true;
  // A capability is named bare: it has no registry version to pin.
  return version === null && registry.capabilities.some((c) => matches.test(c));
}

/**
 * The six checks over a proposed definition, as the handler runs them before
 * anything reaches GitHub. `doc` is the parsed file, or null when it does not
 * parse. `keyTaken` says whether the slug is held by another agent in the
 * workspace, live or retired, or by a file already merged. `exceeded` names
 * the capabilities the file asks for that its author does not hold (the
 * delegation ceiling of MC spec §6.2).
 */
export function checkAgentDefinition(args: {
  slug: string;
  source: string;
  doc: AgentDefinitionDoc | null;
  keyTaken: boolean;
  registry: BeltRegistry;
  exceeded: readonly string[];
}): AgentCheck[] {
  const { doc } = args;
  const str = (key: string): string | null => {
    const v = doc === null ? undefined : own(doc, key);
    return typeof v === "string" && v.trim() !== "" ? v : null;
  };

  const schema: AgentCheck =
    doc === null
      ? { name: "schema", passed: false, code: "not_toml" }
      : str("schema") !== AGENT_DEFINITION_SCHEMA
        ? { name: "schema", passed: false, code: "schema_version" }
        : str("slug") !== args.slug
          ? { name: "schema", passed: false, code: "slug_mismatch" }
          : str("name") === null
            ? { name: "schema", passed: false, code: "name_missing" }
            : str("model_tier") === null
              ? { name: "schema", passed: false, code: "model_tier_missing" }
              : !isStringList(own(doc, "tools"))
                ? { name: "schema", passed: false, code: "tools_not_list" }
                : instructionsOf(doc).trim() === ""
                  ? {
                      name: "schema",
                      passed: false,
                      code: "instructions_missing",
                    }
                  : { name: "schema", passed: true, code: null };

  const key: AgentCheck = args.keyTaken
    ? { name: "key", passed: false, code: "key_taken" }
    : { name: "key", passed: true, code: null };

  const unresolved = beltOf(doc).find(
    (p) => !resolvesInRegistry(p, args.registry),
  );
  const belt: AgentCheck =
    unresolved === undefined
      ? { name: "belt", passed: true, code: null }
      : { name: "belt", passed: false, code: "pattern_unresolved" };

  const effects = doc === null ? undefined : own(doc, "side_effects");
  const effectList = isStringList(effects) ? effects : [];
  const authority: AgentCheck = effectList.includes("irreversible")
    ? // A new agent holds no mandate, and irreversible needs one (§6.2).
      { name: "authority", passed: false, code: "irreversible_without_mandate" }
    : effectList.some(
          (e) => !(AGENT_SIDE_EFFECTS as readonly string[]).includes(e),
        ) ||
        (effects !== undefined && !isStringList(effects))
      ? { name: "authority", passed: false, code: "side_effect_unknown" }
      : args.exceeded.length > 0
        ? { name: "authority", passed: false, code: "delegation_ceiling" }
        : { name: "authority", passed: true, code: null };

  const budgetTable = doc === null ? undefined : own(doc, "budget");
  const micros = isRecord(budgetTable)
    ? own(budgetTable, "per_run_micros")
    : undefined;
  const budget: AgentCheck =
    typeof micros === "number" && Number.isInteger(micros) && micros > 0
      ? { name: "budget", passed: true, code: null }
      : { name: "budget", passed: false, code: "budget_missing" };

  const leaked = scanForSecrets(args.source);
  const secrets: AgentCheck =
    leaked === null
      ? { name: "secrets", passed: true, code: null }
      : { name: "secrets", passed: false, code: `secret_${leaked}` };

  return [schema, key, belt, authority, budget, secrets];
}

/**
 * The subagent file generated beside the definition (MC spec §6.2, "One
 * source, every harness"). It carries the name, the description and the
 * instructions, and nothing that grants: the belt is Oxagen's to enforce, so
 * no `tools` line is written. A header names the source file and its digest,
 * so a hand edit that was not regenerated shows up as a mismatch.
 */
export function generateSubagentFile(args: {
  slug: string;
  description: string;
  instructions: string;
  digest: string;
}): string {
  const description = args.description.replace(/\s+/g, " ").trim();
  return [
    "---",
    `name: ${args.slug}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    `<!-- Generated by Oxagen from ${agentDefinitionPath(args.slug)} (${args.digest}). Change that file, not this one. -->`,
    "",
    args.instructions.trim(),
    "",
  ].join("\n");
}

/**
 * The subagent file a harness loads for this definition, or null when the
 * harness reads none. Claude Code, Cursor and Stella get
 * `.claude/agents/<slug>.md`. Codex, the Agent SDK and a custom harness get
 * nothing, because none of them documents a subagent file.
 *
 * `propose_agent` (creation) and `commit_agent_definition` (editing) both
 * call this, so a saved edit regenerates the file exactly as the proposal
 * wrote it (#3501). `digest` is `sha256:<hex>` of the committed definition,
 * and the file's header names it.
 */
export function subagentFileFor(args: {
  slug: string;
  harness: string;
  doc: AgentDefinitionDoc;
  digest: string;
}): { path: string; content: string } | null {
  if (!SUBAGENT_FILE_HARNESSES.includes(args.harness)) return null;
  const description = own(args.doc, "description");
  const name = own(args.doc, "name");
  return {
    path: generatedAgentPath(args.slug),
    content: generateSubagentFile({
      slug: args.slug,
      description:
        typeof description === "string"
          ? description
          : typeof name === "string"
            ? name
            : args.slug,
      instructions: instructionsOf(args.doc),
      digest: args.digest,
    }),
  };
}

const agentCheckSchema = z
  .object({
    name: z.enum(AGENT_CHECK_NAMES),
    passed: z.boolean(),
    code: z.string().nullable(),
  })
  .strict();

export const agentPropose = registerCapability({
  name: "propose_agent",
  domain: "agent",
  description:
    "Write a new agent as a pull request: cut agents/<slug> from the main repository's production branch, commit .oxagen/agents/<slug>.toml and, for Claude Code, Cursor, and Stella, the subagent file generated from it, and open the pull request. Six checks (schema, key, belt, authority, budget, secret and PII scan) run first, and a failed check writes nothing. No row is written; register the agent after merge to create its identity.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  agent: { requiresApproval: true, riskLevel: "medium", category: "identity" },
  sensitivity: "high",
  defaultEffect: "deny",
  // Merging the file creates a principal, which is register_agent's role.
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z
    .object({
      slug: agentSlugSchema,
      /** The harness the agent is written for; the pull request body names it. */
      harness: agentHarnessSchema,
      /** The definition bytes, exactly as the operator last saw them. */
      source: z.string().min(1).max(AGENT_SOURCE_MAX),
      /** What the operator described; the pull request carries it as the rationale. */
      rationale: z.string().max(4000).optional(),
    })
    .strict(),
  output: z
    .object({
      slug: z.string(),
      /** `org_ns.ws_ns.slug` to use when registering after merge; null while a namespace is unset. */
      agentKey: z.string().nullable(),
      path: z.string(),
      /** The generated subagent file committed beside the definition. */
      generatedPath: z.string().nullable(),
      branch: z.string(),
      /** `owner/name` of the main repository the pull request targets. */
      repository: z.string(),
      /** The production branch it merges into. */
      baseRef: z.string(),
      /** `sha256:<hex>` of the definition as committed. */
      digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      checks: z.array(agentCheckSchema),
      commitSha: z.string().min(1),
      pullRequest: z
        .object({ number: z.number().int().positive(), url: z.string() })
        .strict(),
    })
    .strict(),
});

export type AgentProposeInput = z.output<typeof agentPropose.input>;
export type AgentProposeOutput = z.output<typeof agentPropose.output>;
