// settings.ts: read, compare, and apply the GitLab settings baseline.
//
// The baseline protects main so no one pushes and only the Oxagen bot merges.
// It requires squash merges and a passing pipeline, and it turns CI/CD off.
// Apply is a diff. It reads the project, writes only what differs, reads
// again, and returns what still differs.
//
// To replace a protected branch that differs, apply unprotects it and
// protects it again. GitLab can also update a protection in place with PATCH
// and `_destroy` entries, but only from 15.6 on. Delete then create works on
// every version. Main is unprotected between the two calls, and a rerun
// after a failure between them protects it again.
import { requireData, seg } from "./http";
import type { GitlabRest } from "./http";
import type {
  ObservedGitlabSettings,
  ObservedProtectedBranch,
  SettingDifference,
  SteeringBot,
  SteeringGitlabSettings,
} from "./types";

interface ProjectSettingsBody {
  visibility: string;
  default_branch: string | null;
  squash_option: string;
  only_allow_merge_if_pipeline_succeeds: boolean | null;
  remove_source_branch_after_merge: boolean | null;
  builds_access_level: string;
}

interface AccessLevelBody {
  access_level: number;
  user_id?: number | null;
  group_id?: number | null;
  deploy_key_id?: number | null;
}

interface ProtectedBranchBody {
  name: string;
  push_access_levels?: AccessLevelBody[];
  merge_access_levels?: AccessLevelBody[];
  allow_force_push?: boolean;
}

const LEVEL_SYMBOLS: Readonly<Record<number, string>> = {
  0: "no_one",
  30: "developers",
  40: "maintainers",
  60: "admins",
};

/** One access entry as a symbol. GitLab sets a level on user entries too, so the user comes first. */
function symbolOf(entry: AccessLevelBody, bot: SteeringBot): string {
  if (typeof entry.user_id === "number")
    return entry.user_id === bot.user_id ? bot.symbol : `user:${entry.user_id}`;
  if (typeof entry.group_id === "number") return `group:${entry.group_id}`;
  if (typeof entry.deploy_key_id === "number")
    return `deploy_key:${entry.deploy_key_id}`;
  return LEVEL_SYMBOLS[entry.access_level] ?? `level:${entry.access_level}`;
}

/**
 * One access list as a string. A "no one" entry beside other entries grants
 * nothing, so it drops out. Some GitLab versions add one beside a user entry,
 * and others add a Maintainers entry when the request names only a user.
 */
function accessOf(
  entries: readonly AccessLevelBody[] | undefined,
  bot: SteeringBot,
): string {
  const granted = [...new Set((entries ?? []).map((e) => symbolOf(e, bot)))]
    .filter((s) => s !== "no_one")
    .sort();
  return granted.length > 0 ? granted.join(", ") : "no_one";
}

/** Read every setting the baseline holds, as GitLab reports it now. */
export async function readGitlabSettings(
  rest: GitlabRest,
  project_id: number,
  bot: SteeringBot,
): Promise<ObservedGitlabSettings> {
  const root = `/projects/${seg(project_id)}`;
  const project = requireData(
    await rest.request<ProjectSettingsBody>("GET", root),
    "project",
  );
  // A steering repo holds one protected branch, so one page of 100 is enough.
  const branches = requireData(
    await rest.request<ProtectedBranchBody[]>(
      "GET",
      `${root}/protected_branches?per_page=100`,
    ),
    "protected branches",
  );
  const protected_branches: Record<string, ObservedProtectedBranch> = {};
  for (const branch of branches) {
    protected_branches[branch.name] = {
      push_access: accessOf(branch.push_access_levels, bot),
      merge_access: accessOf(branch.merge_access_levels, bot),
      allow_force_push: branch.allow_force_push === true,
    };
  }
  return {
    visibility: project.visibility,
    default_branch: project.default_branch,
    protected_branches,
    merge_requests: {
      squash_option: project.squash_option,
      only_allow_merge_if_pipeline_succeeds:
        project.only_allow_merge_if_pipeline_succeeds === true,
      remove_source_branch_after_merge:
        project.remove_source_branch_after_merge === true,
    },
    ci_cd: { builds_access_level: project.builds_access_level },
  };
}

/** An access string with the bot's user entry read as the bot's symbol. */
function normalizeAccess(access: string, bot: SteeringBot): string {
  return access
    .split(", ")
    .map((s) => (s === `user:${bot.user_id}` ? bot.symbol : s))
    .sort()
    .join(", ");
}

/**
 * Every setting where `actual` differs from `expected`. Protected branches
 * that the baseline does not name are left alone.
 *
 * `merge_requests.required_status` is not a GitLab project setting. GitLab
 * has no per-project list of required external statuses, so "pipelines must
 * succeed" covers it, and neither compare nor apply reads it.
 */
export function compareGitlabSettings(
  expected: SteeringGitlabSettings,
  actual: ObservedGitlabSettings,
  bot: SteeringBot,
): SettingDifference[] {
  const differences: SettingDifference[] = [];
  const check = (setting: string, want: unknown, found: unknown): void => {
    if (want !== found) differences.push({ setting, expected: want, actual: found });
  };
  check("visibility", expected.visibility, actual.visibility);
  check("default_branch", expected.default_branch, actual.default_branch);
  for (const [name, want] of Object.entries(expected.protected_branches)) {
    const key = `protected_branches.${name}`;
    const found = actual.protected_branches[name];
    if (found === undefined) {
      differences.push({ setting: key, expected: want, actual: null });
      continue;
    }
    check(`${key}.push_access`, want.push_access, normalizeAccess(found.push_access, bot));
    check(`${key}.merge_access`, want.merge_access, normalizeAccess(found.merge_access, bot));
    check(`${key}.allow_force_push`, want.allow_force_push, found.allow_force_push);
  }
  const mr = expected.merge_requests;
  check("merge_requests.squash_option", mr.squash_option, actual.merge_requests.squash_option);
  check(
    "merge_requests.only_allow_merge_if_pipeline_succeeds",
    mr.only_allow_merge_if_pipeline_succeeds,
    actual.merge_requests.only_allow_merge_if_pipeline_succeeds,
  );
  check(
    "merge_requests.remove_source_branch_after_merge",
    mr.remove_source_branch_after_merge,
    actual.merge_requests.remove_source_branch_after_merge,
  );
  check(
    "ci_cd.builds_access_level",
    expected.ci_cd.builds_access_level,
    actual.ci_cd.builds_access_level,
  );
  return differences;
}

/** Each project-level setting, the field `PUT /projects/:id` takes, and its baseline value. */
const PROJECT_FIELDS: readonly (readonly [
  string,
  string,
  (s: SteeringGitlabSettings) => unknown,
])[] = [
  ["visibility", "visibility", (s) => s.visibility],
  ["default_branch", "default_branch", (s) => s.default_branch],
  ["merge_requests.squash_option", "squash_option", (s) => s.merge_requests.squash_option],
  [
    "merge_requests.only_allow_merge_if_pipeline_succeeds",
    "only_allow_merge_if_pipeline_succeeds",
    (s) => s.merge_requests.only_allow_merge_if_pipeline_succeeds,
  ],
  [
    "merge_requests.remove_source_branch_after_merge",
    "remove_source_branch_after_merge",
    (s) => s.merge_requests.remove_source_branch_after_merge,
  ],
  ["ci_cd.builds_access_level", "builds_access_level", (s) => s.ci_cd.builds_access_level],
];

function touches(differences: readonly SettingDifference[], prefix: string): boolean {
  return differences.some(
    (d) => d.setting === prefix || d.setting.startsWith(`${prefix}.`),
  );
}

/** The user id a baseline symbol names. Only the bot can be named. */
function resolveMerger(bot: SteeringBot, symbol: string): number {
  if (symbol !== bot.symbol)
    throw new Error(
      `The baseline names ${symbol}, which provisioning cannot resolve to a GitLab user.`,
    );
  return bot.user_id;
}

/**
 * Bring the project to the baseline. Only settings that differ are written.
 * `changed` lists what differed before, and `remaining` lists what a second
 * read still found different.
 */
export async function applyGitlabSettings(
  rest: GitlabRest,
  project_id: number,
  bot: SteeringBot,
  baseline: SteeringGitlabSettings,
): Promise<{
  changed: SettingDifference[];
  remaining: SettingDifference[];
  observed: ObservedGitlabSettings;
}> {
  const mergers = new Map<string, number>();
  for (const [name, branch] of Object.entries(baseline.protected_branches))
    mergers.set(name, resolveMerger(bot, branch.merge_access));

  const before = await readGitlabSettings(rest, project_id, bot);
  const changed = compareGitlabSettings(baseline, before, bot);
  if (changed.length === 0) return { changed, remaining: [], observed: before };

  const root = `/projects/${seg(project_id)}`;
  const update: Record<string, unknown> = {};
  for (const [setting, field, value] of PROJECT_FIELDS)
    if (touches(changed, setting)) update[field] = value(baseline);
  if (Object.keys(update).length > 0) await rest.request("PUT", root, update);

  for (const [name, branch] of Object.entries(baseline.protected_branches)) {
    if (!touches(changed, `protected_branches.${name}`)) continue;
    if (before.protected_branches[name] !== undefined)
      await rest.request(
        "DELETE",
        `${root}/protected_branches/${seg(name)}`,
        undefined,
        [404],
      );
    await rest.request("POST", `${root}/protected_branches`, {
      name,
      push_access_level: 0,
      merge_access_level: 0,
      // `allowed_to_merge` with a user id needs GitLab Premium, which group
      // access tokens need too.
      allowed_to_merge: [{ user_id: mergers.get(name) }],
      allow_force_push: branch.allow_force_push,
    });
  }

  const after = await readGitlabSettings(rest, project_id, bot);
  return {
    changed,
    remaining: compareGitlabSettings(baseline, after, bot),
    observed: after,
  };
}
