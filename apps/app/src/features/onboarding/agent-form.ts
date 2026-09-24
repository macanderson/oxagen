// The register form: the slug that becomes the last segment of the agent key
// (ADR-024) and the harness that picks the wrap path. The display name is the
// slug in words and the description is left empty: the design asks for
// neither, and `register_agent` requires the name, so the form derives it.
// Issues carry keys under `onboarding.errors.*`. The bounds are
// `register_agent`'s own, so a form the page accepts is one the contract
// accepts.
import type { agentHarnessSchema } from "@oxagen/oxagen/contracts/agent.list";
import { z } from "zod";

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

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

/** The two model tiers the name step offers (register-name spec). */
export const MODEL_TIERS = ["complex", "light"] as const;

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

/** The display name `register_agent` requires, as the slug in words: `perf-watch` is `Perf watch`. */
export function nameFromSlug(slug: string): string {
  const words = slug.trim().replace(/-+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const AGENT_FORM_ERROR_KEYS = [
  "agentSlugInvalid",
  "agentNameRequired",
  "agentNameTooLong",
  "agentDescriptionTooLong",
  "agentHarnessInvalid",
] as const;
export type AgentFormErrorKey = (typeof AGENT_FORM_ERROR_KEYS)[number];

export const AgentForm = z.object({
  slug: z
    .string()
    .trim()
    .min(1, { error: "agentSlugInvalid" })
    .max(18, { error: "agentSlugInvalid" })
    .regex(SLUG_PATTERN, { error: "agentSlugInvalid" }),
  name: z
    .string()
    .trim()
    .min(1, { error: "agentNameRequired" })
    .max(128, { error: "agentNameTooLong" }),
  description: z
    .string()
    .trim()
    .max(1024, { error: "agentDescriptionTooLong" }),
  harness: z.enum(HARNESSES, { error: "agentHarnessInvalid" }),
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
