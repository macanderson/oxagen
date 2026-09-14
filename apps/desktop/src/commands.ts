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

/** `tacho reassign` carrying only what differs from the host. */
export function reassignArgs(host: HostTarget, picks: Picks): string[] {
  const change = pendingChange(host, picks);
  const org = picks.org ?? host.org_slug;
  return [
    "reassign",
    ...(org !== host.org_slug ? ["--org", org] : []),
    ...(change.target
      ? ["--workspace", picks.workspace ?? host.workspace_slug]
      : []),
    ...(change.harness && picks.harnesses
      ? ["--harness", picks.harnesses.join(",")]
      : []),
  ];
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
