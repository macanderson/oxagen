/**
 * The app's contract with the CLIs: the argv each panel action hands to a
 * sidecar, as pure functions of UI state. Kept apart from the React tree so
 * the mapping is testable without a webview.
 */
export type Harness = "claude-code" | "codex";

export const HARNESS_LABEL: Record<Harness, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

export interface HostTarget {
  org_slug: string;
  workspace_slug: string;
  harnesses: string[];
}

export interface Picks {
  org: string | null;
  workspace: string | null;
  harnesses: Harness[] | null;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return [...a].sort().join(",") === [...b].sort().join(",");
}

/** What the Workspace and Wrappers panels would change on the host. */
export function pendingChange(
  host: HostTarget | null,
  picks: Picks,
): { target: boolean; harness: boolean } {
  if (host === null) return { target: false, harness: false };
  const target =
    (picks.org !== null && picks.org !== host.org_slug) ||
    (picks.workspace !== null && picks.workspace !== host.workspace_slug);
  const harness =
    picks.harnesses !== null && !sameSet(picks.harnesses, host.harnesses);
  return { target, harness };
}

/** `tacho enroll` for a machine that is not enrolled yet. */
export function enrollArgs(picks: Picks): string[] {
  return [
    "enroll",
    ...(picks.org ? ["--org", picks.org] : []),
    ...(picks.workspace ? ["--workspace", picks.workspace] : []),
    "--harness",
    (picks.harnesses ?? ["claude-code"]).join(","),
  ];
}

/** A sidecar and the argv to hand it. */
export interface SidecarCall {
  sidecar: "tacho" | "oxagen";
  args: string[];
}

/**
 * `tacho reassign` carrying only what differs from the host. With
 * `alsoDefault`, the same command runs through the `oxagen` sidecar as
 * `oxagen tacho reassign … --default`, which also writes the new pair into
 * `config.json`; `config.json` is the CLI's file, so `tacho` alone cannot.
 */
export function reassignArgs(
  host: HostTarget,
  picks: Picks,
  alsoDefault = false,
): SidecarCall {
  const change = pendingChange(host, picks);
  const org = picks.org ?? host.org_slug;
  const args = [
    "reassign",
    ...(org !== host.org_slug ? ["--org", org] : []),
    ...(change.target
      ? ["--workspace", picks.workspace ?? host.workspace_slug]
      : []),
    ...(change.harness && picks.harnesses
      ? ["--harness", picks.harnesses.join(",")]
      : []),
  ];
  return alsoDefault
    ? { sidecar: "oxagen", args: ["tacho", ...args, "--default"] }
    : { sidecar: "tacho", args };
}

/** `tacho unenroll`, with `--purge` when the operator also drops the WAL. */
export function unenrollArgs(purge: boolean): string[] {
  return ["unenroll", ...(purge ? ["--purge"] : [])];
}

/** Toggle a harness in a list; the list never empties. */
export function toggleHarness(list: Harness[], harness: Harness): Harness[] {
  const next = list.includes(harness)
    ? list.filter((h) => h !== harness)
    : [...list, harness];
  return next.length === 0 ? list : next;
}

/** "3m ago" style relative time for the panels; `never` when absent. */
export function ago(
  iso: string | null | undefined,
  now: number = Date.now(),
): string {
  if (!iso) return "never";
  const ms = now - Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * De-register one harness: re-enroll in place with the rest, or unenroll
 * outright when it was the last one (the hooks, service and credentials go
 * with it). The wizard's install side asked twice; the UI asks twice here.
 */
export function deregisterArgs(
  enrolled: readonly string[],
  harness: Harness,
): SidecarCall {
  const remaining = enrolled.filter((h) => h !== harness);
  if (remaining.length === 0) return { sidecar: "tacho", args: ["unenroll"] };
  return {
    sidecar: "tacho",
    args: ["reassign", "--harness", remaining.join(",")],
  };
}

/** Mission Control for the workspace the host reports to. */
export function missionControlUrl(
  appUrl: string,
  org: string,
  workspace: string,
): string {
  return `${appUrl.replace(/\/+$/, "")}/${encodeURIComponent(org)}/${encodeURIComponent(workspace)}/runs`;
}

export type WizardStep = 1 | 2 | 3 | 4 | 5;

/**
 * Where the first-run wizard stands, derived from the machine's state so a
 * relaunch resumes at the right step: 1 sign in → 2 org & workspace →
 * 3 detect and register agents → 4 outcome → 5 record a first run.
 */
export function wizardStep(input: {
  loggedIn: boolean;
  targetChosen: boolean;
  enrolled: boolean;
  outcomeSeen: boolean;
}): WizardStep {
  if (!input.loggedIn) return 1;
  if (!input.enrolled) return input.targetChosen ? 3 : 2;
  return input.outcomeSeen ? 5 : 4;
}

/** Default selection for step 3: every installed harness, none of the absent ones. */
export function defaultRegistration(
  detected: ReadonlyArray<{ harness: Harness; installed: boolean }>,
): Harness[] {
  return detected.filter((d) => d.installed).map((d) => d.harness);
}

/** The one gold action on screen: the next step, never a destructive one. */
export function primaryAction(
  loggedIn: boolean,
  enrolled: boolean,
  change: { target: boolean; harness: boolean },
): "signin" | "enroll" | "apply" | null {
  if (!loggedIn) return "signin";
  if (!enrolled) return "enroll";
  if (change.target || change.harness) return "apply";
  return null;
}
