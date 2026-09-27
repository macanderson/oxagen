// The gate's rail and the register stepper as pure functions of the recorded
// state (#2967, ADR-065 decision 1). Every target is a route builder, so a rail
// item carries a SafePath or nothing (INV-13), and a step nothing can reach yet
// carries no link.
import type { OnboardingStep } from "@/data/contracts/onboarding";
import { routes, type SafePath } from "@/shared/safe-path";

/**
 * The five steps of the gate's rail. Sign-up and email verification belong to
 * the session and are not recorded. Connect and the first workspace come
 * before any workspace exists, so the gate record never stands on them: a rail
 * drawn inside a workspace shows both as done.
 */
const GATE_STEPS = [
  "organization",
  "connect",
  "workspace",
  "wrap",
  "run",
] as const;
export type GateStep = (typeof GATE_STEPS)[number];

/** The register flow's own three steps, which are the `[step]` segment. */
const REGISTER_STEPS = ["name", "wrap", "run"] as const;
export type RegisterStep = (typeof REGISTER_STEPS)[number];

export type StepState = "done" | "current" | "todo";

export type RailItem<S extends string> = {
  step: S;
  state: StepState;
  /** Where the step opens; null for a step the operator cannot open from here. */
  to: SafePath | null;
};

export type Place = { org: string; ws: string };

/** The `[step]` segment as a step of the flow, or null for anything else. */
export function parseRegisterStep(raw: string): RegisterStep | null {
  return REGISTER_STEPS.find((step) => step === raw) ?? null;
}

/** 1-based position, for the "Step N of 3" line. */
export function stepNumber(step: RegisterStep): number {
  return REGISTER_STEPS.indexOf(step) + 1;
}

function stateOf(index: number, current: number): StepState {
  if (index < current) return "done";
  return index === current ? "current" : "todo";
}

/**
 * Where the gate's rail stands. `organization`, `connect` and `workspace` are
 * complete as soon as the workspace exists, so a rail rendered inside a
 * workspace never shows them as current; `unlocked` leaves every step done.
 */
export function gateRail(
  step: OnboardingStep,
  place: Place,
): RailItem<GateStep>[] {
  const current =
    step === "organization"
      ? 0
      : step === "wrap" || step === "run"
        ? GATE_STEPS.indexOf(step)
        : GATE_STEPS.length;
  return GATE_STEPS.map((gateStep, index) => {
    const state = stateOf(index, current);
    return { step: gateStep, state, to: gateTarget(gateStep, state, place) };
  });
}

/**
 * Where a rail step opens. The organization step is the /new-organization
 * form, which an organization that exists has already passed. Connect and the
 * first workspace are the onboarding pages for the organization. Wrap and run
 * are the register flow's own steps, open once the gate has reached them.
 */
function gateTarget(
  step: GateStep,
  state: StepState,
  place: Place,
): SafePath | null {
  if (step === "organization" || state === "todo") return null;
  if (step === "connect") return routes.welcomeConnect(place.org);
  if (step === "workspace") return routes.welcomeFirstWorkspace(place.org);
  return routes.register(place.org, place.ws, step);
}

/**
 * The register stepper (register-name spec, Shell): a done step links back to
 * itself, the current step is where the operator stands, and a later step
 * opens only by finishing this one, so it carries no link. The identity the
 * name step minted rides along on every link back.
 */
export function registerRail(
  current: RegisterStep,
  place: Place,
  agent: string | null,
): RailItem<RegisterStep>[] {
  const at = REGISTER_STEPS.indexOf(current);
  return REGISTER_STEPS.map((step, index) => {
    const state = stateOf(index, at);
    const to =
      state === "done"
        ? routes.register(
            place.org,
            place.ws,
            step,
            agent === null ? undefined : { agent },
          )
        : null;
    return { step, state, to };
  });
}
