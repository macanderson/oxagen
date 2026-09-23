/**
 * The app's contract with the CLIs: the argv each panel action hands to a
 * sidecar, as pure functions of UI state. Kept apart from the React tree so
 * the mapping is testable without a webview.
 */
export type Harness =
  | "claude-code"
  | "codex"
  | "cursor"
  | "stella"
  | "claude-desktop";

export const HARNESS_LABEL: Record<Harness, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  stella: "Stella",
  "claude-desktop": "Claude Desktop",
};

/** Every app the machine can put under Oxagen, in display order. */
export const HARNESSES: Harness[] = [
  "claude-code",
  "codex",
  "cursor",
  "stella",
  "claude-desktop",
];

/**
 * Which enforcement tier each app can reach (ADR-078). Mirrors
 * `TACHO_HARNESS_TIERS` in `packages/tacho/src/wire.ts`; the desktop app
 * reads files the CLIs write and shares no runtime code with them, so the
 * list is written twice and `commands.test.ts` is where the two meet.
 *
 * `harness` is **wrapped**: a PreToolUse hook sees every action, including
 * the agent's own commands and file edits, but runs in a process Oxagen does
 * not own, so the record is what the agent reported.
 *
 * `gateway` is **connected**: no hook exists, so Oxagen sees only the calls
 * routed through its MCP gateway — and refuses those on the server.
 *
 * Neither is the better one. A row that reads as "more governed" or "less
 * governed" is wrong in both directions.
 */
export type Tier = "harness" | "gateway";

export const HARNESS_TIER: Record<Harness, Tier> = {
  "claude-code": "harness",
  codex: "harness",
  cursor: "harness",
  stella: "harness",
  "claude-desktop": "gateway",
};

/** The word for each tier on screen. */
export const TIER_LABEL: Record<Tier, string> = {
  harness: "Wrapped",
  gateway: "Connected",
};

/** What each tier records, in the app's own words. */
export const TIER_RECORDS: Record<Tier, string> = {
  harness:
    "Every action this agent takes, including the commands it runs and the files it changes.",
  gateway: "The Oxagen tools this app calls, and the ones it was refused.",
};

/** What each tier does not record. Never omitted: this is the honesty rule. */
export const TIER_OMITS: Record<Tier, string> = {
  harness:
    "Oxagen does not run this agent, so the record is what the agent reported. Remove its hooks and it stops reporting.",
  gateway:
    "Not your prompts, not the model's replies, and nothing this app does through any other tool.",
};

/** Whether a harness is wrapped through a hook. */
export function isWrapped(harness: Harness): boolean {
  return HARNESS_TIER[harness] === "harness";
}

/**
 * The subset of a selection that `tacho verify` can actually run.
 *
 * `verify` drives one headless turn and waits for the hook chain it seals, so
 * it has nothing to do for a connected app — a GUI bundle with no headless
 * mode and no hook — and returns `ok: false` saying exactly that. Handing it
 * one anyway turned the wizard's "record a first run" step into a red
 * "failed · claude-desktop is a connected app" for the whole flow, and on a
 * machine where Claude Desktop is the only registered app that was the only
 * line the operator ever saw: a failure report for something that cannot
 * succeed and did not go wrong.
 *
 * A connected app is not dropped from the screen — it is registered and the
 * operator should see it — only from the list of things a first run is
 * attempted on. It reports the first time they use it.
 */
export function verifiable(harnesses: readonly Harness[]): Harness[] {
  return harnesses.filter(isWrapped);
}

/** Whether a harness is connected through the local MCP gateway. */
export function isConnected(harness: Harness): boolean {
  return HARNESS_TIER[harness] === "gateway";
}

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

/**
 * `oxagen login --browser`: the PKCE flow forced open. The sidecar runs with
 * piped stdio, so a bare `login` would refuse (no TTY, no token) or, with a
 * session saved, print it and exit 0 without re-authenticating; the flag
 * makes both Sign in and Switch organization the browser flow.
 */
export function loginArgs(options: { signup?: boolean } = {}): string[] {
  return options.signup === true
    ? ["login", "--browser", "--signup"]
    : ["login", "--browser"];
}

/**
 * An org change is only a change once a workspace in that org is picked:
 * the previous org's workspace slug means nothing in the new one, and a
 * same-named slug there is a workspace the operator never chose.
 */
export function needsWorkspacePick(
  currentOrg: string | null,
  picks: Pick<Picks, "org" | "workspace">,
): boolean {
  return (
    picks.org !== null && picks.org !== currentOrg && picks.workspace === null
  );
}

/** The parts of the CLI's `config.json` that say whose session is on disk. */
export interface SessionView {
  logged_in: boolean;
  org_slug: string | null;
  workspace_slug: string | null;
}

/**
 * Whether a running `login --browser` has already done the job it was
 * spawned for: the session it writes is on disk.
 *
 * The app clears its busy state when a sidecar process closes, which is the
 * right rule for every command that has a result to report. Sign-in is the
 * exception: the session lands in `config.json` before the process is
 * finished with it, so a login that is slow to exit would otherwise hold the
 * organization and workspace pickers disabled behind a sign-in that already
 * worked. A same-organization re-login writes nothing this can see, so that
 * one still waits for the process. There is nothing to detect and nothing
 * to be wrong about.
 */
export function sessionLanded(before: SessionView, now: SessionView): boolean {
  if (!now.logged_in) return false;
  if (!before.logged_in) return true;
  return (
    now.org_slug !== before.org_slug ||
    now.workspace_slug !== before.workspace_slug
  );
}

/** What the Workspace and Wrappers panels would change on the host. */
export function pendingChange(
  host: HostTarget | null,
  picks: Picks,
): { target: boolean; harness: boolean } {
  if (host === null) return { target: false, harness: false };
  const target =
    !needsWorkspacePick(host.org_slug, picks) &&
    ((picks.org !== null && picks.org !== host.org_slug) ||
      (picks.workspace !== null && picks.workspace !== host.workspace_slug));
  const harness =
    picks.harnesses !== null && !sameSet(picks.harnesses, host.harnesses);
  return { target, harness };
}

/**
 * `tacho enroll` for a machine that is not enrolled yet. `--org` never
 * travels without `--workspace`: tacho would fill the workspace from the
 * CLI's config.json, which names the previously signed-in org's workspace.
 */
export function enrollArgs(picks: Picks): string[] {
  if (picks.org !== null && picks.workspace === null)
    throw new Error(`pick a workspace in ${picks.org} first`);
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
  if (needsWorkspacePick(host.org_slug, picks))
    throw new Error(`pick a workspace in ${picks.org} first`);
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

/**
 * Whether de-registering this harness needs a live sign-in. With others left
 * it is a `tacho reassign`, which revokes and enrolls again with the session;
 * the last one is an `unenroll`, which finishes offline.
 */
export function deregisterNeedsSession(
  enrolled: readonly string[],
  harness: Harness,
): boolean {
  return deregisterArgs(enrolled, harness).args[0] === "reassign";
}

/**
 * The collector in the wizard's confirmation. It read "starting…" for as
 * long as the collector did not answer, which the app had no way to know.
 */
export function collectorText(daemonUp: boolean, port: number): string {
  return daemonUp
    ? `running on 127.0.0.1:${port}`
    : `not answering on 127.0.0.1:${port}`;
}

/**
 * The workspace root in the Oxagen app, where the host reports to. Not
 * `/runs`: that route does not exist in `apps/app` (its workspace sections
 * are `knowledge`, `marketplace`, `sessions`, `settings`, `workbench`, plus
 * the workspace root itself), so a `/runs` link 404s.
 */
export function workspaceUrl(
  appUrl: string,
  org: string,
  workspace: string,
): string {
  return `${appUrl.replace(/\/+$/, "")}/${encodeURIComponent(org)}/${encodeURIComponent(workspace)}`;
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

/** What `DesktopState.cli_install` reports about the launch-time PATH link. */
export interface CliInstallReport {
  state: "linked" | "already" | "skipped" | "opted_out" | "failed" | "pending";
  dir: string;
  files: string[];
  skipped: string[];
  profile: string | null;
  note: string;
}

/** The Command line panel's one line on what the launch-time auto-link did. */
export function describeCliInstall(
  install: CliInstallReport | null | undefined,
): string | null {
  if (!install) return null;
  const files = install.files.length > 0 ? install.files.join(", ") : "nothing";
  const profile = install.profile ? ` Updated ${install.profile}.` : "";
  const skipped =
    install.skipped.length > 0 ? ` Skipped ${install.skipped.join(", ")}.` : "";
  switch (install.state) {
    case "linked":
      // "linked" with nothing in `files` means every link was already
      // correct: there was nothing to do, so say that rather than
      // "Linked nothing into ...". `profile` can still be set (the profile
      // block is checked every launch regardless), so it still shows.
      return install.files.length > 0
        ? `Linked ${files} into ${install.dir} on launch.${profile}${skipped}`
        : `Already on PATH in ${install.dir}.${profile}${skipped}`;
    case "already":
      // The Rust side leaves `files` empty here: nothing needed linking, so
      // there is nothing to list. Say so plainly rather than "nothing
      // already on PATH".
      return `Already on PATH in ${install.dir}.${skipped}`;
    case "skipped":
      return `Skipped linking on launch: ${install.note}`;
    case "opted_out":
      // "Remove links" lands here, and it reports what it refused to delete
      // (a binary of the same name that Oxagen did not create) the same way
      // the install path reports what it refused to overwrite.
      return `Not linked: you opted out. ${install.note}${skipped}`;
    case "failed":
      return `Could not link into ${install.dir}: ${install.note}`;
    case "pending":
      return "Linking on launch…";
    default:
      return install.note;
  }
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
