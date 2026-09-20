// The creation-wizard shell's model (roadmap creation-spec §2). A wizard is a
// kind module the shell hosts: the module owns its draft and its steps, and the
// shell owns everything every wizard shares. That is the step rail (the step
// you are on in gold, the ones behind you ticked), Back and Cancel, the one
// gold control, the permission line in the footer, and the pull request every
// wizard ends on. A new kind plugs in by adding a module to `WIZARDS`
// (./kinds.ts) and its kind to `CREATE_KINDS`; the shell does not change.
import type { ReactNode } from "react";
import type { CreateKind, CreatePrefill } from "@/shared/create";

/**
 * Every step label a wizard may show, one catalog key each under
 * `create.steps`. The list covers the five step lists of creation-spec §2
 * (tool, both of its paths, skill, agent, context record), so a kind module
 * names its steps without adding catalog keys the shell has to know about.
 */
export type StepId =
  | "describe"
  | "source"
  | "find"
  | "upload"
  | "describeIt"
  | "review"
  | "recommendation"
  | "import"
  | "manifest"
  | "code"
  | "identity"
  | "definition"
  | "toolbelt"
  | "kind"
  | "statement"
  | "checks"
  | "pullRequest";

/** Where one step sits on the rail relative to the step you are on. */
type RailState = "done" | "current" | "ahead";

/** The rail for `steps` with step `current` (1-based) open. */
export function railOf(
  steps: readonly StepId[],
  current: number,
): { id: StepId; n: number; state: RailState }[] {
  return steps.map((id, i) => {
    const n = i + 1;
    return {
      id,
      n,
      state: n < current ? "done" : n === current ? "current" : "ahead",
    };
  });
}

/** Clamp a step number into the list, so a path that shortens the list never strands the draft. */
export function clampStep(step: number, count: number): number {
  return Math.min(Math.max(1, step), Math.max(1, count));
}

/**
 * What the workspace's main repository looked like when the wizard opened.
 * Every wizard's pull request targets it, so the shell reads it once and
 * hands it to the kind.
 */
export type RepoState =
  | { state: "loading" }
  | { state: "bound"; fullName: string; defaultRef: string }
  | { state: "unbound" }
  | { state: "denied"; code: string }
  | { state: "unavailable"; code: string };

export type CreateContext = {
  org: string;
  ws: string;
  wsName: string;
  repo: RepoState;
};

/**
 * The draft as a kind module sees it. `write` stores a value and re-renders
 * nothing, which is what a description field needs: a re-render per keystroke
 * would rebuild the field and take the caret with it (creation-spec §2,
 * `wzDescIn`). `update` stores and re-renders, for a choice that changes what
 * is on screen.
 */
export type DraftApi<D> = {
  readonly draft: D;
  write(patch: Partial<D>): void;
  update(patch: Partial<D>): void;
};

/** The one gold control on a step. `run` replaces Next when the step does more than advance. */
type Primary = {
  label: string;
  enabled: boolean;
  pending?: boolean;
  pendingLabel?: string;
  run?: () => void | Promise<void>;
};

export type StepView = {
  title: string;
  subtitle: string;
  body: ReactNode;
  /** Absent once the pull request is open: the only way on is Close. */
  primary?: Primary;
};

export type StepProps<D> = {
  api: DraftApi<D>;
  ctx: CreateContext;
  /** 1-based, and always inside `steps(draft)`. */
  step: number;
};

export type WizardKind<D> = {
  kind: CreateKind;
  /** The grant the footer names: "needs skills.admin on core-platform". */
  need: string;
  /** A fresh draft; the shell makes one each time the wizard opens. */
  init(prefill?: CreatePrefill): D;
  /** The step list, a function of the draft (a path the operator chose can change it). */
  steps(draft: D): readonly StepId[];
  /**
   * The step on screen: its title, body and gold control. A hook, so a step
   * may hold its own state (a pending submit, a file being read).
   */
  useStep(props: StepProps<D>): StepView;
};

/** A kind module with its draft type erased, as the registry holds it. */
export type AnyWizardKind = WizardKind<object>;

/**
 * Erase a kind module's draft type for the registry. Sound because the shell
 * hands each module only drafts that module's own `init` made. No assertion
 * is needed: `WizardKind` declares its functions as methods, so a module's
 * draft type widens to `object` on assignment.
 */
export function wizardKind<D extends object>(
  kind: WizardKind<D>,
): AnyWizardKind {
  return kind;
}
