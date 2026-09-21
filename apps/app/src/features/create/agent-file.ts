// The agent wizard's file logic (roadmap creation-spec §1; mockup
// `wzAgentSlug`, `wzAgentToml`, `wzAgentBelt`): the slug a description
// implies, the definition `.oxagen/agents/<slug>.toml` drafted from the
// draft, what the definition step reads back out of the file, and which belt
// picks park for a person. Pure, so the steps and their tests agree on one
// reading.
//
// The authoritative checks are propose_agent's (packages/oxagen/src/contracts/
// agent.propose.ts), run by its handler before anything reaches GitHub. This
// module reads the file with the app's TOML subset so the definition step can
// say what the checks will see. It never decides on their behalf.
import { parseTomlSubset, type TomlTable, tomlGet } from "@/shared/toml-subset";
import { wordsOf } from "./draft-text";

/** The harnesses an agent can be written for (agentHarnessSchema). No one is the default (ADR-101). */
export const AGENT_HARNESSES = [
  "claude-code",
  "codex",
  "cursor",
  "stella",
  "claude-agent-sdk",
  "custom",
] as const;
export type AgentHarness = (typeof AGENT_HARNESSES)[number];

/** A tier, not a model id: the route behind it is the organization's. */
export const MODEL_TIERS = ["complex", "light"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/** The slug rule `register_agent` and `propose_agent` share. */
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SLUG_MAX = 18;

/**
 * The belt a definition falls back to when nothing is picked: two reads of
 * the graph and memory, and nothing that writes.
 */
const FALLBACK_BELT = ["search_graph", "recall_memory"] as const;
const DENY = ["github__merge_pull_request@*", "github__delete_*@*"] as const;
/** Four dollars a run, in micros, until the operator writes their own. */
const DEFAULT_RUN_MICROS = 4_000_000;

export function isAgentSlug(slug: string): boolean {
  return slug.length <= SLUG_MAX && SLUG.test(slug);
}

/** The slug a description implies: its first two words, kebab-case, at most 18 characters. */
export function agentSlugFromDescription(desc: string): string {
  const slug = wordsOf(desc)
    .slice(0, 2)
    .join("-")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
  return slug === "" ? "new-agent" : slug;
}

/** Lowercase what the operator typed into a slug they can see being built. */
export function normalizeSlug(typed: string): string {
  return typed
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/, "");
}

/** A TOML basic string's body: backslashes and quotes escaped, on one line. */
function basicString(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** The display name a slug implies: `perf-watch` → `Perf watch`. */
function nameFromSlug(slug: string): string {
  const spaced = slug.replace(/-/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * The definition drafted from the wizard's draft (MC spec §6.2's file
 * shape). `copy` carries the sentences the operator reads in the file, from
 * the catalog. The description is folded to one line of at most 110
 * characters, and the full text becomes the instructions.
 */
export function draftAgentDefinition(args: {
  slug: string;
  desc: string;
  tier: ModelTier;
  harness: AgentHarness | null;
  belt: readonly string[];
  copy: {
    header: string;
    placeholder: string;
    stayInside: string;
  };
}): string {
  const desc = args.desc.trim().replace(/\s+/g, " ");
  const one = desc.length > 110 ? `${desc.slice(0, 107)}…` : desc;
  const tools = args.belt.length > 0 ? args.belt : FALLBACK_BELT;
  const list = (xs: readonly string[]) =>
    `[${xs.map((x) => `"${basicString(x)}"`).join(", ")}]`;
  // A multi-line basic string still reads escapes: double every backslash,
  // and break a triple quote so it cannot close the string early.
  const body = (args.desc.trim() || args.copy.placeholder)
    .replace(/\\/g, "\\\\")
    .replace(/"""/g, '""\\"');
  return [
    `# .oxagen/agents/${args.slug}.toml`,
    ...args.copy.header.split("\n").map((l) => `# ${l}`),
    'schema = "agent-definition/v0.1"',
    `slug = "${args.slug}"`,
    `name = "${basicString(nameFromSlug(args.slug))}"`,
    `description = "${basicString(one)}"`,
    `model_tier = "${args.tier}"`,
    `tools = ${list(tools)}`,
    `deny_tools = ${list(DENY)}`,
    'side_effects = ["read", "write"]',
    `budget = { per_run_micros = ${String(DEFAULT_RUN_MICROS)} }`,
    "",
    "[instructions]",
    'body = """',
    body,
    "",
    args.copy.stayInside,
    '"""',
    ...(args.harness === null ? [] : ["", `[harness.${args.harness}]`]),
    "",
  ].join("\n");
}

/** What the definition step shows above the editor, read out of the file. */
type DefinitionReading =
  | {
      ok: true;
      slug: string | null;
      tier: string | null;
      tools: number;
      denied: number;
    }
  | { ok: false; code: string; line: number };

function stringOf(doc: TomlTable, key: string): string | null {
  const v = tomlGet(doc, key);
  return typeof v === "string" && v !== "" ? v : null;
}

function countOf(doc: TomlTable, key: string): number {
  const v = tomlGet(doc, key);
  return Array.isArray(v) ? v.length : 0;
}

export function readDefinition(text: string): DefinitionReading {
  const parsed = parseTomlSubset(text);
  if (!parsed.ok) return { ok: false, code: parsed.code, line: parsed.line };
  const doc = parsed.doc;
  return {
    ok: true,
    slug: stringOf(doc, "slug"),
    tier: stringOf(doc, "model_tier"),
    tools: countOf(doc, "tools"),
    denied: countOf(doc, "deny_tools"),
  };
}

/** One registry tool version, as the toolbelt step offers it. */
export type BeltTool = {
  slug: string;
  name: string;
  version: number;
  riskGrade: "low" | "medium" | "high" | "critical";
  /** Null until an admin classifies the version. */
  sideEffect: "read" | "write" | "irreversible" | null;
  financial: boolean;
  /** Stopped by a kill switch today. */
  killed: boolean;
};

/** The pattern a pick writes into `tools`: the slug pinned to the version on screen. */
export function beltPattern(tool: Pick<BeltTool, "slug" | "version">): string {
  return `${tool.slug}@${String(tool.version)}`;
}

/**
 * Whether a call to the tool stops for a person: an irreversible or
 * high-risk tool waits on an approver every time, until somebody writes an
 * auto-approval rule for it (mockup `wzAgent` step 4).
 */
export function parks(tool: BeltTool): boolean {
  return (
    tool.sideEffect === "irreversible" ||
    tool.riskGrade === "high" ||
    tool.riskGrade === "critical"
  );
}
