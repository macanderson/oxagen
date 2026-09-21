// The register form: the slug that becomes the last segment of the agent key
// (ADR-024), the display name, the harness that decides how the agent is
// wrapped, and an optional description. Issues carry keys under
// `onboarding.errors.*`. The bounds are `register_agent`'s own, so a form the
// page accepts is one the contract accepts.
import { agentHarnessSchema } from "@oxagen/oxagen/contracts/agent.list";
import { z } from "zod";

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The harness values `register_agent` admits, in the order the form offers them. */
export const HARNESSES = agentHarnessSchema.options;
export type Harness = (typeof HARNESSES)[number];

/** The harnesses whose hooks Tacho writes on an enrolled host. */
const HOST_WRAPPED: ReadonlySet<Harness> = new Set([
  "claude-code",
  "codex",
  "cursor",
  "stella",
]);

/** Only harnesses with an installed host adapter have a wrapping path. */
export function wrapPathOf(harness: Harness): "host" | "unavailable" {
  return HOST_WRAPPED.has(harness) ? "host" : "unavailable";
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
