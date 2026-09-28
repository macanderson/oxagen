// The provisioning steps a person sees, and the state of each, derived from
// the last step that finished (`view.step`) and the step that failed or
// stopped (`view.failedStep`). The job skips two steps in two cases, so the
// list leaves them out: `bind_repository` runs only for a workspace, and
// `add_to_installation` runs only on GitHub.
import {
  STEERING_REPO_STEPS,
  type SteeringRepoStep,
  type SteeringRepoView,
} from "./types";

export type StepState = "done" | "running" | "failed" | "blocked" | "waiting";

type ProvisioningStep = { step: SteeringRepoStep; state: StepState };

function runs(
  step: SteeringRepoStep,
  provider: SteeringRepoView["provider"],
  ws: string | null,
): boolean {
  if (step === "bind_repository") return ws !== null;
  // A connection not yet picked reads as GitHub, the default host.
  if (step === "add_to_installation") return provider !== "gitlab";
  return true;
}

export function provisioningSteps(
  view: Pick<SteeringRepoView, "status" | "step" | "failedStep" | "provider">,
  /** The workspace the repo is for, or null before the organization has one. */
  ws: string | null,
): ProvisioningStep[] {
  const shown = STEERING_REPO_STEPS.filter((step) =>
    runs(step, view.provider, ws),
  );
  if (view.status === "ready")
    return shown.map((step) => ({ step, state: "done" }));
  const lastDone =
    view.step === null ? -1 : STEERING_REPO_STEPS.indexOf(view.step);
  const next =
    shown.find((step) => STEERING_REPO_STEPS.indexOf(step) > lastDone) ??
    null;
  const current =
    view.status === "provisioning" ? next : (view.failedStep ?? next);
  const currentState: StepState =
    view.status === "provisioning" ? "running" : view.status;
  return shown.map((step) => {
    if (step === current) return { step, state: currentState };
    return {
      step,
      state: STEERING_REPO_STEPS.indexOf(step) <= lastDone ? "done" : "waiting",
    };
  });
}
