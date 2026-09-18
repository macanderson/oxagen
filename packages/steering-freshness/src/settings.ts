/**
 * settings.ts — reading the `steering` block out of the Oxagen settings
 * files, at the same paths and in the same order `@oxagen/mcp-config`
 * already uses.
 *
 * The paths are duplicated rather than imported. `@oxagen/mcp-config` pulls
 * in the whole MCP settings schema, and this package is loaded from a git
 * hook on the path of every prompt submission, where start-up cost is the
 * whole budget. The three constants below are pinned by
 * `settings.paths.test.ts` against that package's, so the duplication cannot
 * drift silently.
 *
 * A settings file that does not parse is reported, never ignored and never
 * fatal. Ignoring it would silently drop an organisation's `blockStaleRuns`;
 * refusing to run would let one stray comma stop every prompt in a
 * repository. The caller decides, with the warning in hand.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execGit, gitOrNull, isSafeRefName, type GitRunner } from "./git";
import {
  steeringPolicyFileSchema,
  type PolicyLayer,
  type PolicyScope,
  type SteeringPolicyFile,
} from "./policy";

/** Mirrors `@oxagen/mcp-config`'s three scopes. */
export const USER_SETTINGS_RELATIVE = join(
  ".config",
  "oxagen",
  "settings.json",
);
export const PROJECT_DIR_NAME = ".oxagen";
export const PROJECT_SETTINGS_FILE = "settings.json";
export const LOCAL_SETTINGS_FILE = "settings.local.json";

export interface SettingsReadWarning {
  scope: PolicyScope;
  path: string;
  message: string;
}

export interface LoadedSettings {
  layers: PolicyLayer[];
  warnings: SettingsReadWarning[];
}

/** Read one file's `steering` block. Absent file → no layer, no warning. */
async function readLayer(
  scope: PolicyScope,
  path: string,
  read: typeof readFile,
): Promise<{ layer: PolicyLayer | null; warning: SettingsReadWarning | null }> {
  let text: string;
  try {
    text = await read(path, "utf8");
  } catch (err) {
    // Any unreadable file is treated as absent — not only ENOENT. A settings
    // file the developer cannot read (EACCES on a shared machine, EISDIR from
    // a bad mount) is a file that contributes nothing, and the alternative is
    // failing every prompt over a permissions bug elsewhere.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { layer: null, warning: null };
    }
    return {
      layer: null,
      warning: {
        scope,
        path,
        message: `could not be read (${code ?? "unknown error"})`,
      },
    };
  }

  return parseLayer(scope, path, text);
}

/** Parse one settings file's text into its `steering` layer. */
function parseLayer(
  scope: PolicyScope,
  path: string,
  text: string,
): { layer: PolicyLayer | null; warning: SettingsReadWarning | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      layer: null,
      warning: {
        scope,
        path,
        message: `is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
      },
    };
  }

  const block = (parsed as { steering?: unknown } | null)?.steering;
  if (block === undefined) return { layer: null, warning: null };

  const result = steeringPolicyFileSchema.safeParse(block);
  if (!result.success) {
    return {
      layer: null,
      warning: {
        scope,
        path,
        message: `has an invalid "steering" block: ${result.error.issues
          .map((i) => `${i.path.join(".") || "steering"}: ${i.message}`)
          .join("; ")}`,
      },
    };
  }
  return { layer: { scope, policy: result.data }, warning: null };
}

export interface LoadSettingsOptions {
  /** The repository (or project) root that holds `.oxagen/`. */
  projectRoot: string;
  /** Override the user-scope path. Tests and hosts with their own home. */
  userSettingsPath?: string;
  /** Injected for tests. */
  read?: typeof readFile;
  /** The platform's workspace policy, already fetched. Highest scope. */
  workspacePolicy?: SteeringPolicyFile | null;
}

/** Read every scope's `steering` block, lowest precedence first. */
export async function loadSteeringSettings({
  projectRoot,
  userSettingsPath = join(homedir(), USER_SETTINGS_RELATIVE),
  read = readFile,
  workspacePolicy = null,
}: LoadSettingsOptions): Promise<LoadedSettings> {
  const targets: Array<[PolicyScope, string]> = [
    ["user", userSettingsPath],
    ["project", join(projectRoot, PROJECT_DIR_NAME, PROJECT_SETTINGS_FILE)],
    ["local", join(projectRoot, PROJECT_DIR_NAME, LOCAL_SETTINGS_FILE)],
  ];

  const layers: PolicyLayer[] = [];
  const warnings: SettingsReadWarning[] = [];
  for (const [scope, path] of targets) {
    const { layer, warning } = await readLayer(scope, path, read);
    if (layer) layers.push(layer);
    if (warning) warnings.push(warning);
  }
  if (workspacePolicy) {
    layers.push({ scope: "workspace", policy: workspacePolicy });
  }
  return { layers, warnings };
}

export interface CommittedGatesOptions {
  /** The repository root. */
  cwd: string;
  /** The resolved policy's remote and branch: the production branch. */
  remote: string;
  /** Null when no scope named one; the remote's own default is read then. */
  branch: string | null;
  run?: GitRunner;
  timeoutMs?: number;
}

/**
 * The two gates as the production branch's `.oxagen/settings.json` sets them.
 *
 * `loadSteeringSettings` reads the project file from the working copy, and a
 * working copy is whatever the developer last typed. A team that committed
 * `blockStaleRuns: true` had it switched off by an edit nobody committed: the
 * OR fold never saw the committed `true`, because nothing read it. The rule
 * that a lower scope may switch a gate on and never off did not hold against
 * the file's own earlier, reviewed value.
 *
 * So the reviewed value is read as well, from the remote-tracking ref of the
 * production branch, and folded in as one more `project` layer. HEAD would
 * not do: a local commit on a feature branch is as unreviewed as an edit. The
 * working copy still counts, so a branch can switch a gate on before it
 * merges. It can no longer switch one off.
 *
 * Only the two booleans are carried. `remote`, `branch` and
 * `fetchIntervalSeconds` hold no authority and stay with the working copy,
 * and a project `exclude` is refused from either tree.
 *
 * The ref is read as it was last fetched. That costs no network on the prompt
 * path, and a stale ref still holds reviewed history. With no such ref, or no
 * file in it, there is no layer and no warning: a repository that never
 * committed a policy has none to enforce.
 */
export async function loadCommittedProjectGates({
  cwd,
  remote,
  branch,
  run = execGit,
  timeoutMs = 5_000,
}: CommittedGatesOptions): Promise<{
  layer: PolicyLayer | null;
  warning: SettingsReadWarning | null;
}> {
  if (!isSafeRefName(remote) || (branch !== null && !isSafeRefName(branch))) {
    return { layer: null, warning: null };
  }
  const ref = `refs/remotes/${remote}/${branch ?? "HEAD"}`;
  const spec = `${ref}:${PROJECT_DIR_NAME}/${PROJECT_SETTINGS_FILE}`;
  const text = await gitOrNull({ cwd, run, timeoutMs }, "show", spec);
  // An empty blob holds no policy. The working-copy read reports the file if
  // it is empty there too, so it is not reported twice.
  if (text === null || text === "") return { layer: null, warning: null };

  const { layer, warning } = parseLayer("project", spec, text);
  if (layer === null) return { layer: null, warning };
  const { autoSync, blockStaleRuns } = layer.policy;
  return {
    layer: {
      scope: "project",
      policy: {
        ...(autoSync === undefined ? {} : { autoSync }),
        ...(blockStaleRuns === undefined ? {} : { blockStaleRuns }),
      },
    },
    warning: null,
  };
}
