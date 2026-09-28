// Which webhook deliveries ask for a steering repo health read (S2, #4560).
//
// A setting can change on the host at any time. The webhook routes turn each
// delivery that could change a steering repo's health into a signal: the
// repository ids it names, the installation when it touches every repo in
// one, and a trigger that says who changed what and when. Everything else
// maps to null and asks for nothing. The 10-minute sweep reads every ready
// steering repo whether or not a delivery arrived.
//
// This module reads payloads only. It holds no I/O, so the routes can call it
// before they touch the database.
import { rulesetKey } from "@oxagen/github/provision";
import {
  GITHUB_SETTINGS_BASELINE,
  STEERING_DEFAULT_BRANCH,
} from "@oxagen/oxagen/steering-repo";
import type { HealthSignal, HealthTrigger } from "./health";

const MAIN_REF = `refs/heads/${STEERING_DEFAULT_BRANCH}`;

type Payload = Record<string, unknown>;

function record(value: unknown): Payload | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Payload)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function id(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

/** The ids of a list of `{ id }` objects, without the ones that are not ids. */
function ids(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out = new Set<number>();
  for (const item of value) {
    const found = id(record(item)?.id);
    if (found !== null) out.add(found);
  }
  return [...out];
}

/**
 * GitLab writes some times as `2013-12-03 17:23:34 UTC` or
 * `2013-12-03 17:23:34 +0100`. Rewrite those as ISO 8601 before parsing, so
 * the result does not depend on how a runtime reads a nonstandard date.
 */
const GITLAB_TIME = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?) ?(UTC|Z|[+-]\d{2}:?\d{2})$/;

/** A GitLab time as ISO 8601. Any other string comes back as it was. */
function isoFromGitlab(value: string): string {
  const match = GITLAB_TIME.exec(value);
  if (match === null) return value;
  const [, date = "", time = "", zone = ""] = match;
  const offset =
    zone === "UTC" || zone === "Z" ? "Z" : zone.replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
  return `${date}T${time}${offset}`;
}

/**
 * A time as ISO 8601 in UTC, or null when it is missing or does not parse. A
 * number is a Unix time in seconds, which is how GitHub sends `pushed_at`.
 */
function instant(value: unknown): string | null {
  let ms: number;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    ms = value * 1000;
  } else if (typeof value === "string" && value.length > 0) {
    ms = Date.parse(isoFromGitlab(value));
  } else {
    return null;
  }
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function trigger(
  reason: string,
  actor: string | null,
  at: string | null,
  settings: readonly string[] = [],
  pull_request: HealthTrigger["pull_request"] = null,
): HealthTrigger {
  return { reason, actor, at, settings, pull_request };
}

function signal(
  provider: HealthSignal["provider"],
  repository_ids: readonly number[],
  installation_id: number | null,
  t: HealthTrigger,
): HealthSignal | null {
  if (repository_ids.length === 0 && installation_id === null) return null;
  return { provider, repository_ids, installation_id, trigger: t };
}

// ── GitHub ───────────────────────────────────────────────────────────────────

/** `repository` `edited`: each key in `changes`, as the setting it touches. */
const REPOSITORY_CHANGES: ReadonlyMap<string, string> = new Map([
  ["default_branch", "default_branch"],
  ["visibility", "visibility"],
  ["private", "visibility"],
  ["allow_squash_merge", "merge.allow_squash_merge"],
  ["allow_merge_commit", "merge.allow_merge_commit"],
  ["allow_rebase_merge", "merge.allow_rebase_merge"],
  ["delete_branch_on_merge", "merge.delete_branch_on_merge"],
]);

/** Every setting a `repository` `edited` delivery can touch when it lists no change. */
const REPOSITORY_EDITED_FALLBACK = ["visibility", "default_branch", "merge"] as const;

function repositoryId(body: Payload): number | null {
  return id(record(body.repository)?.id);
}

/**
 * A repository ruleset. An organization ruleset names no repository and is
 * not part of the baseline, so it asks for nothing. The ruleset's name, and
 * its old name on a rename, pick the baseline entry it touches.
 */
function githubRuleset(body: Payload, action: string, actor: string | null): HealthSignal | null {
  if (action !== "created" && action !== "edited" && action !== "deleted") return null;
  const repo = repositoryId(body);
  if (repo === null) return null;
  const ruleset = record(body.repository_ruleset);
  const renamedFrom = text(record(record(record(body.changes)?.name))?.from);
  const keys = new Set<string>();
  for (const name of [text(ruleset?.name), renamedFrom]) {
    if (name === null) continue;
    const key = rulesetKey(name);
    if (Object.hasOwn(GITHUB_SETTINGS_BASELINE.rulesets, key)) keys.add(key);
  }
  const settings = keys.size > 0 ? [...keys].map((k) => `rulesets.${k}`) : ["rulesets"];
  return signal(
    "github",
    [repo],
    null,
    trigger(`repository_ruleset.${action}`, actor, instant(ruleset?.updated_at), settings),
  );
}

function githubRepository(body: Payload, action: string, actor: string | null): HealthSignal | null {
  const repo = repositoryId(body);
  if (repo === null) return null;
  let settings: string[];
  switch (action) {
    case "edited": {
      const changes = record(body.changes);
      const keys = changes === null ? [] : Object.keys(changes);
      settings =
        keys.length === 0
          ? [...REPOSITORY_EDITED_FALLBACK]
          : [
              ...new Set(
                keys
                  .map((k) => REPOSITORY_CHANGES.get(k))
                  .filter((s): s is string => s !== undefined),
              ),
            ];
      break;
    }
    case "privatized":
    case "publicized":
      settings = ["visibility"];
      break;
    case "renamed":
    case "transferred":
    case "deleted":
    case "archived":
    case "unarchived":
      settings = [];
      break;
    default:
      return null;
  }
  return signal(
    "github",
    [repo],
    null,
    trigger(
      `repository.${action}`,
      actor,
      instant(record(body.repository)?.updated_at),
      settings,
    ),
  );
}

/** A repository added to or removed from the installation. Removal disconnects it. */
function githubInstallationRepositories(
  body: Payload,
  action: string,
  actor: string | null,
): HealthSignal | null {
  const repos =
    action === "removed"
      ? ids(body.repositories_removed)
      : action === "added"
        ? ids(body.repositories_added)
        : [];
  if (repos.length === 0) return null;
  return signal(
    "github",
    repos,
    null,
    trigger(`installation_repositories.${action}`, actor, null),
  );
}

/** The whole installation changed, so every steering repo in it is read. */
function githubInstallation(body: Payload, action: string, actor: string | null): HealthSignal | null {
  if (
    action !== "deleted" &&
    action !== "suspend" &&
    action !== "unsuspend" &&
    action !== "new_permissions_accepted"
  )
    return null;
  const installation = record(body.installation);
  const installationId = id(installation?.id);
  if (installationId === null) return null;
  const at =
    action === "suspend"
      ? instant(installation?.suspended_at)
      : instant(installation?.updated_at);
  return signal(
    "github",
    ids(body.repositories),
    installationId,
    trigger(`installation.${action}`, actor, at),
  );
}

/** A push to main. Oxagen merges every commit on main, so a push can mean a divergence. */
function githubPush(body: Payload, actor: string | null): HealthSignal | null {
  if (body.ref !== MAIN_REF) return null;
  const repo = repositoryId(body);
  if (repo === null) return null;
  const at =
    instant(record(body.head_commit)?.timestamp) ??
    instant(record(body.repository)?.pushed_at);
  return signal("github", [repo], null, trigger("push", actor, at));
}

const PULL_REQUEST_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);

/** A pull request whose new head needs the health check. */
function githubPullRequest(body: Payload, action: string, actor: string | null): HealthSignal | null {
  if (!PULL_REQUEST_ACTIONS.has(action)) return null;
  const repo = repositoryId(body);
  const pr = record(body.pull_request);
  const number = id(pr?.number);
  const headSha = text(record(pr?.head)?.sha);
  if (repo === null || number === null || headSha === null) return null;
  return signal(
    "github",
    [repo],
    null,
    trigger(`pull_request.${action}`, actor, instant(pr?.updated_at), [], {
      number,
      head_sha: headSha,
    }),
  );
}

/**
 * The health signal of one GitHub delivery, or null when it cannot change a
 * steering repo's health. `event` is the `X-GitHub-Event` header.
 */
export function githubHealthSignal(event: string, body: Record<string, unknown>): HealthSignal | null {
  const action = text(body.action) ?? "";
  const actor = text(record(body.sender)?.login);
  switch (event) {
    case "repository_ruleset":
      return githubRuleset(body, action, actor);
    case "branch_protection_configuration": {
      if (action !== "enabled" && action !== "disabled") return null;
      const repo = repositoryId(body);
      if (repo === null) return null;
      return signal(
        "github",
        [repo],
        null,
        trigger(`branch_protection_configuration.${action}`, actor, null),
      );
    }
    case "repository":
      return githubRepository(body, action, actor);
    case "installation_repositories":
      return githubInstallationRepositories(body, action, actor);
    case "installation":
      return githubInstallation(body, action, actor);
    case "push":
      return githubPush(body, actor);
    case "pull_request":
      return githubPullRequest(body, action, actor);
    default:
      return null;
  }
}

// ── GitLab ───────────────────────────────────────────────────────────────────

/** A system hook's `event_name`, and the settings it can touch. */
const GITLAB_SYSTEM_EVENTS: ReadonlyMap<string, readonly string[]> = new Map([
  ["project_update", ["visibility", "default_branch", "merge_requests", "ci_cd"]],
  ["project_rename", []],
  ["project_transfer", []],
  ["project_destroy", []],
  ["user_add_to_team", []],
  ["user_remove_from_team", []],
  ["user_update_for_team", []],
]);

const MERGE_REQUEST_ACTIONS = new Set(["open", "reopen", "update"]);

function gitlabProjectId(body: Payload): number | null {
  return id(record(body.project)?.id) ?? id(body.project_id);
}

/** A push to main, timed by the commit it moved main to. */
function gitlabPush(body: Payload): HealthSignal | null {
  if (body.ref !== MAIN_REF) return null;
  const project = gitlabProjectId(body);
  if (project === null) return null;
  const head = text(body.checkout_sha) ?? text(body.after);
  const commits = Array.isArray(body.commits) ? body.commits : [];
  const moved = commits.map(record).find((c) => c !== null && head !== null && c.id === head);
  return signal(
    "gitlab",
    [project],
    null,
    trigger("push", text(body.user_username), instant(moved?.timestamp)),
  );
}

/** A merge request whose new head needs the health check. */
function gitlabMergeRequest(body: Payload): HealthSignal | null {
  const attrs = record(body.object_attributes);
  const action = text(attrs?.action);
  if (action === null || !MERGE_REQUEST_ACTIONS.has(action)) return null;
  const project = gitlabProjectId(body) ?? id(attrs?.target_project_id);
  const number = id(attrs?.iid);
  const headSha = text(record(attrs?.last_commit)?.id);
  if (project === null || number === null || headSha === null) return null;
  return signal(
    "gitlab",
    [project],
    null,
    trigger(
      `merge_request.${action}`,
      text(record(body.user)?.username),
      instant(attrs?.updated_at),
      [],
      { number, head_sha: headSha },
    ),
  );
}

/**
 * The health signal of one GitLab delivery, or null when it cannot change a
 * steering repo's health. A project hook names its event in `object_kind`. A
 * system hook names it in `event_name`.
 */
export function gitlabHealthSignal(body: Record<string, unknown>): HealthSignal | null {
  const kind = text(body.object_kind);
  if (kind === "push") return gitlabPush(body);
  if (kind === "merge_request") return gitlabMergeRequest(body);
  if (kind !== null) return null;
  const name = text(body.event_name);
  const settings = name === null ? undefined : GITLAB_SYSTEM_EVENTS.get(name);
  if (name === null || settings === undefined) return null;
  const project = id(body.project_id);
  if (project === null) return null;
  return signal("gitlab", [project], null, trigger(name, null, instant(body.updated_at), settings));
}
