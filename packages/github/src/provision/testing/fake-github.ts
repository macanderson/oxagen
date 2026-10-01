// fake-github.ts: an in-memory GitHub for the provisioning tests.
//
// It serves the REST calls that @oxagen/github/provision makes, through the
// same `HttpFetch` seam the real helper uses. Tests pass `fake.fetch` or take
// a ready client from `appRest()` and `userRest()`.
//
// Ids come from one counter and every sha is a hash of its content, so two
// runs that make the same calls end in equal snapshots. A snapshot leaves out
// ids, tokens, and the call log, so a run that failed partway and was run
// again can be compared with a clean run.
import { createHash } from "node:crypto";
import { createGithubRest, type GithubRest, type HttpFetch } from "../http";
import type { SteeringApp } from "../types";

export { EXAMPLE_GITHUB_BASELINE } from "./baseline";

export interface FakeGithubInstallation {
  id: number;
  account_login: string;
  account_type: string;
  repository_selection: "all" | "selected";
}

export interface FakeGithubOptions {
  org: string;
  app: SteeringApp;
  /** The branch a new repository starts on. Defaults to `main`. */
  org_default_branch?: string;
  /** The app's installation on the org. Defaults to 77. */
  installation_id?: number;
  /** Defaults to `selected`. */
  repository_selection?: "all" | "selected";
  /** Defaults to `app-token`. */
  app_token?: string;
  /** Defaults to `user-token`. */
  user_token?: string;
  /** What `GET /user/installations` lists. Defaults to the org installation. */
  user_installations?: FakeGithubInstallation[];
}

/** Answer the next matching request with an error instead of serving it. */
export interface FakeFailRule {
  /** Matches any method when left out. */
  method?: string;
  /** A string matches any path that contains it. The path keeps its query. */
  path: string | RegExp;
  status: number;
  message?: string;
  /** How many requests the rule fails. Defaults to 1. */
  times?: number;
}

type Json = Record<string, unknown>;
type Who = "app" | "user";

interface Reply {
  status: number;
  body?: unknown;
}

interface FakeCommit {
  sha: string;
  tree: string;
  message: string;
  parents: FakeCommit[];
  files: Record<string, string>;
}

interface FakeRuleset {
  id: number;
  name: string;
  /** The fields as the last create or update sent them. */
  fields: Json;
}

interface FakeBranchPolicy {
  id: number;
  name: string;
  type: string;
}

interface FakeEnvironment {
  id: number;
  name: string;
  policy: unknown;
  branch_policies: FakeBranchPolicy[];
}

interface FakeStatus {
  id: number;
  state: string;
  environment: string;
  description: string;
}

interface FakeDeployment {
  id: number;
  sha: string;
  ref: string;
  environment: string;
  payload: unknown;
  description: string;
  by: Who;
  statuses: FakeStatus[];
}

interface MergeSettings {
  allow_squash_merge: boolean;
  allow_merge_commit: boolean;
  allow_rebase_merge: boolean;
  delete_branch_on_merge: boolean;
}

const MERGE_KEYS = [
  "allow_squash_merge",
  "allow_merge_commit",
  "allow_rebase_merge",
  "delete_branch_on_merge",
] as const;

const RULESET_FIELDS = [
  "name",
  "target",
  "enforcement",
  "bypass_actors",
  "conditions",
  "rules",
] as const;

const STATUS_STATES = new Set([
  "error",
  "failure",
  "inactive",
  "in_progress",
  "queued",
  "pending",
  "success",
]);

/**
 * The login of the person who holds the user token: the creator a deployment
 * made with it names, and what `GET /user` answers. A fake whose `org` is this
 * login stands for that person's own account, where `POST /user/repos`
 * creates repositories.
 */
export const FAKE_USER_LOGIN = "fake-owner";
const USER_LOGIN = FAKE_USER_LOGIN;

interface FakeRepo {
  id: number;
  name: string;
  description: string;
  visibility: string;
  default_branch: string;
  branches: Map<string, FakeCommit>;
  commits: Map<string, FakeCommit>;
  trees: Map<string, Record<string, string>>;
  merge: MergeSettings;
  actions_enabled: boolean;
  rulesets: FakeRuleset[];
  environments: Map<string, FakeEnvironment>;
  deployments: FakeDeployment[];
}

type Params = Record<string, string>;

interface RequestContext {
  who: Who;
  params: Params;
  query: URLSearchParams;
  body: Json;
}

interface RepoContext extends RequestContext {
  repo: FakeRepo;
}

interface Route<C> {
  method: string;
  pattern: string;
  handle: (ctx: C) => Reply;
}

function sha1(...parts: string[]): string {
  return createHash("sha1").update(parts.join("\u0000")).digest("hex");
}

function asObject(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function param(params: Params, key: string): string {
  return params[key] ?? "";
}

function reply(status: number, body?: unknown): Reply {
  return { status, body };
}

function notFound(): Reply {
  return reply(404, { message: "Not Found" });
}

function invalid(message: string): Reply {
  return reply(422, { message: "Validation Failed", errors: [message] });
}

/**
 * Match a path against a pattern such as `git/refs/heads/*branch`. A `:name`
 * part takes one segment and a `*name` part takes the rest of the path.
 */
function matchPattern(pattern: string, segs: readonly string[]): Params | null {
  const parts = pattern.split("/").filter((p) => p.length > 0);
  const params: Params = {};
  for (const [i, part] of parts.entries()) {
    if (part.startsWith("*")) {
      if (segs.length <= i) return null;
      params[part.slice(1)] = segs.slice(i).join("/");
      return params;
    }
    const seg = segs[i];
    if (seg === undefined) return null;
    if (part.startsWith(":")) params[part.slice(1)] = seg;
    else if (part !== seg) return null;
  }
  return parts.length === segs.length ? params : null;
}

function descends(commit: FakeCommit, ancestor: string): boolean {
  return (
    commit.sha === ancestor || commit.parents.some((p) => descends(p, ancestor))
  );
}

export class FakeGithub {
  /** Every request in order. The path keeps its query string. */
  readonly calls: { method: string; path: string }[] = [];

  private readonly org: string;
  private readonly app: SteeringApp;
  private readonly orgDefaultBranch: string;
  private readonly installationId: number;
  private readonly selection: "all" | "selected";
  private readonly appToken: string;
  private readonly userToken: string;
  private readonly userInstallations: FakeGithubInstallation[];
  private readonly repos = new Map<string, FakeRepo>();
  private readonly selected = new Set<number>();
  private readonly failRules: (FakeFailRule & { left: number })[] = [];
  private userRevoked = false;
  private seq = 100;

  constructor(opts: FakeGithubOptions) {
    this.org = opts.org;
    this.app = opts.app;
    this.orgDefaultBranch = opts.org_default_branch ?? "main";
    this.installationId = opts.installation_id ?? 77;
    this.selection = opts.repository_selection ?? "selected";
    this.appToken = opts.app_token ?? "app-token";
    this.userToken = opts.user_token ?? "user-token";
    this.userInstallations = opts.user_installations ?? [
      {
        id: this.installationId,
        account_login: this.org,
        account_type: "Organization",
        repository_selection: this.selection,
      },
    ];
  }

  /** The `HttpFetch` a `createGithubRest` client sends through. */
  readonly fetch: HttpFetch = (url, init) => {
    const res = this.serve(url, init);
    const text = res.body === undefined ? "" : JSON.stringify(res.body);
    return Promise.resolve({ status: res.status, text: () => Promise.resolve(text) });
  };

  /** A client that sends `token` to this fake. */
  rest(token: string): GithubRest {
    return createGithubRest({ token, fetch: this.fetch });
  }

  /** A client with the installation token. */
  appRest(): GithubRest {
    return this.rest(this.appToken);
  }

  /** A client with the organization owner's user token. */
  userRest(): GithubRest {
    return this.rest(this.userToken);
  }

  failNext(rule: FakeFailRule): void {
    this.failRules.push({ ...rule, left: rule.times ?? 1 });
  }

  /** From now on the user token answers 401, as a revoked token does. */
  revokeUserToken(): void {
    this.userRevoked = true;
  }

  /** Add a repository that exists before the test runs. Returns its id. */
  seedRepository(input: {
    name: string;
    description?: string;
    default_branch?: string;
    in_installation?: boolean;
  }): number {
    if (this.findRepo(input.name) !== undefined)
      throw new Error(`fake github already has ${this.org}/${input.name}`);
    const repo = this.addRepo(
      input.name,
      input.description ?? "",
      input.default_branch ?? this.orgDefaultBranch,
    );
    if (input.in_installation === true) this.selected.add(repo.id);
    return repo.id;
  }

  /** Every request that was not a GET, in order. */
  writes(): { method: string; path: string }[] {
    return this.calls.filter((c) => c.method !== "GET");
  }

  /** The state of every repository, without ids, tokens, or the call log. */
  snapshot(): unknown {
    const repositories: Json = {};
    for (const repo of this.repos.values()) {
      const branches: Record<string, string> = {};
      const files: Record<string, Record<string, string>> = {};
      for (const [name, head] of repo.branches) {
        branches[name] = head.sha;
        files[name] = { ...head.files };
      }
      const environments: Json = {};
      for (const env of repo.environments.values())
        environments[env.name] = {
          deployment_branch_policy: env.policy,
          branch_policies: env.branch_policies
            .map((p) => `${p.type}:${p.name}`)
            .sort(),
        };
      repositories[repo.name] = {
        name: repo.name,
        description: repo.description,
        private: repo.visibility !== "public",
        visibility: repo.visibility,
        default_branch: repo.default_branch,
        branches,
        files,
        merge: { ...repo.merge },
        actions_enabled: repo.actions_enabled,
        rulesets: [...repo.rulesets]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((r) => JSON.parse(JSON.stringify(r.fields)) as unknown),
        environments,
        deployments: repo.deployments.map((d) => ({
          sha: d.sha,
          ref: d.ref,
          environment: d.environment,
          payload: d.payload,
          description: d.description,
          latest_status: d.statuses.at(-1)?.state ?? null,
        })),
        in_installation: this.selected.has(repo.id),
      };
    }
    return { org: this.org, repositories };
  }

  // Serving a request

  private serve(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Reply {
    const u = new URL(url);
    const method = init.method.toUpperCase();
    const path = `${u.pathname}${u.search}`;
    this.calls.push({ method, path });

    const failure = this.takeFailure(method, path);
    if (failure !== null) return failure;

    const who = this.whoIs(init.headers);
    if (who === null) return reply(401, { message: "Bad credentials" });

    let body: Json = {};
    if (init.body !== undefined) {
      try {
        body = asObject(JSON.parse(init.body) as unknown);
      } catch {
        return reply(400, { message: "Problems parsing JSON" });
      }
    }

    const segs = u.pathname
      .split("/")
      .filter((s) => s.length > 0)
      .map((s) => decodeURIComponent(s));
    const base = { who, query: u.searchParams, body };

    for (const route of this.topRoutes) {
      if (route.method !== method) continue;
      const params = matchPattern(route.pattern, segs);
      if (params !== null) return route.handle({ ...base, params });
    }

    const [top, owner, name, ...rest] = segs;
    if (top === "repos" && owner !== undefined && name !== undefined) {
      for (const route of this.repoRoutes) {
        if (route.method !== method) continue;
        const params = matchPattern(route.pattern, rest);
        if (params === null) continue;
        const repo = owner === this.org ? this.findRepo(name) : undefined;
        if (repo === undefined || !this.canSee(who, repo)) return notFound();
        return route.handle({ ...base, params, repo });
      }
    }

    return reply(404, {
      message: `fake github has no route for ${method} ${u.pathname}`,
    });
  }

  private takeFailure(method: string, path: string): Reply | null {
    const index = this.failRules.findIndex(
      (r) =>
        (r.method === undefined || r.method.toUpperCase() === method) &&
        (typeof r.path === "string" ? path.includes(r.path) : r.path.test(path)),
    );
    const rule = this.failRules[index];
    if (rule === undefined) return null;
    rule.left -= 1;
    if (rule.left <= 0) this.failRules.splice(index, 1);
    return reply(rule.status, { message: rule.message ?? "fake failure" });
  }

  private whoIs(headers: Record<string, string>): Who | null {
    const token = (headers.Authorization ?? "").replace(/^Bearer /, "");
    if (token === this.appToken) return "app";
    if (token === this.userToken && !this.userRevoked) return "user";
    return null;
  }

  private canSee(who: Who, repo: FakeRepo): boolean {
    return who === "user" || this.selection === "all" || this.selected.has(repo.id);
  }

  private findRepo(name: string): FakeRepo | undefined {
    return this.repos.get(name.toLowerCase());
  }

  private nextId(): number {
    this.seq += 1;
    return this.seq;
  }

  private addRepo(name: string, description: string, branch: string): FakeRepo {
    const readme = { "README.md": `# ${name}\n` };
    const tree = this.treeSha(readme);
    const init = this.makeCommit(tree, readme, [], "Initial commit");
    const repo: FakeRepo = {
      id: this.nextId(),
      name,
      description,
      visibility: "private",
      default_branch: branch,
      branches: new Map([[branch, init]]),
      commits: new Map([[init.sha, init]]),
      trees: new Map([[tree, readme]]),
      merge: {
        allow_squash_merge: true,
        allow_merge_commit: true,
        allow_rebase_merge: true,
        delete_branch_on_merge: false,
      },
      actions_enabled: true,
      rulesets: [],
      environments: new Map(),
      deployments: [],
    };
    this.repos.set(name.toLowerCase(), repo);
    return repo;
  }

  private treeSha(files: Record<string, string>): string {
    const entries = Object.entries(files)
      .sort(([a], [b]) => a.localeCompare(b))
      .flat();
    return sha1("tree", ...entries);
  }

  private makeCommit(
    tree: string,
    files: Record<string, string>,
    parents: FakeCommit[],
    message: string,
  ): FakeCommit {
    return {
      sha: sha1("commit", tree, ...parents.map((p) => p.sha), message),
      tree,
      message,
      parents,
      files: { ...files },
    };
  }

  private repoJson(repo: FakeRepo): Json {
    return {
      id: repo.id,
      name: repo.name,
      full_name: `${this.org}/${repo.name}`,
      owner: { login: this.org, type: "Organization" },
      private: repo.visibility !== "public",
      visibility: repo.visibility,
      description: repo.description === "" ? null : repo.description,
      default_branch: repo.default_branch,
      ...repo.merge,
    };
  }

  private refJson(branch: string, commit: FakeCommit): Json {
    return {
      ref: `refs/heads/${branch}`,
      object: { sha: commit.sha, type: "commit" },
    };
  }

  private commitJson(commit: FakeCommit): Json {
    return {
      sha: commit.sha,
      message: commit.message,
      tree: { sha: commit.tree },
      parents: commit.parents.map((p) => ({ sha: p.sha })),
    };
  }

  private rulesetJson(repo: FakeRepo, r: FakeRuleset): Json {
    return {
      ...r.fields,
      id: r.id,
      name: r.name,
      source_type: "Repository",
      source: `${this.org}/${repo.name}`,
    };
  }

  private environmentJson(env: FakeEnvironment): Json {
    return {
      id: env.id,
      name: env.name,
      deployment_branch_policy: env.policy,
      protection_rules: [],
    };
  }

  private deploymentJson(d: FakeDeployment): Json {
    const byApp = d.by === "app";
    return {
      id: d.id,
      sha: d.sha,
      ref: d.ref,
      environment: d.environment,
      payload: d.payload,
      description: d.description,
      creator: byApp
        ? { login: `${this.app.slug}[bot]`, type: "Bot" }
        : { login: USER_LOGIN, type: "User" },
      performed_via_github_app: byApp
        ? { id: this.app.id, slug: this.app.slug }
        : null,
    };
  }

  // Routes outside /repos

  private readonly topRoutes: Route<RequestContext>[] = [
    {
      method: "POST",
      pattern: "orgs/:org/repos",
      handle: (c) => this.createRepo(c),
    },
    {
      method: "POST",
      pattern: "user/repos",
      handle: (c) => this.createUserRepo(c),
    },
    {
      method: "GET",
      pattern: "user",
      handle: (c) =>
        c.who === "user"
          ? reply(200, { login: USER_LOGIN, type: "User" })
          : reply(403, { message: "Resource not accessible by integration" }),
    },
    {
      method: "GET",
      pattern: "user/installations",
      handle: (c) => this.listInstallations(c),
    },
    {
      method: "PUT",
      pattern: "user/installations/:id/repositories/:repo_id",
      handle: (c) => this.addToInstallation(c),
    },
  ];

  private createRepo(c: RequestContext): Reply {
    if (param(c.params, "org") !== this.org) return notFound();
    const name = asString(c.body.name) ?? "";
    if (name.length === 0) return invalid("name is missing");
    if (this.findRepo(name) !== undefined)
      return reply(422, {
        message: "Repository creation failed.",
        errors: [
          {
            resource: "Repository",
            code: "custom",
            field: "name",
            message: "name already exists on this account",
          },
        ],
      });
    // The fake always starts the repository with one commit, as auto_init
    // does. It does not add the repository to the installation.
    const repo = this.addRepo(
      name,
      asString(c.body.description) ?? "",
      this.orgDefaultBranch,
    );
    if (c.body.private === false) repo.visibility = "public";
    return reply(201, this.repoJson(repo));
  }

  /**
   * `POST /user/repos`: a repository in the token owner's own account. Only
   * the user token may call it, as on GitHub, and only a fake that stands for
   * that account (`org` is the owner's login) holds the repository.
   */
  private createUserRepo(c: RequestContext): Reply {
    if (c.who !== "user")
      return reply(403, { message: "Resource not accessible by integration" });
    if (this.org !== USER_LOGIN)
      return reply(422, {
        message: `The fake stands for ${this.org}, not the user's own account.`,
      });
    return this.createRepo({ ...c, params: { ...c.params, org: this.org } });
  }

  private listInstallations(c: RequestContext): Reply {
    if (c.who !== "user")
      return reply(403, { message: "Resource not accessible by integration" });
    return reply(200, {
      total_count: this.userInstallations.length,
      installations: this.userInstallations.map((i) => ({
        id: i.id,
        app_id: this.app.id,
        account: { login: i.account_login, type: i.account_type },
        repository_selection: i.repository_selection,
      })),
    });
  }

  private addToInstallation(c: RequestContext): Reply {
    if (c.who !== "user")
      return reply(403, { message: "Resource not accessible by integration" });
    if (Number(param(c.params, "id")) !== this.installationId) return notFound();
    const repoId = Number(param(c.params, "repo_id"));
    const known = [...this.repos.values()].some((r) => r.id === repoId);
    if (!known) return notFound();
    if (this.selected.has(repoId)) return reply(304);
    this.selected.add(repoId);
    return reply(204);
  }

  // Routes under /repos/{owner}/{repo}

  private readonly repoRoutes: Route<RepoContext>[] = [
    { method: "GET", pattern: "", handle: (c) => reply(200, this.repoJson(c.repo)) },
    { method: "PATCH", pattern: "", handle: (c) => this.updateRepo(c) },
    { method: "POST", pattern: "git/trees", handle: (c) => this.createTree(c) },
    { method: "GET", pattern: "git/ref/heads/*branch", handle: (c) => this.getRef(c) },
    { method: "GET", pattern: "git/commits/:sha", handle: (c) => this.getCommit(c) },
    { method: "POST", pattern: "git/commits", handle: (c) => this.createCommit(c) },
    { method: "POST", pattern: "git/refs", handle: (c) => this.createRef(c) },
    {
      method: "PATCH",
      pattern: "git/refs/heads/*branch",
      handle: (c) => this.updateRef(c),
    },
    {
      method: "DELETE",
      pattern: "git/refs/heads/*branch",
      handle: (c) => this.deleteRef(c),
    },
    {
      method: "GET",
      pattern: "actions/permissions",
      handle: (c) => reply(200, { enabled: c.repo.actions_enabled }),
    },
    {
      method: "PUT",
      pattern: "actions/permissions",
      handle: (c) => this.setActions(c),
    },
    { method: "GET", pattern: "rulesets", handle: (c) => this.listRulesets(c) },
    { method: "POST", pattern: "rulesets", handle: (c) => this.createRuleset(c) },
    { method: "GET", pattern: "rulesets/:id", handle: (c) => this.getRuleset(c) },
    { method: "PUT", pattern: "rulesets/:id", handle: (c) => this.updateRuleset(c) },
    {
      method: "GET",
      pattern: "environments/:env",
      handle: (c) => this.getEnvironment(c),
    },
    {
      method: "PUT",
      pattern: "environments/:env",
      handle: (c) => this.putEnvironment(c),
    },
    {
      method: "GET",
      pattern: "environments/:env/deployment-branch-policies",
      handle: (c) => this.listBranchPolicies(c),
    },
    {
      method: "POST",
      pattern: "environments/:env/deployment-branch-policies",
      handle: (c) => this.createBranchPolicy(c),
    },
    {
      method: "DELETE",
      pattern: "environments/:env/deployment-branch-policies/:id",
      handle: (c) => this.deleteBranchPolicy(c),
    },
    { method: "GET", pattern: "deployments", handle: (c) => this.listDeployments(c) },
    { method: "POST", pattern: "deployments", handle: (c) => this.createDeployment(c) },
    {
      method: "GET",
      pattern: "deployments/:id/statuses",
      handle: (c) => this.listStatuses(c),
    },
    {
      method: "POST",
      pattern: "deployments/:id/statuses",
      handle: (c) => this.createStatus(c),
    },
  ];

  private updateRepo(c: RepoContext): Reply {
    const { repo, body } = c;
    const branch = asString(body.default_branch);
    if (branch !== undefined && !repo.branches.has(branch))
      return invalid(`The branch ${branch} was not found.`);
    if (branch !== undefined) repo.default_branch = branch;
    const description = asString(body.description);
    if (description !== undefined) repo.description = description;
    const visibility = asString(body.visibility);
    if (visibility !== undefined) repo.visibility = visibility;
    const isPrivate = asBool(body.private);
    if (isPrivate !== undefined) repo.visibility = isPrivate ? "private" : "public";
    for (const key of MERGE_KEYS) {
      const value = asBool(body[key]);
      if (value !== undefined) repo.merge[key] = value;
    }
    return reply(200, this.repoJson(repo));
  }

  private createTree(c: RepoContext): Reply {
    const files: Record<string, string> = {};
    for (const entry of asArray(c.body.tree)) {
      const e = asObject(entry);
      const path = asString(e.path);
      const content = asString(e.content);
      if (path === undefined || content === undefined)
        return invalid("Each tree entry needs a path and content.");
      files[path] = content;
    }
    const sha = this.treeSha(files);
    c.repo.trees.set(sha, files);
    return reply(201, { sha });
  }

  private getRef(c: RepoContext): Reply {
    const branch = param(c.params, "branch");
    const head = c.repo.branches.get(branch);
    return head === undefined ? notFound() : reply(200, this.refJson(branch, head));
  }

  private getCommit(c: RepoContext): Reply {
    const commit = c.repo.commits.get(param(c.params, "sha"));
    return commit === undefined ? notFound() : reply(200, this.commitJson(commit));
  }

  private createCommit(c: RepoContext): Reply {
    const { repo, body } = c;
    const tree = asString(body.tree) ?? "";
    const files = repo.trees.get(tree);
    if (files === undefined) return invalid("Tree SHA does not exist");
    const parents: FakeCommit[] = [];
    for (const sha of asArray(body.parents)) {
      const parent = repo.commits.get(asString(sha) ?? "");
      if (parent === undefined)
        return invalid("Parent SHA does not exist or is not a commit object");
      parents.push(parent);
    }
    const commit = this.makeCommit(tree, files, parents, asString(body.message) ?? "");
    repo.commits.set(commit.sha, commit);
    return reply(201, this.commitJson(commit));
  }

  private createRef(c: RepoContext): Reply {
    const { repo, body } = c;
    const ref = asString(body.ref) ?? "";
    if (!ref.startsWith("refs/heads/"))
      return invalid("The fake only models refs/heads/ references.");
    const branch = ref.slice("refs/heads/".length);
    const commit = repo.commits.get(asString(body.sha) ?? "");
    if (commit === undefined) return invalid("Object does not exist");
    if (repo.branches.has(branch)) return invalid("Reference already exists");
    repo.branches.set(branch, commit);
    return reply(201, this.refJson(branch, commit));
  }

  private updateRef(c: RepoContext): Reply {
    const { repo, body } = c;
    const branch = param(c.params, "branch");
    const head = repo.branches.get(branch);
    if (head === undefined) return invalid("Reference does not exist");
    const commit = repo.commits.get(asString(body.sha) ?? "");
    if (commit === undefined) return invalid("Object does not exist");
    if (body.force !== true && !descends(commit, head.sha))
      return invalid("Update is not a fast forward");
    repo.branches.set(branch, commit);
    return reply(200, this.refJson(branch, commit));
  }

  private deleteRef(c: RepoContext): Reply {
    const { repo } = c;
    const branch = param(c.params, "branch");
    if (!repo.branches.has(branch)) return invalid("Reference does not exist");
    if (branch === repo.default_branch)
      return invalid("Cannot delete the default branch");
    repo.branches.delete(branch);
    return reply(204);
  }

  private setActions(c: RepoContext): Reply {
    const enabled = asBool(c.body.enabled);
    if (enabled === undefined) return invalid("enabled is missing");
    c.repo.actions_enabled = enabled;
    return reply(204);
  }

  private listRulesets(c: RepoContext): Reply {
    return reply(
      200,
      c.repo.rulesets.map((r) => ({
        id: r.id,
        name: r.name,
        source_type: "Repository",
      })),
    );
  }

  private rulesetNameTaken(repo: FakeRepo, name: string, id: number): boolean {
    return repo.rulesets.some((r) => r.name === name && r.id !== id);
  }

  private pickRulesetFields(body: Json, into: Json): void {
    for (const key of RULESET_FIELDS) if (key in body) into[key] = body[key];
  }

  private createRuleset(c: RepoContext): Reply {
    const { repo, body } = c;
    const name = asString(body.name) ?? "";
    if (name.length === 0) return invalid("Name can't be blank");
    if (this.rulesetNameTaken(repo, name, 0)) return invalid("Name must be unique");
    const ruleset: FakeRuleset = { id: this.nextId(), name, fields: {} };
    this.pickRulesetFields(body, ruleset.fields);
    repo.rulesets.push(ruleset);
    return reply(201, this.rulesetJson(repo, ruleset));
  }

  private findRuleset(c: RepoContext): FakeRuleset | undefined {
    const id = Number(param(c.params, "id"));
    return c.repo.rulesets.find((r) => r.id === id);
  }

  private getRuleset(c: RepoContext): Reply {
    const ruleset = this.findRuleset(c);
    return ruleset === undefined
      ? notFound()
      : reply(200, this.rulesetJson(c.repo, ruleset));
  }

  private updateRuleset(c: RepoContext): Reply {
    const { repo, body } = c;
    const ruleset = this.findRuleset(c);
    if (ruleset === undefined) return notFound();
    const name = asString(body.name);
    if (name !== undefined && this.rulesetNameTaken(repo, name, ruleset.id))
      return invalid("Name must be unique");
    if (name !== undefined) ruleset.name = name;
    this.pickRulesetFields(body, ruleset.fields);
    return reply(200, this.rulesetJson(repo, ruleset));
  }

  private getEnvironment(c: RepoContext): Reply {
    const env = c.repo.environments.get(param(c.params, "env"));
    return env === undefined ? notFound() : reply(200, this.environmentJson(env));
  }

  private ensureEnvironment(repo: FakeRepo, name: string): FakeEnvironment {
    const found = repo.environments.get(name);
    if (found !== undefined) return found;
    const env: FakeEnvironment = {
      id: this.nextId(),
      name,
      policy: null,
      branch_policies: [],
    };
    repo.environments.set(name, env);
    return env;
  }

  private putEnvironment(c: RepoContext): Reply {
    const env = this.ensureEnvironment(c.repo, param(c.params, "env"));
    if ("deployment_branch_policy" in c.body) {
      const policy = c.body.deployment_branch_policy;
      env.policy =
        policy === null
          ? null
          : {
              protected_branches: asBool(asObject(policy).protected_branches) === true,
              custom_branch_policies:
                asBool(asObject(policy).custom_branch_policies) === true,
            };
    }
    return reply(200, this.environmentJson(env));
  }

  private listBranchPolicies(c: RepoContext): Reply {
    const env = c.repo.environments.get(param(c.params, "env"));
    if (env === undefined) return notFound();
    return reply(200, {
      total_count: env.branch_policies.length,
      branch_policies: env.branch_policies.map((p) => ({ ...p })),
    });
  }

  private createBranchPolicy(c: RepoContext): Reply {
    const env = c.repo.environments.get(param(c.params, "env"));
    if (env === undefined) return notFound();
    const name = asString(c.body.name) ?? "";
    if (name.length === 0) return invalid("name is missing");
    const type = asString(c.body.type) ?? "branch";
    if (env.branch_policies.some((p) => p.name === name && p.type === type))
      return reply(303, { message: "The branch policy already exists." });
    const policy: FakeBranchPolicy = { id: this.nextId(), name, type };
    env.branch_policies.push(policy);
    return reply(200, { ...policy });
  }

  private deleteBranchPolicy(c: RepoContext): Reply {
    const env = c.repo.environments.get(param(c.params, "env"));
    if (env === undefined) return notFound();
    const id = Number(param(c.params, "id"));
    const index = env.branch_policies.findIndex((p) => p.id === id);
    if (index < 0) return notFound();
    env.branch_policies.splice(index, 1);
    return reply(204);
  }

  private perPage(query: URLSearchParams): number {
    // A missing or unreadable per_page reads as 0 and takes GitHub's default.
    const n = Number(query.get("per_page"));
    return n > 0 ? n : 30;
  }

  private listDeployments(c: RepoContext): Reply {
    const environment = c.query.get("environment");
    const list = c.repo.deployments
      .filter((d) => environment === null || d.environment === environment)
      .reverse()
      .slice(0, this.perPage(c.query));
    return reply(
      200,
      list.map((d) => this.deploymentJson(d)),
    );
  }

  private createDeployment(c: RepoContext): Reply {
    const { repo, body } = c;
    const ref = asString(body.ref) ?? "";
    const commit = repo.branches.get(ref) ?? repo.commits.get(ref);
    if (commit === undefined) return reply(422, { message: `No ref found for: ${ref}` });
    const environment = asString(body.environment) ?? "production";
    // GitHub creates an environment the first time a deployment names it.
    this.ensureEnvironment(repo, environment);
    const deployment: FakeDeployment = {
      id: this.nextId(),
      sha: commit.sha,
      ref,
      environment,
      payload: body.payload ?? {},
      description: asString(body.description) ?? "",
      by: c.who,
      statuses: [],
    };
    repo.deployments.push(deployment);
    return reply(201, this.deploymentJson(deployment));
  }

  private findDeployment(c: RepoContext): FakeDeployment | undefined {
    const id = Number(param(c.params, "id"));
    return c.repo.deployments.find((d) => d.id === id);
  }

  private listStatuses(c: RepoContext): Reply {
    const deployment = this.findDeployment(c);
    if (deployment === undefined) return notFound();
    return reply(
      200,
      [...deployment.statuses]
        .reverse()
        .slice(0, this.perPage(c.query))
        .map((s) => ({ ...s })),
    );
  }

  private createStatus(c: RepoContext): Reply {
    const deployment = this.findDeployment(c);
    if (deployment === undefined) return notFound();
    const state = asString(c.body.state) ?? "";
    if (!STATUS_STATES.has(state)) return invalid(`state ${state} is not valid`);
    const status: FakeStatus = {
      id: this.nextId(),
      state,
      environment: asString(c.body.environment) ?? deployment.environment,
      description: asString(c.body.description) ?? "",
    };
    deployment.statuses.push(status);
    return reply(201, { ...status });
  }
}
