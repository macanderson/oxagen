// settings.ts: read a steering repo's settings, compare them with the
// baseline, and write only what differs.
//
// Oxagen holds the settings in settings-baseline.ts (@oxagen/oxagen). The
// baseline names the Oxagen GitHub App by a symbol. This module turns the
// symbol into the app's id where GitHub wants an id, and back into the symbol
// when it reads, so a read compares with the baseline directly.
import { seg, type GithubRest } from "./http";
import type {
  ObservedGithubSettings,
  ObservedRuleset,
  RepoAddress,
  SettingDifference,
  SteeringApp,
  SteeringGithubSettings,
  SteeringRuleset,
} from "./types";

function base(repo: RepoAddress): string {
  return `/repos/${seg(repo.owner)}/${seg(repo.name)}`;
}

/** A ruleset's key in the baseline: its name in snake_case. */
export function rulesetKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// ── Read ─────────────────────────────────────────────────────────────────────

interface GhRepo {
  visibility?: string;
  private?: boolean;
  default_branch: string;
  allow_squash_merge?: boolean;
  allow_merge_commit?: boolean;
  allow_rebase_merge?: boolean;
  delete_branch_on_merge?: boolean;
}

interface GhRulesetSummary {
  id: number;
  name: string;
  source_type?: string;
}

interface GhRuleset {
  id: number;
  name: string;
  target?: string;
  enforcement?: string;
  bypass_actors?: {
    actor_id: number | null;
    actor_type: string;
    bypass_mode: string;
  }[];
  conditions?: { ref_name?: { include?: string[]; exclude?: string[] } } | null;
  rules?: { type: string; parameters?: Record<string, unknown> }[];
}

interface GhEnvironment {
  deployment_branch_policy: {
    protected_branches: boolean;
    custom_branch_policies: boolean;
  } | null;
}

interface GhBranchPolicy {
  id: number;
  name: string;
  type?: string;
}

interface GhDeployment {
  creator?: { login: string } | null;
  performed_via_github_app?: { slug: string } | null;
}

function actorSymbol(
  app: SteeringApp,
  actor: { actor_id: number | null; actor_type: string },
): string {
  if (actor.actor_type === "Integration" && actor.actor_id === app.id)
    return app.symbol;
  return `${actor.actor_type}:${actor.actor_id ?? "none"}`;
}

function integrationSymbol(app: SteeringApp, id: unknown): string {
  if (id === app.id) return app.symbol;
  return id === undefined || id === null ? "any" : `app:${String(id)}`;
}

function mapRuleset(app: SteeringApp, r: GhRuleset): ObservedRuleset {
  return {
    id: r.id,
    name: r.name,
    target: r.target ?? "branch",
    enforcement: r.enforcement ?? "disabled",
    include: [...(r.conditions?.ref_name?.include ?? [])],
    bypass_actors: (r.bypass_actors ?? []).map((a) => ({
      actor: actorSymbol(app, a),
      bypass_mode: a.bypass_mode,
    })),
    rules: (r.rules ?? []).map((rule) => {
      if (rule.type !== "required_status_checks" || !rule.parameters)
        return rule;
      const checks = rule.parameters.required_status_checks;
      return {
        type: rule.type,
        parameters: {
          ...rule.parameters,
          required_status_checks: Array.isArray(checks)
            ? checks.map((c: { context?: unknown; integration_id?: unknown }) => ({
                context: c.context,
                integration: integrationSymbol(app, c.integration_id),
              }))
            : checks,
        },
      };
    }),
  };
}

async function readRulesets(
  rest: GithubRest,
  repo: RepoAddress,
  app: SteeringApp,
): Promise<Record<string, ObservedRuleset>> {
  const root = base(repo);
  const list = await rest.request<GhRulesetSummary[]>(
    "GET",
    `${root}/rulesets?includes_parents=false&per_page=100`,
  );
  const out: Record<string, ObservedRuleset> = {};
  for (const summary of list.data ?? []) {
    const full = await rest.request<GhRuleset>(
      "GET",
      `${root}/rulesets/${seg(summary.id)}`,
      undefined,
      [404],
    );
    if (full.data === null) continue;
    out[rulesetKey(full.data.name)] = mapRuleset(app, full.data);
  }
  return out;
}

async function readEnvironment(
  rest: GithubRest,
  repo: RepoAddress,
  app: SteeringApp,
  name: string,
): Promise<ObservedGithubSettings["environments"][string] | null> {
  const root = base(repo);
  const env = await rest.request<GhEnvironment>(
    "GET",
    `${root}/environments/${seg(name)}`,
    undefined,
    [404],
  );
  if (env.data === null) return null;
  const policy = env.data.deployment_branch_policy;
  let branches: string[];
  if (policy === null) branches = ["*"];
  else if (policy.protected_branches) branches = ["<protected branches>"];
  else {
    const policies = await rest.request<{ branch_policies: GhBranchPolicy[] }>(
      "GET",
      `${root}/environments/${seg(name)}/deployment-branch-policies?per_page=100`,
    );
    branches = (policies.data?.branch_policies ?? []).map((p) => p.name);
  }
  const deployments = await rest.request<GhDeployment[]>(
    "GET",
    `${root}/deployments?environment=${seg(name)}&per_page=1`,
  );
  const latest = deployments.data?.[0];
  let deployedBy: string | null = null;
  if (latest !== undefined) {
    const slug = latest.performed_via_github_app?.slug ?? null;
    deployedBy =
      slug === app.slug
        ? app.symbol
        : (slug ?? latest.creator?.login ?? "unknown");
  }
  return { deployment_branches: branches, deployed_by: deployedBy };
}

/** Read every setting the baseline names. */
export async function readSettings(
  rest: GithubRest,
  repo: RepoAddress,
  app: SteeringApp,
  environments: readonly string[],
): Promise<ObservedGithubSettings> {
  const root = base(repo);
  const r = await rest.request<GhRepo>("GET", root);
  if (r.data === null) throw new Error("GitHub returned no repository");
  const actions = await rest.request<{ enabled: boolean }>(
    "GET",
    `${root}/actions/permissions`,
  );
  const observedEnvironments: ObservedGithubSettings["environments"] = {};
  for (const name of environments) {
    const env = await readEnvironment(rest, repo, app, name);
    if (env !== null) observedEnvironments[name] = env;
  }
  return {
    visibility: r.data.visibility ?? (r.data.private ? "private" : "public"),
    default_branch: r.data.default_branch,
    rulesets: await readRulesets(rest, repo, app),
    merge: {
      allow_squash_merge: r.data.allow_squash_merge ?? true,
      allow_merge_commit: r.data.allow_merge_commit ?? true,
      allow_rebase_merge: r.data.allow_rebase_merge ?? true,
      delete_branch_on_merge: r.data.delete_branch_on_merge ?? false,
    },
    actions: { enabled: actions.data?.enabled ?? true },
    environments: observedEnvironments,
  };
}

// ── Compare ──────────────────────────────────────────────────────────────────

/** A stable JSON form with object keys sorted, for equality checks. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameSet(a: readonly unknown[], b: readonly unknown[]): boolean {
  const left = a.map(canonical).sort();
  const right = b.map(canonical).sort();
  return canonical(left) === canonical(right);
}

function sameValue(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected) && Array.isArray(actual))
    return sameSet(expected, actual);
  return canonical(expected) === canonical(actual);
}

function compareRuleset(
  key: string,
  expected: SteeringRuleset,
  actual: ObservedRuleset,
  out: SettingDifference[],
): void {
  const at = (field: string): string => `rulesets.${key}.${field}`;
  if (expected.target !== actual.target)
    out.push({ setting: at("target"), expected: expected.target, actual: actual.target });
  if (expected.enforcement !== actual.enforcement)
    out.push({
      setting: at("enforcement"),
      expected: expected.enforcement,
      actual: actual.enforcement,
    });
  if (!sameSet(expected.include, actual.include))
    out.push({ setting: at("include"), expected: expected.include, actual: actual.include });
  if (!sameSet(expected.bypass_actors, actual.bypass_actors))
    out.push({
      setting: at("bypass_actors"),
      expected: expected.bypass_actors,
      actual: actual.bypass_actors,
    });
  const expectedTypes = new Set(expected.rules.map((r) => r.type));
  for (const rule of expected.rules) {
    const found = actual.rules.find((r) => r.type === rule.type);
    if (found === undefined) {
      out.push({ setting: at(`rules.${rule.type}`), expected: "present", actual: "missing" });
      continue;
    }
    if (!("parameters" in rule)) continue;
    const params = rule.parameters as Record<string, unknown>;
    for (const [name, value] of Object.entries(params)) {
      const actualValue = found.parameters?.[name];
      if (!sameValue(value, actualValue))
        out.push({
          setting: at(`rules.${rule.type}.${name}`),
          expected: value,
          actual: actualValue ?? null,
        });
    }
  }
  for (const rule of actual.rules)
    if (!expectedTypes.has(rule.type as SteeringRuleset["rules"][number]["type"]))
      out.push({ setting: at(`rules.${rule.type}`), expected: "absent", actual: "present" });
}

export interface CompareOptions {
  /**
   * Compare `deployed_by` even before the first deployment. Provisioning sets
   * this false while it applies settings, because version 1 is not published
   * until the next step.
   */
  require_deployment?: boolean;
}

/**
 * Every baseline setting the repository does not hold. Rulesets the baseline
 * does not name are left alone, and so are the collaborators, topics, and
 * webhooks a customer adds.
 */
export function compareSettings(
  expected: SteeringGithubSettings,
  actual: ObservedGithubSettings,
  options: CompareOptions = {},
): SettingDifference[] {
  const out: SettingDifference[] = [];
  if (expected.visibility !== actual.visibility)
    out.push({ setting: "visibility", expected: expected.visibility, actual: actual.visibility });
  if (expected.default_branch !== actual.default_branch)
    out.push({
      setting: "default_branch",
      expected: expected.default_branch,
      actual: actual.default_branch,
    });
  for (const [name, value] of Object.entries(expected.merge)) {
    const actualValue = actual.merge[name as keyof typeof actual.merge];
    if (value !== actualValue)
      out.push({ setting: `merge.${name}`, expected: value, actual: actualValue });
  }
  if (expected.actions.enabled !== actual.actions.enabled)
    out.push({
      setting: "actions.enabled",
      expected: expected.actions.enabled,
      actual: actual.actions.enabled,
    });
  for (const [key, ruleset] of Object.entries(expected.rulesets)) {
    const found = actual.rulesets[key];
    if (found === undefined) {
      out.push({ setting: `rulesets.${key}`, expected: ruleset.name, actual: "missing" });
      continue;
    }
    compareRuleset(key, ruleset, found, out);
  }
  for (const [name, env] of Object.entries(expected.environments)) {
    const found = actual.environments[name];
    if (found === undefined) {
      out.push({ setting: `environments.${name}`, expected: "present", actual: "missing" });
      continue;
    }
    if (!sameSet(env.deployment_branches, found.deployment_branches))
      out.push({
        setting: `environments.${name}.deployment_branches`,
        expected: env.deployment_branches,
        actual: found.deployment_branches,
      });
    if (found.deployed_by === null && options.require_deployment !== true) continue;
    if (env.deployed_by !== found.deployed_by)
      out.push({
        setting: `environments.${name}.deployed_by`,
        expected: env.deployed_by,
        actual: found.deployed_by,
      });
  }
  return out;
}

// ── Apply ────────────────────────────────────────────────────────────────────

function resolveActor(app: SteeringApp, symbol: string): number {
  if (symbol !== app.symbol)
    throw new Error(`The baseline names ${symbol}, which provisioning cannot resolve to a GitHub App.`);
  return app.id;
}

/** The REST body for one baseline ruleset. */
export function rulesetBody(app: SteeringApp, ruleset: SteeringRuleset): unknown {
  return {
    name: ruleset.name,
    target: ruleset.target,
    enforcement: ruleset.enforcement,
    bypass_actors: ruleset.bypass_actors.map((a) => ({
      actor_id: resolveActor(app, a.actor),
      actor_type: "Integration",
      bypass_mode: a.bypass_mode,
    })),
    conditions: { ref_name: { include: [...ruleset.include], exclude: [] } },
    rules: ruleset.rules.map((rule) => {
      if (rule.type !== "required_status_checks") return rule;
      return {
        type: rule.type,
        parameters: {
          ...rule.parameters,
          required_status_checks: rule.parameters.required_status_checks.map(
            (c) => ({ context: c.context, integration_id: resolveActor(app, c.integration) }),
          ),
        },
      };
    }),
  };
}

function touches(differences: readonly SettingDifference[], prefix: string): boolean {
  return differences.some(
    (d) => d.setting === prefix || d.setting.startsWith(`${prefix}.`),
  );
}

async function applyEnvironment(
  rest: GithubRest,
  repo: RepoAddress,
  name: string,
  branches: readonly string[],
): Promise<void> {
  const root = `${base(repo)}/environments/${seg(name)}`;
  await rest.request("PUT", root, {
    deployment_branch_policy: {
      protected_branches: false,
      custom_branch_policies: true,
    },
  });
  const list = await rest.request<{ branch_policies: GhBranchPolicy[] }>(
    "GET",
    `${root}/deployment-branch-policies?per_page=100`,
  );
  const existing = list.data?.branch_policies ?? [];
  for (const branch of branches)
    if (!existing.some((p) => p.name === branch))
      await rest.request("POST", `${root}/deployment-branch-policies`, {
        name: branch,
        type: "branch",
      });
  for (const policy of existing)
    if (!branches.includes(policy.name))
      await rest.request(
        "DELETE",
        `${root}/deployment-branch-policies/${seg(policy.id)}`,
        undefined,
        [404],
      );
}

export interface ApplySettingsResult {
  /** The settings that differed before this run wrote anything. */
  changed: SettingDifference[];
  /** What still differs after the write. Empty on success. */
  remaining: SettingDifference[];
  observed: ObservedGithubSettings;
}

/**
 * Bring a repository to the baseline. It reads first and writes only the
 * sections that differ, then reads again and compares, so a rerun on a
 * repository that already matches writes nothing.
 */
export async function applySettings(
  rest: GithubRest,
  repo: RepoAddress,
  app: SteeringApp,
  baseline: SteeringGithubSettings,
): Promise<ApplySettingsResult> {
  const environments = Object.keys(baseline.environments);
  const before = await readSettings(rest, repo, app, environments);
  const changed = compareSettings(baseline, before);
  const root = base(repo);

  if (
    touches(changed, "visibility") ||
    touches(changed, "default_branch") ||
    touches(changed, "merge")
  )
    await rest.request("PATCH", root, {
      visibility: baseline.visibility,
      default_branch: baseline.default_branch,
      ...baseline.merge,
    });

  if (touches(changed, "actions"))
    await rest.request("PUT", `${root}/actions/permissions`, {
      enabled: baseline.actions.enabled,
    });

  for (const [key, ruleset] of Object.entries(baseline.rulesets)) {
    if (!touches(changed, `rulesets.${key}`)) continue;
    const existing = before.rulesets[key];
    const body = rulesetBody(app, ruleset);
    if (existing === undefined) await rest.request("POST", `${root}/rulesets`, body);
    else await rest.request("PUT", `${root}/rulesets/${seg(existing.id)}`, body);
  }

  for (const [name, env] of Object.entries(baseline.environments)) {
    const missing = before.environments[name] === undefined;
    if (missing || touches(changed, `environments.${name}.deployment_branches`))
      await applyEnvironment(rest, repo, name, env.deployment_branches);
  }

  if (changed.length === 0) return { changed, remaining: [], observed: before };
  const after = await readSettings(rest, repo, app, environments);
  return { changed, remaining: compareSettings(baseline, after), observed: after };
}
