// A steering repo's health (steering-repo-spec, Settings drift; S2, #4560).
//
// Oxagen reads a steering repo's settings when a settings event arrives, when
// a pull request opens or changes, and every 10 minutes. The read lands in one
// of four states:
//
//   healthy       every prescribed setting matches
//   drifted       a setting differs, and Oxagen can still write settings
//   disconnected  Oxagen lost access to the repository
//   diverged      main holds a commit Oxagen did not merge
//
// While a repo is not healthy, Oxagen merges nothing and publishes nothing
// (`readRepoHealth` is the read S3's merge and S5's publish refuse on), every
// open pull request shows the `Oxagen steering` check as failed with the
// differences, one comment per pull request says the same and is edited in
// place, and the workspace admins get one notification per state change.
//
// The host calls live in ./health.hosts.ts and ./diverged.ts. This module
// holds the comparison, the state, the report, the storage, and the run.
import { createHash } from "node:crypto";
import { schema, withSystemDb } from "@oxagen/database";
import { GitHubRateLimitedError } from "@oxagen/github";
import * as gh from "@oxagen/github/provision";
import * as gl from "@oxagen/gitlab/provision";
import {
  GITHUB_SETTINGS_BASELINE,
  REQUIRED_CHECK_NAME,
} from "@oxagen/oxagen/steering-repo";
import {
  type RepoHealth,
  repoHealthSchema,
  type SettingsDifference,
} from "@oxagen/oxagen/steering-repo/health";
import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { logger } from "../logger";

// ── Scope and trigger ────────────────────────────────────────────────────────

/** Whose steering repo: a workspace's, or the organization's (`workspaceId` null). */
export interface HealthScope {
  orgId: string;
  workspaceId: string | null;
}

/** What asked for a health read, and what the event says about the change. */
export interface HealthTrigger {
  /** Such as `repository_ruleset.deleted`, `push`, `pull_request.opened`, or `sweep`. */
  reason: string;
  /** The login the event names as the actor, or null. */
  actor: string | null;
  /** When the event says the change happened, as ISO 8601, or null. */
  at: string | null;
  /**
   * Setting paths the event touched, such as `rulesets.oxagen_merges` or
   * `merge`. A new difference under one of them is attributed to `actor` and
   * `at`. Empty when the event names no setting.
   */
  settings: readonly string[];
  /** The pull request that opened or changed, or null. */
  pull_request: { number: number; head_sha: string } | null;
}

/** The trigger of the 10-minute sweep. */
export const SWEEP_TRIGGER: HealthTrigger = {
  reason: "sweep",
  actor: null,
  at: null,
  settings: [],
  pull_request: null,
};

/** The event a webhook route sends for each steering repo an event touches. */
export const HEALTH_REQUESTED_EVENT = "steering-repo/health.requested";

/** The data of one `steering-repo/health.requested` event. */
export interface HealthRequestedData {
  orgId: string;
  workspaceId: string | null;
  /** One health read at a time per repo: `<orgId>:<workspaceId or "org">`. */
  key: string;
  trigger: HealthTrigger;
}

/** The concurrency key of a scope's health read. */
export function healthKey(scope: HealthScope): string {
  return `${scope.orgId}:${scope.workspaceId ?? "org"}`;
}

// ── Comparison ───────────────────────────────────────────────────────────────

/** One setting that differs, before it is attributed to anyone. */
export interface RawDifference {
  setting: string;
  expected: unknown;
  actual: unknown;
}

/** The baseline and what the host reports, for one provider. */
export type SettingsSnapshot =
  | {
      provider: "github";
      baseline: gh.SteeringGithubSettings;
      actual: gh.ObservedGithubSettings;
    }
  | {
      provider: "gitlab";
      baseline: gl.SteeringGitlabSettings;
      actual: gl.ObservedGitlabSettings;
      bot: gl.SteeringBot;
    };

/**
 * A setting the host reports but no repair can write. `deployed_by` names who
 * recorded the latest deployment. A deployment someone else records is not a
 * setting, and a repo that stayed drifted on it could never publish again.
 * The published commit is found by the app that recorded it (./diverged.ts),
 * so a foreign deployment changes nothing Oxagen reads.
 */
function isUnrepairable(setting: string): boolean {
  return /^environments\.[^.]+\.deployed_by$/.test(setting);
}

/** A value as JSON with sorted keys, so equal values compare equal. */
export function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Does this list of ruleset rules require Oxagen's check? */
export function requiresCheck(rules: unknown): boolean {
  if (!Array.isArray(rules)) return false;
  return rules.some((rule) => {
    if (rule === null || typeof rule !== "object") return false;
    const r = rule as { type?: unknown; parameters?: unknown };
    if (r.type !== "required_status_checks") return false;
    const params = r.parameters as { required_status_checks?: unknown } | undefined;
    const checks = params?.required_status_checks;
    return (
      Array.isArray(checks) &&
      checks.some(
        (c) =>
          c !== null &&
          typeof c === "object" &&
          (c as { context?: unknown }).context === REQUIRED_CHECK_NAME,
      )
    );
  });
}

/**
 * GitHub: a ruleset that still exists but no longer requires the check shows
 * up as one or more `rulesets.<key>.rules.required_status_checks…` entries.
 * The report and S4's settings check read that as one fact, so fold them
 * into one `rulesets.<key>.rules` entry holding both rule lists.
 */
function foldLostCheck(
  differences: RawDifference[],
  baseline: gh.SteeringGithubSettings,
  actual: gh.ObservedGithubSettings,
): RawDifference[] {
  let out = differences;
  for (const [key, ruleset] of Object.entries(baseline.rulesets)) {
    const found = actual.rulesets[key];
    if (found === undefined) continue;
    if (!requiresCheck(ruleset.rules) || requiresCheck(found.rules)) continue;
    const prefix = `rulesets.${key}.rules.required_status_checks`;
    out = out.filter(
      (d) => d.setting !== prefix && !d.setting.startsWith(`${prefix}.`),
    );
    out.push({
      setting: `rulesets.${key}.rules`,
      expected: ruleset.rules,
      actual: found.rules,
    });
  }
  return out;
}

/**
 * The prescribed settings the repository does not hold, as the host reports
 * them now. A deleted ruleset, environment, rule, or protected branch reads
 * as `actual: null`.
 */
export function settingDifferences(snapshot: SettingsSnapshot): RawDifference[] {
  const raw =
    snapshot.provider === "github"
      ? gh.compareSettings(snapshot.baseline, snapshot.actual)
      : gl.compareGitlabSettings(snapshot.baseline, snapshot.actual, snapshot.bot);
  const normalized: RawDifference[] = raw
    .filter((d) => !isUnrepairable(d.setting))
    .map((d) => ({
      setting: d.setting,
      expected: d.expected,
      actual: d.actual === "missing" || d.actual === undefined ? null : d.actual,
    }));
  const folded =
    snapshot.provider === "github"
      ? foldLostCheck(normalized, snapshot.baseline, snapshot.actual)
      : normalized;
  return folded.sort((a, b) => (a.setting < b.setting ? -1 : a.setting > b.setting ? 1 : 0));
}

/** Does the trigger name this setting, or a setting that holds it? */
function touches(trigger: HealthTrigger, setting: string): boolean {
  return trigger.settings.some(
    (path) => setting === path || setting.startsWith(`${path}.`),
  );
}

/**
 * Attach who changed each setting and when. A difference the last read
 * already held, with the same value, keeps what that read recorded. A new
 * difference under a setting the trigger names takes the trigger's actor and
 * time. Anything else is unattributed: the sweep or a pull request found it,
 * and no event said who.
 */
export function attribute(
  raw: readonly RawDifference[],
  previous: readonly SettingsDifference[],
  trigger: HealthTrigger,
): SettingsDifference[] {
  return raw.map((d) => {
    const prior = previous.find(
      (p) => p.setting === d.setting && canonical(p.actual) === canonical(d.actual),
    );
    if (prior !== undefined)
      return { ...d, changed_by: prior.changed_by, changed_at: prior.changed_at };
    if (!touches(trigger, d.setting))
      return { ...d, changed_by: null, changed_at: null };
    return {
      ...d,
      changed_by: trigger.actor,
      changed_at: toInstant(trigger.at),
    };
  });
}

function toInstant(value: string | null): string | null {
  if (value === null) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * The prescribed settings that differ, each with who changed it and when the
 * event says. `previous` is what the last read stored.
 */
export function compare(
  snapshot: SettingsSnapshot,
  previous: readonly SettingsDifference[] = [],
  trigger: HealthTrigger = SWEEP_TRIGGER,
): SettingsDifference[] {
  return attribute(settingDifferences(snapshot), previous, trigger);
}

/** The state a read lands in. Losing access outranks history, and history outranks settings. */
export function decideHealth(read: {
  disconnected: boolean;
  diverged: boolean;
  differences: number;
}): RepoHealth {
  if (read.disconnected) return "disconnected";
  if (read.diverged) return "diverged";
  if (read.differences > 0) return "drifted";
  return "healthy";
}

// ── Report ───────────────────────────────────────────────────────────────────

/** What a health read found, as the report renders it. */
export interface HealthState {
  provider: "github" | "gitlab";
  health: RepoHealth;
  differences: readonly SettingsDifference[];
  /** Why the repo is disconnected or diverged. */
  reason: string | null;
  /** The published version runs keep using, when known. */
  published_version: number | null;
  /** The pull request that reverts main, when one is open. */
  revert_pr_number: number | null;
}

/** The failed check's title and summary, and the pull request comment. */
export interface HealthReport {
  title: string;
  summary: string;
  comment: string;
  /** Changes whenever anything the report shows changes. */
  digest: string;
}

/** Marks the one comment Oxagen keeps on each pull request. */
export const HEALTH_COMMENT_MARKER = "<!-- oxagen-steering-health -->";

/** The `external_id` of a GitHub check run a health read posted. */
export const HEALTH_CHECK_EXTERNAL_ID = "oxagen-steering-health";

export const HEALTH_TITLES: Readonly<Record<Exclude<RepoHealth, "healthy">, string>> = {
  drifted: "Repository settings changed",
  disconnected: "Oxagen lost access to the repository",
  diverged: "main holds a commit Oxagen did not merge",
};

const HEALTHY_AGAIN =
  "The steering repo is healthy again. Oxagen merges and publishes again.";

const REPAIR_SETTINGS =
  "Repair: an admin selects Repair settings on the steering repo banner in Oxagen.";

function rulesetName(key: string): string {
  if (key === "oxagen_steering") return "Oxagen steering";
  if (key === "oxagen_merges") return "Oxagen merges";
  return GITHUB_SETTINGS_BASELINE.rulesets[key]?.name ?? key;
}

/** A setting's value as one short line: `unset`, `"private"`, `true`, or JSON cut at 120 characters. */
export function displaySettingValue(value: unknown): string {
  const text = value === undefined || value === null ? "unset" : JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

const shown = displaySettingValue;

/** One difference as a sentence fragment, such as `ruleset "Oxagen merges" was deleted`. */
export function describeDifference(difference: SettingsDifference): string {
  const { setting, expected, actual } = difference;
  const parts = setting.split(".");
  const [head, key, field] = parts;
  if (head === "rulesets" && key !== undefined) {
    const name = rulesetName(key);
    if (parts.length === 2 && actual === null) return `ruleset "${name}" was deleted`;
    if (field === "rules" && parts.length === 3 && requiresCheck(expected) && !requiresCheck(actual))
      return `ruleset "${name}" no longer requires the check "${REQUIRED_CHECK_NAME}"`;
    if (field === "rules" && parts.length === 4 && actual === null)
      return `ruleset "${name}" lost its ${parts[3] as string} rule`;
    return `ruleset "${name}" changed: ${parts.slice(2).join(".")} is ${shown(actual)}, expected ${shown(expected)}`;
  }
  if (head === "environments" && key !== undefined && parts.length === 2 && actual === null)
    return `environment "${key}" was deleted`;
  if (head === "protected_branches" && key !== undefined) {
    if (parts.length === 2 && actual === null) return `branch ${key} is no longer protected`;
    if (field === "allow_force_push" && actual === true) return `branch ${key} allows force pushes`;
  }
  if (setting === "actions.enabled" && actual === true) return "GitHub Actions is on";
  if (setting === "ci_cd.builds_access_level" && actual !== "disabled") return "CI/CD is on";
  if (setting === "visibility") return `the repository is ${shown(actual)}, expected ${shown(expected)}`;
  if (setting === "default_branch") return `the default branch is ${shown(actual)}, expected ${shown(expected)}`;
  return `${setting} is ${shown(actual)}, expected ${shown(expected)}`;
}

/** `2026-09-26 14:02 UTC` */
function minuteUtc(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function attribution(difference: SettingsDifference): string {
  const at = difference.changed_at ? minuteUtc(difference.changed_at) : null;
  const by = difference.changed_by ? `@${difference.changed_by}` : null;
  if (at && by) return ` (${at}, by ${by})`;
  if (at) return ` (${at})`;
  if (by) return ` (by ${by})`;
  return "";
}

function publishedLine(version: number | null): string {
  return version === null
    ? "Runs keep using the last published version."
    : `Runs keep using published version ${version}.`;
}

/** The check and comment text for a state. */
export function renderHealthReport(state: HealthState): HealthReport {
  if (state.health === "healthy") {
    return {
      title: "Repository settings match",
      summary: HEALTHY_AGAIN,
      comment: `${HEALTH_COMMENT_MARKER}\n**${REQUIRED_CHECK_NAME}**\n\n${HEALTHY_AGAIN}\n`,
      digest: healthDigest(state),
    };
  }
  const title = HEALTH_TITLES[state.health];
  const lines: string[] = [];
  if (state.health === "drifted") {
    lines.push(
      "Repository settings changed. Oxagen will not merge or publish until they match.",
      "",
      ...state.differences.map((d) => `✗ ${describeDifference(d)}${attribution(d)}`),
      "",
      publishedLine(state.published_version),
      `${REPAIR_SETTINGS} Or set each setting back by hand.`,
    );
  } else if (state.health === "disconnected") {
    lines.push(
      "Oxagen lost access to the repository. Oxagen will not merge or publish until an organization admin reconnects it.",
      "",
      `✗ ${state.reason ?? "The repository no longer answers the Oxagen GitHub App."}`,
      "",
      publishedLine(state.published_version),
      "Repair: an organization admin connects the repository to the Oxagen GitHub App again.",
    );
  } else {
    lines.push(
      "main holds a commit Oxagen did not merge. Oxagen will not merge or publish until main matches the published version.",
      "",
      `✗ ${state.reason ?? "main no longer matches the published version."}`,
      ...state.differences.map((d) => `✗ ${describeDifference(d)}${attribution(d)}`),
      "",
      publishedLine(state.published_version),
      state.revert_pr_number === null
        ? "Oxagen could not open the pull request that reverts main. The next check tries again."
        : `Repair: an admin selects Repair settings on the steering repo banner in Oxagen, which merges #${state.revert_pr_number} and puts main back at the published version.`,
    );
  }
  const summary = lines.join("\n");
  return {
    title,
    summary,
    comment: `${HEALTH_COMMENT_MARKER}\n**${REQUIRED_CHECK_NAME}** failed: ${title}\n\n${summary}\n`,
    digest: healthDigest(state),
  };
}

/** The comment a pull request keeps once the repo is healthy again. */
export const RECOVERY_COMMENT = `${HEALTH_COMMENT_MARKER}\n**${REQUIRED_CHECK_NAME}**\n\n${HEALTHY_AGAIN}\n`;

/**
 * The posted digest while a report reached only some of the pull requests it
 * was for. No report hashes to it, so the next unhealthy read posts on every
 * open pull request again. It is not null, so a recovery still puts back the
 * checks that did go out.
 */
const INCOMPLETE_DIGEST = "incomplete";

/** Changes whenever the report would change. */
export function healthDigest(state: HealthState): string {
  return createHash("sha256")
    .update(
      canonical({
        health: state.health,
        reason: state.reason,
        revert: state.revert_pr_number,
        version: state.published_version,
        differences: state.differences.map((d) => ({
          setting: d.setting,
          expected: d.expected,
          actual: d.actual,
          by: d.changed_by,
          at: d.changed_at,
        })),
      }),
    )
    .digest("hex");
}

// ── Hosts ────────────────────────────────────────────────────────────────────

/** One open pull request or merge request. */
export interface OpenPullRequest {
  /** The GitHub number or the GitLab iid. */
  number: number;
  head_sha: string;
  head_ref: string;
}

/** What a settings read found. */
export type Observation =
  | {
      kind: "connected";
      /** `owner/name` or the GitLab path, as the host reports it now. */
      repository: string;
      differences: RawDifference[];
    }
  | { kind: "disconnected"; reason: string };

/** The last commit Oxagen published, and its version when the host records it. */
export interface PublishedCommit {
  sha: string;
  version: number | null;
}

/** main holds commits Oxagen did not merge. */
export interface Divergence {
  /** One sentence, such as `main holds 2 commits Oxagen did not merge, starting with 1a2b3c4`. */
  reason: string;
  /** Where main points now. */
  main_sha: string;
}

/**
 * The calls a health read makes on one steering repo. ./health.hosts.ts binds
 * them to GitHub and GitLab.
 */
export interface HealthHost {
  /** Read the settings, or say why Oxagen can no longer read them. */
  observe(): Promise<Observation>;
  /** The last commit Oxagen published on main, or null when none is recorded. */
  published(): Promise<PublishedCommit | null>;
  /** Whether main holds commits Oxagen did not merge since `published`. */
  diverged(published: PublishedCommit): Promise<Divergence | null>;
  /**
   * Open, or find, the pull request that puts main back at `published`, and
   * close `previous` when it is a different one. Returns its number.
   */
  openRevert(
    published: PublishedCommit,
    divergence: Divergence,
    previous: number | null,
  ): Promise<number>;
  /** Close a revert pull request main no longer needs. */
  closeRevert(number: number): Promise<void>;
  /** Is this pull request the one that reverts main? */
  isRevert(pr: OpenPullRequest): boolean;
  openPullRequests(): Promise<OpenPullRequest[]>;
  /** Post the `Oxagen steering` check as failed on the pull request's head. */
  failCheck(pr: OpenPullRequest, report: HealthReport): Promise<void>;
  /** Put back the last `Oxagen steering` result the checks posted on the head. */
  restoreCheck(pr: OpenPullRequest): Promise<void>;
  /**
   * Edit the pull request's health comment, or post it. With `onlyIfExists`,
   * a pull request without one gets none.
   */
  upsertComment(
    pr: OpenPullRequest,
    body: string,
    onlyIfExists: boolean,
  ): Promise<void>;
}

// ── Storage ──────────────────────────────────────────────────────────────────

/** A health row as the run reads and writes it. */
export interface HealthRow {
  provider: "github" | "gitlab";
  repositoryId: number;
  repository: string;
  health: RepoHealth;
  differences: SettingsDifference[];
  reason: string | null;
  publishedSha: string | null;
  publishedVersion: number | null;
  revertPrNumber: number | null;
  notifiedHealth: RepoHealth;
  postedDigest: string | null;
  checkedAt: Date;
  changedAt: Date;
}

const table = schema.steeringRepoHealth;

function scopeWhere(scope: HealthScope) {
  return and(
    eq(table.orgId, scope.orgId),
    scope.workspaceId === null
      ? isNull(table.workspaceId)
      : eq(table.workspaceId, scope.workspaceId),
  );
}

/** The table's check constraint admits only the four states. */
function asHealth(value: string): RepoHealth {
  const parsed = repoHealthSchema.safeParse(value);
  if (!parsed.success) throw new Error(`steering_repo_health holds an unknown health: ${value}`);
  return parsed.data;
}

function storedDifferences(stored: unknown): SettingsDifference[] {
  if (!Array.isArray(stored)) return [];
  return stored.filter(
    (d): d is SettingsDifference =>
      d !== null &&
      typeof d === "object" &&
      typeof (d as { setting?: unknown }).setting === "string",
  );
}

async function loadRow(scope: HealthScope): Promise<HealthRow | null> {
  // tenancy: filtered by orgId and workspaceId. Health reads run from the
  // webhook route, the sweep, and the merge and publish guards, which hold
  // the scope's ids but not always a tenant transaction.
  const rows = await withSystemDb((tx) =>
    tx.select().from(table).where(scopeWhere(scope)).limit(1),
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    provider: row.provider === "gitlab" ? "gitlab" : "github",
    repositoryId: row.repositoryId,
    repository: row.repository,
    health: asHealth(row.health),
    differences: storedDifferences(row.differences),
    reason: row.reason,
    publishedSha: row.publishedSha,
    publishedVersion: row.publishedVersion,
    revertPrNumber: row.revertPrNumber,
    notifiedHealth: asHealth(row.notifiedHealth),
    postedDigest: row.postedDigest,
    checkedAt: row.checkedAt,
    changedAt: row.changedAt,
  };
}

async function saveRow(scope: HealthScope, row: HealthRow): Promise<void> {
  const values = {
    orgId: scope.orgId,
    workspaceId: scope.workspaceId,
    provider: row.provider,
    repositoryId: row.repositoryId,
    repository: row.repository,
    health: row.health,
    differences: row.differences,
    reason: row.reason,
    publishedSha: row.publishedSha,
    publishedVersion: row.publishedVersion,
    revertPrNumber: row.revertPrNumber,
    notifiedHealth: row.notifiedHealth,
    postedDigest: row.postedDigest,
    checkedAt: row.checkedAt,
    changedAt: row.changedAt,
    updatedAt: row.checkedAt,
  };
  const { orgId: _org, workspaceId: _ws, ...set } = values;
  // tenancy: scoped to one row. The insert and its conflict target both use
  // the orgId and workspaceId the caller resolved from the steering repo's
  // own settings, so the upsert writes only that scope's row.
  await withSystemDb((tx) =>
    tx
      .insert(table)
      .values(values)
      .onConflictDoUpdate(
        scope.workspaceId === null
          ? { target: [table.orgId], targetWhere: isNull(table.workspaceId), set }
          : {
              target: [table.orgId, table.workspaceId],
              targetWhere: isNotNull(table.workspaceId),
              set,
            },
      ),
  );
}

/**
 * The steering repo's health as the last read stored it. A repo no read has
 * reached yet, and a scope with no steering repo, read `healthy`: the merge
 * and publish guards refuse on a stored problem, not on a missing row.
 */
export async function readRepoHealth(scope: HealthScope): Promise<RepoHealth> {
  const row = await loadRow(scope);
  return row?.health ?? "healthy";
}

/** What the steering repo page and the banner show. */
export interface RepoHealthDetail {
  health: RepoHealth;
  differences: SettingsDifference[];
  reason: string | null;
  repository: string;
  revertPrNumber: number | null;
  checkedAt: string;
  changedAt: string;
}

/** The last health read in full, or null before the first. */
export async function readRepoHealthDetail(
  scope: HealthScope,
): Promise<RepoHealthDetail | null> {
  const row = await loadRow(scope);
  if (row === null) return null;
  return {
    health: row.health,
    differences: row.differences,
    reason: row.reason,
    repository: row.repository,
    revertPrNumber: row.revertPrNumber,
    checkedAt: row.checkedAt.toISOString(),
    changedAt: row.changedAt.toISOString(),
  };
}

// ── Scopes ───────────────────────────────────────────────────────────────────

/** What a webhook says about which steering repos an event touches. */
export interface HealthSignal {
  provider: "github" | "gitlab";
  /** GitHub repository ids or GitLab project ids the event names. */
  repository_ids: readonly number[];
  /**
   * The GitHub App installation the event came from, when the event touches
   * every repo in it (installation suspended or deleted). Null otherwise.
   */
  installation_id: number | null;
  trigger: HealthTrigger;
}

/** The steering repo setting's status, provider, and repository id, as SQL. */
function steeringRepoMatch(
  settings: typeof schema.workspaces.settings | typeof schema.organizations.settings,
  provider: "github" | "gitlab",
) {
  return and(
    sql`${settings}->'steering_repo'->>'status' = 'ready'`,
    sql`${settings}->'steering_repo'->>'provider' = ${provider}`,
  );
}

function repositoryIdOf(
  settings: typeof schema.workspaces.settings | typeof schema.organizations.settings,
) {
  return sql<number>`(${settings}->'steering_repo'->'repository'->>'id')::bigint`;
}

/**
 * The scopes whose steering repo a webhook event touches: every ready
 * steering repo with one of the event's repository ids, and, for an
 * installation event, every ready GitHub steering repo in an organization
 * whose steering connection is that installation.
 */
export async function findHealthScopes(
  signal: Pick<HealthSignal, "provider" | "repository_ids" | "installation_id">,
): Promise<HealthScope[]> {
  const ids = [...new Set(signal.repository_ids)];
  const w = schema.workspaces;
  const o = schema.organizations;
  // tenancy: cross-tenant lookup for a verified webhook. The GitHub route
  // checks the x-hub-signature-256 HMAC and the GitLab handler checks the
  // X-Gitlab-Token before this runs. A webhook names a repository or an
  // installation, not a tenant, so the query is filtered by those ids to the
  // organizations and workspaces whose own settings name that steering repo,
  // and it returns only their orgId and workspaceId.
  return withSystemDb(async (tx) => {
    const scopes: HealthScope[] = [];
    let orgIds: string[] = [];
    if (signal.installation_id !== null && signal.provider === "github") {
      const connected = await tx
        .select({ id: o.id })
        .from(o)
        .where(
          and(
            sql`${o.settings}->'steering_connection'->>'provider' = 'github'`,
            sql`${o.settings}->'steering_connection'->>'installation_id' = ${String(signal.installation_id)}`,
          ),
        );
      orgIds = connected.map((r) => r.id);
    }
    if (ids.length === 0 && orgIds.length === 0) return scopes;
    const byRepo = (settings: typeof w.settings | typeof o.settings) =>
      ids.length > 0 ? inArray(repositoryIdOf(settings), ids) : undefined;
    const workspaceRows = await tx
      .select({ id: w.id, orgId: w.orgId })
      .from(w)
      .where(
        and(
          isNull(w.archivedAt),
          steeringRepoMatch(w.settings, signal.provider),
          or(byRepo(w.settings), orgIds.length > 0 ? inArray(w.orgId, orgIds) : undefined),
        ),
      );
    for (const r of workspaceRows) scopes.push({ orgId: r.orgId, workspaceId: r.id });
    const orgRows = await tx
      .select({ id: o.id })
      .from(o)
      .where(
        and(
          steeringRepoMatch(o.settings, signal.provider),
          or(byRepo(o.settings), orgIds.length > 0 ? inArray(o.id, orgIds) : undefined),
        ),
      );
    for (const r of orgRows) scopes.push({ orgId: r.id, workspaceId: null });
    return scopes;
  });
}

/** Every scope with a ready steering repo, for the 10-minute sweep. */
export async function listHealthScopes(): Promise<HealthScope[]> {
  const w = schema.workspaces;
  const o = schema.organizations;
  // tenancy: global read for the scheduled 10-minute sweep. It lists every
  // ready steering repo across all organizations on purpose and returns only
  // orgId and workspaceId pairs. Each health read then runs scoped to one pair.
  return withSystemDb(async (tx) => {
    const workspaceRows = await tx
      .select({ id: w.id, orgId: w.orgId })
      .from(w)
      .where(
        and(
          isNull(w.archivedAt),
          sql`${w.settings}->'steering_repo'->>'status' = 'ready'`,
        ),
      );
    const orgRows = await tx
      .select({ id: o.id })
      .from(o)
      .where(sql`${o.settings}->'steering_repo'->>'status' = 'ready'`);
    return [
      ...orgRows.map((r) => ({ orgId: r.id, workspaceId: null })),
      ...workspaceRows.map((r) => ({ orgId: r.orgId, workspaceId: r.id })),
    ];
  });
}

/** One `steering-repo/health.requested` event per scope. */
export function healthRequests(
  scopes: readonly HealthScope[],
  trigger: HealthTrigger,
): { name: typeof HEALTH_REQUESTED_EVENT; data: HealthRequestedData }[] {
  return scopes.map((scope) => ({
    name: HEALTH_REQUESTED_EVENT,
    data: {
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      key: healthKey(scope),
      trigger,
    },
  }));
}

// ── The run ──────────────────────────────────────────────────────────────────

/** The steering repo a scope holds, as the run needs it. */
export interface HealthTarget {
  scope: HealthScope;
  provider: "github" | "gitlab";
  repository: { id: number; full_name: string };
  /** Where the notification links: the workspace's repositories page, or the organization. */
  deepLink: string;
}

/** What the run reads and writes outside the host. */
export interface HealthDeps {
  now(): Date;
  /** The scope's steering repo, or null when it has none that is ready. */
  loadTarget(scope: HealthScope): Promise<HealthTarget | null>;
  loadRow(scope: HealthScope): Promise<HealthRow | null>;
  saveRow(scope: HealthScope, row: HealthRow): Promise<void>;
  /** The host for the target, or null when this deployment cannot reach it. */
  host(target: HealthTarget): Promise<HealthHost | null>;
  /** Tell the workspace admins the repo changed state. */
  notify(target: HealthTarget, state: HealthState, report: HealthReport): Promise<void>;
}

/** What one run found and did. */
export interface HealthOutcome {
  health: RepoHealth;
  previous: RepoHealth | null;
  differences: SettingsDifference[];
  reason: string | null;
  /** Pull requests the run posted the failed check on. */
  posted: number;
  /** Pull requests whose check the run put back after a recovery. */
  restored: number;
  notified: boolean;
}

/** A rate limit is retried by the caller, never recorded as a state. */
export function isRateLimited(err: unknown): boolean {
  return (
    err instanceof GitHubRateLimitedError ||
    err instanceof gl.GitLabRateLimitedError
  );
}

/**
 * Read one steering repo's health, store it, and act on it: fail the check
 * and keep the comment on every open pull request while it is unhealthy, put
 * the checks back when it recovers, and notify the admins once per state.
 * Returns null when the scope has no ready steering repo, or when this
 * deployment cannot reach its host.
 */
export async function checkRepoHealth(
  deps: HealthDeps,
  scope: HealthScope,
  trigger: HealthTrigger,
): Promise<HealthOutcome | null> {
  const target = await deps.loadTarget(scope);
  if (target === null) return null;
  const host = await deps.host(target);
  if (host === null) return null;
  const previous = await deps.loadRow(scope);
  const now = deps.now();
  const log = { orgId: scope.orgId, workspaceId: scope.workspaceId };

  // 1. Settings and access.
  const observation = await host.observe();
  let differences: SettingsDifference[] = [];
  let reason: string | null = null;
  let repository = previous?.repository ?? target.repository.full_name;
  let history: History = {
    published: null,
    divergence: null,
    revertPrNumber: previous?.revertPrNumber ?? null,
  };
  if (observation.kind === "disconnected") {
    reason = observation.reason;
  } else {
    repository = observation.repository;
    differences = attribute(observation.differences, previous?.differences ?? [], trigger);
    // 2. History: main against the last published commit.
    history = await readHistory(host, previous, log, target.provider === "github");
    if (history.divergence !== null) reason = history.divergence.reason;
  }

  const health = decideHealth({
    disconnected: observation.kind === "disconnected",
    diverged: history.divergence !== null,
    differences: differences.length,
  });
  const publishedVersion =
    history.published !== null
      ? history.published.version
      : (previous?.publishedVersion ?? null);
  const state: HealthState = {
    provider: target.provider,
    health,
    differences,
    reason,
    published_version: publishedVersion,
    revert_pr_number: history.divergence !== null ? history.revertPrNumber : null,
  };

  // 3. Store the state first, so the merge and publish guards see it before
  //    any pull request does.
  const row: HealthRow = {
    provider: target.provider,
    repositoryId: target.repository.id,
    repository,
    health,
    differences,
    reason,
    publishedSha: history.published?.sha ?? previous?.publishedSha ?? null,
    publishedVersion,
    revertPrNumber: history.revertPrNumber,
    notifiedHealth: previous?.notifiedHealth ?? "healthy",
    postedDigest: previous?.postedDigest ?? null,
    checkedAt: now,
    changedAt: previous !== null && previous.health === health ? previous.changedAt : now,
  };
  await deps.saveRow(scope, row);

  // 4. Pull requests.
  const report = renderHealthReport(state);
  let posted = 0;
  let restored = 0;
  if (health !== "healthy") {
    const prs = await pullRequestsToPost(host, row, report, trigger, log);
    if (prs !== null) {
      let missed = 0;
      for (const pr of prs) {
        if (host.isRevert(pr) || pr.number === row.revertPrNumber) continue;
        if (await postOne(log, pr, () => postFailure(host, pr, report))) posted += 1;
        else missed += 1;
      }
      row.postedDigest = missed === 0 ? report.digest : INCOMPLETE_DIGEST;
    }
  } else if (previous !== null && previous.postedDigest !== null) {
    const prs = await listOpen(host, log);
    if (prs !== null) {
      let missed = 0;
      for (const pr of prs) {
        if (await postOne(log, pr, () => postRecovery(host, pr))) restored += 1;
        else missed += 1;
      }
      // A pull request the recovery missed still carries the failed check.
      // Keep the digest set so the next healthy read restores it.
      if (missed === 0) row.postedDigest = null;
    }
  }

  // 5. Admins, once per state.
  let notified = false;
  if (health !== row.notifiedHealth) {
    try {
      await deps.notify(target, state, report);
      row.notifiedHealth = health;
      notified = true;
    } catch (err) {
      logger.error(
        { err, ...log, health },
        "steering-repo.health: could not notify the workspace admins; the next read tries again",
      );
    }
  }
  await deps.saveRow(scope, row);

  if (health !== (previous?.health ?? "healthy"))
    logger.info(
      {
        ...log,
        repository,
        from: previous?.health ?? null,
        to: health,
        differences: differences.map((d) => d.setting),
        trigger: trigger.reason,
      },
      "steering-repo.health: the steering repo changed state",
    );

  return {
    health,
    previous: previous?.health ?? null,
    differences,
    reason,
    posted,
    restored,
    notified,
  };
}

type LogScope = { orgId: string; workspaceId: string | null };

interface History {
  published: PublishedCommit | null;
  divergence: Divergence | null;
  /** The open pull request that reverts main, if any. */
  revertPrNumber: number | null;
}

/**
 * Compare main with the last published commit, and keep a revert pull request
 * open while main has diverged. GitHub history must be readable and have an
 * authenticated publication anchor before the repository reads healthy.
 */
async function readHistory(
  host: HealthHost,
  previous: HealthRow | null,
  log: LogScope,
  requireProvenance: boolean,
): Promise<History> {
  const priorRevert = previous?.revertPrNumber ?? null;
  let published: PublishedCommit | null;
  let divergence: Divergence | null;
  try {
    published = await host.published();
    if (published === null && requireProvenance) {
      return {
        published: null,
        divergence: {
          reason: "Oxagen could not find an authenticated published commit for this steering repository.",
          main_sha: "",
        },
        revertPrNumber: priorRevert,
      };
    }
    divergence = published === null ? null : await host.diverged(published);
  } catch (err) {
    if (isRateLimited(err)) throw err;
    logger.error(
      { err, ...log },
      "steering-repo.health: could not compare main with the published commit",
    );
    return {
      published: null,
      divergence:
        previous !== null && previous.health === "diverged"
          ? { reason: previous.reason ?? HEALTH_TITLES.diverged, main_sha: "" }
          : requireProvenance
            ? {
                reason: "Oxagen could not verify this steering repository's commit history. Retry the health check.",
                main_sha: "",
              }
            : null,
      revertPrNumber: priorRevert,
    };
  }

  if (divergence === null || published === null) {
    // main is back at a published commit. Close a revert nobody needs now.
    if (priorRevert !== null) {
      try {
        await host.closeRevert(priorRevert);
      } catch (err) {
        if (isRateLimited(err)) throw err;
        logger.warn(
          { err, ...log, pr: priorRevert },
          "steering-repo.health: could not close the pull request that reverted main",
        );
      }
    }
    return { published, divergence: null, revertPrNumber: null };
  }

  try {
    const revertPrNumber = await host.openRevert(published, divergence, priorRevert);
    return { published, divergence, revertPrNumber };
  } catch (err) {
    if (isRateLimited(err)) throw err;
    logger.error(
      { err, ...log },
      "steering-repo.health: could not open the pull request that reverts main",
    );
    return { published, divergence, revertPrNumber: null };
  }
}

/** The open pull requests, or null when the host would not list them. */
async function listOpen(
  host: HealthHost,
  log: LogScope,
): Promise<OpenPullRequest[] | null> {
  try {
    return await host.openPullRequests();
  } catch (err) {
    if (isRateLimited(err)) throw err;
    logger.warn(
      { err, ...log },
      "steering-repo.health: could not list the open pull requests",
    );
    return null;
  }
}

/**
 * Read one scope's steering repo now, with the production hosts, and act on
 * what the read finds. The webhook routes and the sweep reach this through
 * the `steering-repo/health.requested` event. Returns null when the scope has
 * no ready steering repo.
 */
export async function refreshRepoHealth(
  scope: HealthScope,
  trigger: HealthTrigger = SWEEP_TRIGGER,
): Promise<HealthOutcome | null> {
  const { productionHealthDeps } = await import("./health.hosts");
  return checkRepoHealth(productionHealthDeps(), scope, trigger);
}

/**
 * Which pull requests get the failed check. A new report goes on every open
 * pull request. An unchanged one goes only on the pull request that just
 * opened or changed, because its new head has no health check yet. Null when
 * the host would not list them.
 */
async function pullRequestsToPost(
  host: HealthHost,
  row: HealthRow,
  report: HealthReport,
  trigger: HealthTrigger,
  log: LogScope,
): Promise<OpenPullRequest[] | null> {
  const changed = report.digest !== row.postedDigest;
  if (!changed && trigger.pull_request === null) return [];
  const all = await listOpen(host, log);
  if (all === null || changed) return all;
  return all.filter((pr) => pr.number === trigger.pull_request?.number);
}

async function postFailure(
  host: HealthHost,
  pr: OpenPullRequest,
  report: HealthReport,
): Promise<void> {
  await host.failCheck(pr, report);
  await host.upsertComment(pr, report.comment, false);
}

async function postRecovery(host: HealthHost, pr: OpenPullRequest): Promise<void> {
  await host.restoreCheck(pr);
  await host.upsertComment(pr, RECOVERY_COMMENT, true);
}

/**
 * Post on one pull request. A rate limit stops the run so it is retried. Any
 * other failure is logged and the run moves on: a disconnected repo refuses
 * every post, and one closed pull request must not stop the rest. The caller
 * counts each false return, so a pull request the run missed gets the post
 * again on the next read.
 */
async function postOne(
  log: LogScope,
  pr: OpenPullRequest,
  post: () => Promise<void>,
): Promise<boolean> {
  try {
    await post();
    return true;
  } catch (err) {
    if (isRateLimited(err)) throw err;
    logger.warn(
      { err, ...log, pr: pr.number },
      "steering-repo.health: could not post the health check on a pull request; the next read tries again",
    );
    return false;
  }
}

// ── Production storage ───────────────────────────────────────────────────────

/** The row reads and writes `checkRepoHealth` uses in production. */
export const productionHealthStorage = { loadRow, saveRow };
