// The register form (ADR-192): an agent is one operator on one runtime with
// one harness, carrying a toolbelt. The form asks for the agent's name, the
// slug that becomes the last segment of its key (ADR-024), the harness, the
// runtime and the toolbelt. The slug is made from the name by the one rule
// every name-made slug follows (`slugFromName`) and cut to the 18 characters
// an agent slug may hold, until the person types one of their own.
//
// A runtime and harness pair a live agent already holds cannot be registered
// again. `holderOf` answers which agent holds a pair, so the harness and
// runtime pickers can keep the taken option visible, disabled, and say why.
//
// Issues carry keys under `onboarding.errors.*`. The bounds are
// `register_agent`'s own, so a form the page accepts is one the contract
// accepts.
import type { agentHarnessSchema } from "@oxagen/oxagen/contracts/agent.list";
import { slugFromName } from "@oxagen/oxagen/contracts/runtime.shared";
import { z } from "zod";
import type { NamedRuntime } from "@/data/contracts/runtimes";

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The longest new agent slug (ADR-024: 6 + 1 + 6 + 1 + 18 characters of key). */
export const AGENT_SLUG_MAX = 18;

type ContractHarness = z.infer<typeof agentHarnessSchema>;

/**
 * Every harness `register_agent` accepts, in the design's order (register-name
 * spec: claude-code, codex-cli, stella, claude-agent-sdk, custom) with Cursor
 * beside Codex, because the four wrapped harnesses are equals (ADR-101).
 */
export const HARNESSES = [
  "claude-code",
  "codex",
  "cursor",
  "stella",
  "claude-agent-sdk",
  "custom",
] as const satisfies readonly ContractHarness[];

/** A harness the agent registry records; the same six members as `register_agent`'s enum. */
export type Harness = (typeof HARNESSES)[number];

/**
 * The wrap step's tabs. The three the design draws, with Cursor beside Codex
 * CLI (ADR-101). Stella and every SDK-built agent take the SDK tab, as the
 * design's `regTabFor` sends them.
 */
export const WRAP_TABS = ["claude-code", "codex", "cursor", "sdk"] as const;
export type WrapTab = (typeof WRAP_TABS)[number];

/** The tab the wrap step opens on for the harness the name step recorded. */
export function wrapTabFor(harness: Harness): WrapTab {
  if (harness === "claude-code" || harness === "codex" || harness === "cursor")
    return harness;
  return "sdk";
}

/** The agent slug a name suggests: `slugFromName`, cut to 18 characters. */
export function agentSlugFromName(name: string): string {
  return slugFromName(name, AGENT_SLUG_MAX);
}

/**
 * The slug as the key will carry it, rewritten on every keystroke: lower case,
 * letters, digits and hyphens, and `agent` while the field is empty (the
 * design's `regSlug`). This is what the hint shows; the form still refuses a
 * slug the contract would refuse before anything is written.
 */
function displaySlug(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "agent" : slug;
}

/** `org_ns.ws_ns.slug`, from the namespaces the workspace read carries. */
export function agentKeyOf(prefix: string, slug: string): string {
  return `${prefix}.${displaySlug(slug)}`;
}

/** The live agent that holds this runtime and harness pair, or null when the pair is free. */
export function holderOf(
  runtime: NamedRuntime | undefined,
  harness: Harness | null,
): NamedRuntime["agents"][number] | null {
  if (runtime === undefined || harness === null) return null;
  return runtime.agents.find((agent) => agent.harness === harness) ?? null;
}

const AGENT_FORM_ERROR_KEYS = [
  "agentSlugInvalid",
  "agentNameRequired",
  "agentNameTooLong",
  "agentHarnessInvalid",
  "agentRuntimeRequired",
] as const;
export type AgentFormErrorKey = (typeof AGENT_FORM_ERROR_KEYS)[number];

export const AgentForm = z.object({
  name: z
    .string()
    .trim()
    .min(1, { error: "agentNameRequired" })
    .max(128, { error: "agentNameTooLong" }),
  slug: z
    .string()
    .trim()
    .min(1, { error: "agentSlugInvalid" })
    .max(AGENT_SLUG_MAX, { error: "agentSlugInvalid" })
    .regex(SLUG_PATTERN, { error: "agentSlugInvalid" }),
  harness: z.enum(HARNESSES, { error: "agentHarnessInvalid" }),
  runtimeId: z
    .string()
    .regex(/^rtm_[0-9a-z]+$/, { error: "agentRuntimeRequired" }),
  /** Empty for the workspace's All tools belt. */
  toolbeltId: z.union([z.literal(""), z.string().regex(/^tbt_[0-9a-z]+$/)]),
});
type AgentFormInput = z.input<typeof AgentForm>;
export type AgentField = keyof AgentFormInput;
export type AgentFormValues = Record<AgentField, string>;

/** Each field's first error from a failed parse, as a catalog key. */
export function agentFieldErrors(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): Partial<Record<AgentField, AgentFormErrorKey>> {
  const fields: Partial<Record<AgentField, AgentFormErrorKey>> = {};
  for (const { path, message } of issues) {
    const field = AgentForm.keyof().options.find((f) => f === path[0]);
    const key = AGENT_FORM_ERROR_KEYS.find((k) => k === message);
    if (field !== undefined && key !== undefined) fields[field] ??= key;
  }
  return fields;
}
