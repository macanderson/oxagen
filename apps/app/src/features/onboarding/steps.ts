// The two three-step flows that share one set of screens (spec §4.4):
//   - the onboarding gate for a new organization: name it → wrap an agent → start a run
//   - Register an agent from Fleet:              name the agent → wrap it → wait for the first frame
// Steps are URL segments rendered in place (plan §4.10): the first step is the
// bare route, and any other segment or a deeper path is a 404.
import { z } from "zod";

export const GATE_STEPS = ["organization", "wrap", "run"] as const;
export type GateStep = (typeof GATE_STEPS)[number];

export const REGISTER_STEPS = ["name", "wrap", "run"] as const;
export type RegisterStep = (typeof REGISTER_STEPS)[number];

export type FlowMode = "gate" | "register";

function parseStep<S extends string>(
  steps: readonly S[],
  segments: readonly string[] | undefined,
): S | null {
  if (!segments || segments.length === 0) return steps[0] ?? null;
  if (segments.length > 1) return null;
  const [segment] = segments;
  return steps.find((s) => s === segment) ?? null;
}

/** The gate step for `/welcome/[[...step]]`, or null for a path that is not a step. */
export function parseGateStep(
  segments: readonly string[] | undefined,
): GateStep | null {
  return parseStep(GATE_STEPS, segments);
}

/** The register step for `/[org]/[ws]/register/[[...step]]`, or null. */
export function parseRegisterStep(
  segments: readonly string[] | undefined,
): RegisterStep | null {
  return parseStep(REGISTER_STEPS, segments);
}

export function stepIndex(mode: FlowMode, step: string): number {
  const steps: readonly string[] =
    mode === "gate" ? GATE_STEPS : REGISTER_STEPS;
  return steps.indexOf(step);
}

/** Harnesses a person can wrap from these screens (spec §7.2 adapters). */
export const HARNESSES = [
  "claude-code",
  "codex-cli",
  "stella",
  "claude-agent-sdk",
  "custom",
] as const;
export const Harness = z.enum(HARNESSES);
export type Harness = z.infer<typeof Harness>;

/** Model tiers (spec §4.5). */
export const ModelTier = z.enum(["complex", "light"]);
export type ModelTier = z.infer<typeof ModelTier>;

/** The wrap panel's three ways in. Hook-based harnesses get the one-click installer; the rest wrap in code. */
export const WRAP_METHODS = ["claude-code", "codex-cli", "sdk"] as const;
export type WrapMethod = (typeof WRAP_METHODS)[number];

export function wrapMethodFor(harness: Harness): WrapMethod {
  if (harness === "claude-code" || harness === "codex-cli") return harness;
  return "sdk";
}

export const Platform = z.enum(["macos", "windows", "linux"]);
export type Platform = z.infer<typeof Platform>;

export const SdkLanguage = z.enum(["ts", "py", "go"]);
export type SdkLanguage = z.infer<typeof SdkLanguage>;
