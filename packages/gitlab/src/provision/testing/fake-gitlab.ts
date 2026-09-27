// fake-gitlab.ts: an in-memory GitLab for provisioning tests.
//
// The fake answers the REST routes the provisioning steps call, with the
// status codes GitLab sends. It holds one group, the group's bot user, and a
// group access token. Tests pass `fake.fetch` or `fake.rest()` to the code
// under test, inject failures with `failNext`, and compare `snapshot()`
// between a clean run and a run that failed and ran again.
import { createHash } from "node:crypto";
import { createGitlabRest } from "../http";
import type { GitlabRest, HttpFetch } from "../http";
import type { SteeringGroup } from "../types";

export { EXAMPLE_GITLAB_BASELINE } from "./baseline";

/**
 * A failure to inject. `path` is the path after /api/v4 with the query
 * removed. A string matches that path as sent or with each segment decoded,
 * so `/projects/acme/oxagen-support` matches `/projects/acme%2Foxagen-support`.
 * A RegExp is tested against the path as sent.
 */
export interface FakeFailRule {
  /** Matches any method when left out. */
  method?: string;
  path: string | RegExp;
  status: number;
  /** Defaults to "fake gitlab failed METHOD PATH". */
  message?: string;
  /** How many matching requests fail. Defaults to 1. */
  times?: number;
  /**
   * When true, the fake applies the request first and then answers
   * `status`, as when GitLab wrote the change and the answer was lost.
   * Otherwise the request changes nothing.
   */
  after?: boolean;
}

/** One access entry as the snapshot holds it. */
export interface FakeAccessSnapshot {
  access_level: number;
  user_id: number | null;
  group_id: number | null;
}

/** One project as the snapshot holds it. Ids are left out. */
export interface FakeProjectSnapshot {
  name: string;
  path: string;
  description: string;
  visibility: string;
  default_branch: string | null;
  branches: Record<string, { sha: string; files: Record<string, string> }>;
  settings: {
    squash_option: string;
    only_allow_merge_if_pipeline_succeeds: boolean;
    remove_source_branch_after_merge: boolean;
    builds_access_level: string;
  };
  protected_branches: Record<
    string,
    {
      push_access_levels: FakeAccessSnapshot[];
      merge_access_levels: FakeAccessSnapshot[];
      allow_force_push: boolean;
    }
  >;
  deployments: { environment: string; ref: string; sha: string; status: string }[];
}

/** The fake's state, keyed by path_with_namespace. It holds no ids, tokens, or call logs. */
export interface FakeGitlabSnapshot {
  projects: Record<string, FakeProjectSnapshot>;
}

type Json = Record<string, unknown>;

interface FakeBranch {
  sha: string;
  files: Map<string, string>;
}

interface FakeProtectedBranch {
  id: number;
  name: string;
  push: FakeAccessSnapshot[];
  merge: FakeAccessSnapshot[];
  allow_force_push: boolean;
}

interface FakeDeployment {
  id: number;
  iid: number;
  environment: string;
  ref: string;
  sha: string;
  status: string;
}

interface FakeProject {
  id: number;
  name: string;
  path: string;
  description: string;
  visibility: string;
  default_branch: string | null;
  squash_option: string;
  only_allow_merge_if_pipeline_succeeds: boolean;
  remove_source_branch_after_merge: boolean;
  builds_access_level: string;
  branches: Map<string, FakeBranch>;
  protected_branches: Map<string, FakeProtectedBranch>;
  deployments: FakeDeployment[];
}

interface Reply {
  status: number;
  body?: unknown;
}

interface FakeRequest {
  param(name: string): string;
  query: URLSearchParams;
  body: Json;
}

interface Route {
  method: string;
  pattern: readonly string[];
  handle(req: FakeRequest): Reply;
}

const VISIBILITIES = ["private", "internal", "public"];
const SQUASH_OPTIONS = ["always", "default_on", "default_off", "never"];
const ACCESS_LEVELS = ["disabled", "private", "enabled"];
const DEPLOYMENT_STATUSES = ["running", "success", "failed", "canceled"];

function asObject(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function parseBody(text: string | undefined): Json {
  return text === undefined ? {} : asObject(JSON.parse(text) as unknown);
}

function text(body: Json, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value : "";
}

function str(body: Json, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" ? value : undefined;
}

function num(body: Json, key: string): number | undefined {
  const value = body[key];
  return typeof value === "number" ? value : undefined;
}

function bool(body: Json, key: string): boolean | undefined {
  const value = body[key];
  return typeof value === "boolean" ? value : undefined;
}

function list(body: Json, key: string): Json[] {
  const value = body[key];
  return Array.isArray(value) ? (value as unknown[]).map(asObject) : [];
}

function ok(body: unknown, status = 200): Reply {
  return { status, body };
}

function fail(status: number, message: unknown): Reply {
  return { status, body: { message } };
}

function notFound(what: string): Reply {
  return fail(404, `404 ${what} Not Found`);
}

/** GitLab's answer to a request that leaves out a required parameter. */
function need(body: Json, keys: readonly string[]): Reply | null {
  for (const key of keys)
    if (body[key] === undefined)
      return { status: 400, body: { error: `${key} is missing` } };
  return null;
}

/** GitLab's answer to a parameter outside its allowed values. */
function invalid(body: Json, key: string, allowed: readonly string[]): Reply | null {
  const value = body[key];
  if (value === undefined) return null;
  return typeof value === "string" && allowed.includes(value)
    ? null
    : { status: 400, body: { error: `${key} does not have a valid value` } };
}

function byName<T>(entries: [string, T][]): [string, T][] {
  return entries.sort((x, y) => (x[0] < y[0] ? -1 : 1));
}

function decodePath(path: string): string {
  return path.split("/").map(decodeURIComponent).join("/");
}

/** A commit sha from the tree and the message, so equal content gives equal shas. */
function shaOf(files: Map<string, string>, message: string): string {
  const tree = byName([...files.entries()]);
  return createHash("sha1").update(JSON.stringify({ tree, message })).digest("hex");
}

/** One page of `rows`, read from `per_page` (default 20, at most 100) and `page`. */
function page<T>(rows: readonly T[], query: URLSearchParams): T[] {
  const perPage = Math.min(100, Number(query.get("per_page") ?? "20"));
  const pageNo = Number(query.get("page") ?? "1");
  return rows.slice((pageNo - 1) * perPage, pageNo * perPage);
}

/** The tree entries of a branch. A recursive listing holds every folder and file. */
function treeOf(files: Map<string, string>, recursive: boolean): Json[] {
  const entries = new Map<string, "tree" | "blob">();
  for (const path of files.keys()) {
    const parts = path.split("/");
    for (let depth = 1; depth < parts.length; depth++)
      entries.set(parts.slice(0, depth).join("/"), "tree");
    entries.set(path, "blob");
  }
  return byName([...entries.entries()])
    .filter(([path]) => recursive || !path.includes("/"))
    .map(([path, type]) => ({
      id: createHash("sha1").update(`${type}:${path}`).digest("hex"),
      name: path.slice(path.lastIndexOf("/") + 1),
      type,
      path,
      mode: type === "tree" ? "040000" : "100644",
    }));
}

/** Access entries from `allowed_to_push` or `allowed_to_merge`. */
function grants(entries: readonly Json[]): FakeAccessSnapshot[] {
  const out: FakeAccessSnapshot[] = [];
  for (const entry of entries) {
    const user_id = num(entry, "user_id");
    const group_id = num(entry, "group_id");
    const access_level = num(entry, "access_level");
    if (user_id !== undefined) out.push({ access_level: 40, user_id, group_id: null });
    else if (group_id !== undefined)
      out.push({ access_level: 40, user_id: null, group_id });
    else if (access_level !== undefined)
      out.push({ access_level, user_id: null, group_id: null });
  }
  return out;
}

function level(access_level: number): FakeAccessSnapshot {
  return { access_level, user_id: null, group_id: null };
}

function protectionJson(rule: FakeProtectedBranch): Json {
  return {
    id: rule.id,
    name: rule.name,
    push_access_levels: rule.push.map((e) => ({ ...e })),
    merge_access_levels: rule.merge.map((e) => ({ ...e })),
    allow_force_push: rule.allow_force_push,
    code_owner_approval_required: false,
  };
}

function deploymentJson(d: FakeDeployment): Json {
  return {
    id: d.id,
    iid: d.iid,
    ref: d.ref,
    sha: d.sha,
    status: d.status,
    environment: { name: d.environment },
  };
}

interface RuleEntry {
  rule: FakeFailRule;
  left: number;
}

interface Answered {
  method: string;
  path: string;
  applied: boolean;
}

export class FakeGitlab {
  /** Every request the fake received, with the path after /api/v4 and its query. */
  readonly calls: { method: string; path: string }[] = [];

  readonly fetch: HttpFetch = (url, init) =>
    Promise.resolve(this.answer(url, init));

  private readonly group: SteeringGroup;
  private readonly bot: { user_id: number; username: string };
  private readonly token: string;
  private revoked = false;
  private readonly rules: RuleEntry[] = [];
  private readonly answered: Answered[] = [];
  private readonly projects: FakeProject[] = [];
  private readonly routes: readonly Route[];
  private nextProjectId = 1;
  private nextProtectionId = 1;
  private nextDeploymentId = 1;

  constructor(opts: {
    group: SteeringGroup;
    bot: { user_id: number; username: string };
    /** Defaults to "group-token". */
    token?: string;
  }) {
    this.group = opts.group;
    this.bot = opts.bot;
    this.token = opts.token ?? "group-token";
    this.routes = this.buildRoutes();
  }

  /** A REST helper wired to the fake. It uses the group token unless given another. */
  rest(token?: string): GitlabRest {
    return createGitlabRest({ token: token ?? this.token, fetch: this.fetch });
  }

  /** Make the next matching requests answer `rule.status`. */
  failNext(rule: FakeFailRule): void {
    this.rules.push({ rule, left: rule.times ?? 1 });
  }

  /** From now on the group token answers 401, as after the owner revokes it. */
  revokeToken(): void {
    this.revoked = true;
  }

  /** Put an empty project in the group, as if someone created it earlier. Returns its id. */
  seedProject(input: { name: string; description?: string }): number {
    return this.addProject({
      name: input.name,
      path: input.name,
      description: input.description ?? "",
      visibility: "private",
    }).id;
  }

  /**
   * The non-GET requests the fake applied, in order. A request a rule failed
   * before applying it is left out. One a rule failed after applying it is kept.
   */
  writes(): { method: string; path: string }[] {
    return this.answered
      .filter((a) => a.method !== "GET" && a.applied)
      .map(({ method, path }) => ({ method, path }));
  }

  /** The state of every project, in a stable order and safe to compare with `toEqual`. */
  snapshot(): FakeGitlabSnapshot {
    const projects: Record<string, FakeProjectSnapshot> = {};
    const sorted = [...this.projects].sort((a, b) => (a.path < b.path ? -1 : 1));
    for (const p of sorted) {
      const branches: FakeProjectSnapshot["branches"] = {};
      for (const [name, branch] of byName([...p.branches.entries()]))
        branches[name] = {
          sha: branch.sha,
          files: Object.fromEntries(byName([...branch.files.entries()])),
        };
      const protected_branches: FakeProjectSnapshot["protected_branches"] = {};
      for (const [name, rule] of byName([...p.protected_branches.entries()]))
        protected_branches[name] = {
          push_access_levels: rule.push.map((e) => ({ ...e })),
          merge_access_levels: rule.merge.map((e) => ({ ...e })),
          allow_force_push: rule.allow_force_push,
        };
      projects[this.fullPath(p)] = {
        name: p.name,
        path: p.path,
        description: p.description,
        visibility: p.visibility,
        default_branch: p.default_branch,
        branches,
        settings: {
          squash_option: p.squash_option,
          only_allow_merge_if_pipeline_succeeds: p.only_allow_merge_if_pipeline_succeeds,
          remove_source_branch_after_merge: p.remove_source_branch_after_merge,
          builds_access_level: p.builds_access_level,
        },
        protected_branches,
        deployments: p.deployments
          .map(({ environment, ref, sha, status }) => ({ environment, ref, sha, status }))
          .sort((a, b) =>
            JSON.stringify(a) < JSON.stringify(b) ? -1 : 1,
          ),
      };
    }
    return { projects };
  }

  private answer(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): { status: number; text(): Promise<string> } {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^.*?\/api\/v4/, "");
    const method = init.method.toUpperCase();
    const logged = `${path}${parsed.search}`;
    this.calls.push({ method, path: logged });

    const rule = this.takeRule(method, path);
    let reply: Reply;
    let applied = false;
    if (rule !== undefined && rule.after !== true) {
      reply = this.failure(rule, method, path);
    } else if (init.headers["PRIVATE-TOKEN"] !== this.token || this.revoked) {
      reply = fail(401, "401 Unauthorized");
    } else {
      reply = this.route(method, path, parsed.searchParams, parseBody(init.body));
      applied = reply.status >= 200 && reply.status < 300;
      if (rule !== undefined) reply = this.failure(rule, method, path);
    }
    this.answered.push({ method, path: logged, applied });
    const body = reply.body === undefined ? "" : JSON.stringify(reply.body);
    return { status: reply.status, text: () => Promise.resolve(body) };
  }

  private failure(rule: FakeFailRule, method: string, path: string): Reply {
    return fail(rule.status, rule.message ?? `fake gitlab failed ${method} ${path}`);
  }

  private takeRule(method: string, path: string): FakeFailRule | undefined {
    const decoded = decodePath(path);
    const entry = this.rules.find(
      ({ rule }) =>
        (rule.method === undefined || rule.method.toUpperCase() === method) &&
        (typeof rule.path === "string"
          ? rule.path === path || rule.path === decoded
          : rule.path.test(path)),
    );
    if (entry === undefined) return undefined;
    entry.left -= 1;
    if (entry.left <= 0) this.rules.splice(this.rules.indexOf(entry), 1);
    return entry.rule;
  }

  private route(method: string, path: string, query: URLSearchParams, body: Json): Reply {
    const segments = path.split("/").slice(1);
    for (const route of this.routes) {
      if (route.method !== method || route.pattern.length !== segments.length) continue;
      const params = new Map<string, string>();
      const matched = route.pattern.every((part, i) => {
        const actual = segments[i] ?? "";
        if (!part.startsWith(":")) return part === actual;
        params.set(part.slice(1), decodeURIComponent(actual));
        return true;
      });
      if (matched)
        return route.handle({ param: (name) => params.get(name) ?? "", query, body });
    }
    return fail(404, `fake gitlab has no route for ${method} ${path}`);
  }

  private fullPath(p: FakeProject): string {
    return `${this.group.full_path}/${p.path}`;
  }

  private addProject(input: {
    name: string;
    path: string;
    description: string;
    visibility: string;
  }): FakeProject {
    const project: FakeProject = {
      id: this.nextProjectId++,
      ...input,
      // GitLab reports no default branch until the repository holds a commit.
      default_branch: null,
      squash_option: "default_off",
      only_allow_merge_if_pipeline_succeeds: false,
      remove_source_branch_after_merge: true,
      builds_access_level: "enabled",
      branches: new Map(),
      protected_branches: new Map(),
      deployments: [],
    };
    this.projects.push(project);
    return project;
  }

  private withProject(req: FakeRequest, fn: (p: FakeProject) => Reply): Reply {
    const ref = req.param("id").toLowerCase();
    const project = this.projects.find(
      (p) => String(p.id) === ref || this.fullPath(p).toLowerCase() === ref,
    );
    return project === undefined ? notFound("Project") : fn(project);
  }

  private projectJson(p: FakeProject): Json {
    return {
      id: p.id,
      name: p.name,
      path: p.path,
      path_with_namespace: this.fullPath(p),
      description: p.description,
      visibility: p.visibility,
      default_branch: p.default_branch,
      empty_repo: p.branches.size === 0,
      namespace: { id: this.group.id, full_path: this.group.full_path, kind: "group" },
      squash_option: p.squash_option,
      only_allow_merge_if_pipeline_succeeds: p.only_allow_merge_if_pipeline_succeeds,
      remove_source_branch_after_merge: p.remove_source_branch_after_merge,
      builds_access_level: p.builds_access_level,
    };
  }

  /** The bot is a Maintainer, so a push rule at Developer or Maintainer lets it push. */
  private botCanPush(p: FakeProject, branch: string): boolean {
    const rule = p.protected_branches.get(branch);
    if (rule === undefined) return true;
    return rule.push.some(
      (e) =>
        e.user_id === this.bot.user_id ||
        (e.user_id === null && e.group_id === null && e.access_level > 0 && e.access_level <= 40),
    );
  }

  private buildRoutes(): Route[] {
    const on = (method: string, path: string, handle: (req: FakeRequest) => Reply): Route => ({
      method,
      pattern: path.split("/").slice(1),
      handle,
    });
    return [
      on("GET", "/user", () =>
        ok({ id: this.bot.user_id, username: this.bot.username, bot: true }),
      ),
      on("GET", "/groups/:id", (req) => {
        const ref = req.param("id");
        return ref === String(this.group.id) || ref === this.group.full_path
          ? ok({ id: this.group.id, full_path: this.group.full_path })
          : notFound("Group");
      }),
      on("GET", "/projects/:id", (req) =>
        this.withProject(req, (p) => ok(this.projectJson(p))),
      ),
      on("POST", "/projects", (req) => this.createProject(req.body)),
      on("PUT", "/projects/:id", (req) =>
        this.withProject(req, (p) => this.updateProject(p, req.body)),
      ),
      on("GET", "/projects/:id/repository/branches/:branch", (req) =>
        this.withProject(req, (p) => {
          const name = req.param("branch");
          const branch = p.branches.get(name);
          if (branch === undefined) return notFound("Branch");
          return ok({
            name,
            commit: { id: branch.sha, short_id: branch.sha.slice(0, 8) },
            protected: p.protected_branches.has(name),
            default: p.default_branch === name,
          });
        }),
      ),
      on("GET", "/projects/:id/repository/tree", (req) =>
        this.withProject(req, (p) => {
          const branch = p.branches.get(req.query.get("ref") ?? p.default_branch ?? "");
          if (branch === undefined) return notFound("Tree");
          const recursive = req.query.get("recursive") === "true";
          return ok(page(treeOf(branch.files, recursive), req.query));
        }),
      ),
      on("GET", "/projects/:id/repository/files/:file_path", (req) =>
        this.withProject(req, (p) => this.readFile(p, req)),
      ),
      on("POST", "/projects/:id/repository/commits", (req) =>
        this.withProject(req, (p) => this.commit(p, req.body)),
      ),
      on("GET", "/projects/:id/protected_branches", (req) =>
        this.withProject(req, (p) =>
          ok(page([...p.protected_branches.values()].map(protectionJson), req.query)),
        ),
      ),
      on("POST", "/projects/:id/protected_branches", (req) =>
        this.withProject(req, (p) => this.protect(p, req.body)),
      ),
      on("DELETE", "/projects/:id/protected_branches/:name", (req) =>
        this.withProject(req, (p) =>
          p.protected_branches.delete(req.param("name"))
            ? { status: 204 }
            : notFound("Protected Branch"),
        ),
      ),
      on("GET", "/projects/:id/deployments", (req) =>
        this.withProject(req, (p) => {
          const environment = req.query.get("environment");
          const rows = p.deployments
            .filter((d) => environment === null || d.environment === environment)
            .sort((a, b) => a.id - b.id);
          if (req.query.get("sort") === "desc") rows.reverse();
          return ok(page(rows.map(deploymentJson), req.query));
        }),
      ),
      on("POST", "/projects/:id/deployments", (req) =>
        this.withProject(req, (p) => this.deploy(p, req.body)),
      ),
      on("PUT", "/projects/:id/deployments/:deployment_id", (req) =>
        this.withProject(req, (p) => {
          const d = p.deployments.find((x) => String(x.id) === req.param("deployment_id"));
          if (d === undefined) return notFound("Deployment");
          const bad = need(req.body, ["status"]) ?? invalid(req.body, "status", DEPLOYMENT_STATUSES);
          if (bad !== null) return bad;
          d.status = text(req.body, "status");
          return ok(deploymentJson(d));
        }),
      ),
    ];
  }

  private createProject(body: Json): Reply {
    const bad = need(body, ["name", "namespace_id"]) ?? invalid(body, "visibility", VISIBILITIES);
    if (bad !== null) return bad;
    if (num(body, "namespace_id") !== this.group.id)
      return fail(400, { namespace: ["is not valid"] });
    const name = text(body, "name");
    const path = str(body, "path") ?? name;
    const taken = this.projects.some(
      (p) =>
        p.name.toLowerCase() === name.toLowerCase() ||
        p.path.toLowerCase() === path.toLowerCase(),
    );
    if (taken)
      return fail(400, {
        name: ["has already been taken"],
        path: ["has already been taken"],
      });
    const project = this.addProject({
      name,
      path,
      description: text(body, "description"),
      visibility: str(body, "visibility") ?? "private",
    });
    return ok(this.projectJson(project), 201);
  }

  private updateProject(p: FakeProject, body: Json): Reply {
    const bad =
      invalid(body, "visibility", VISIBILITIES) ??
      invalid(body, "squash_option", SQUASH_OPTIONS) ??
      invalid(body, "builds_access_level", ACCESS_LEVELS);
    if (bad !== null) return bad;
    p.visibility = str(body, "visibility") ?? p.visibility;
    p.description = str(body, "description") ?? p.description;
    p.default_branch = str(body, "default_branch") ?? p.default_branch;
    p.squash_option = str(body, "squash_option") ?? p.squash_option;
    p.builds_access_level = str(body, "builds_access_level") ?? p.builds_access_level;
    p.only_allow_merge_if_pipeline_succeeds =
      bool(body, "only_allow_merge_if_pipeline_succeeds") ??
      p.only_allow_merge_if_pipeline_succeeds;
    p.remove_source_branch_after_merge =
      bool(body, "remove_source_branch_after_merge") ?? p.remove_source_branch_after_merge;
    return ok(this.projectJson(p));
  }

  private readFile(p: FakeProject, req: FakeRequest): Reply {
    const ref = req.query.get("ref");
    if (ref === null) return { status: 400, body: { error: "ref is missing" } };
    const branch = p.branches.get(ref);
    const path = req.param("file_path");
    const content = branch?.files.get(path);
    if (branch === undefined || content === undefined) return notFound("File");
    return ok({
      file_name: path.slice(path.lastIndexOf("/") + 1),
      file_path: path,
      size: Buffer.byteLength(content),
      encoding: "base64",
      content: Buffer.from(content, "utf8").toString("base64"),
      content_sha256: createHash("sha256").update(content).digest("hex"),
      ref,
      commit_id: branch.sha,
      last_commit_id: branch.sha,
    });
  }

  private commit(p: FakeProject, body: Json): Reply {
    const bad = need(body, ["branch", "commit_message", "actions"]);
    if (bad !== null) return bad;
    const name = text(body, "branch");
    const message = text(body, "commit_message");
    const current = p.branches.get(name);
    if (current === undefined && p.branches.size > 0)
      return fail(400, "You can only create or edit files when you are on a branch");
    if (!this.botCanPush(p, name))
      return fail(403, "403 Forbidden - You are not allowed to push into this branch");
    // Work on a copy, so a rejected action leaves the branch as it was.
    const files = new Map(current?.files ?? []);
    for (const action of list(body, "actions")) {
      const kind = text(action, "action");
      const path = text(action, "file_path");
      const exists = files.has(path);
      if (kind === "create" && exists)
        return fail(400, "A file with this name already exists");
      if ((kind === "update" || kind === "delete") && !exists)
        return fail(400, "A file with this name doesn't exist");
      if (kind === "delete") files.delete(path);
      else if (kind === "create" || kind === "update")
        files.set(path, text(action, "content"));
      else return { status: 400, body: { error: "actions[action] does not have a valid value" } };
    }
    const sha = shaOf(files, message);
    p.branches.set(name, { sha, files });
    p.default_branch ??= name;
    return ok(
      {
        id: sha,
        short_id: sha.slice(0, 8),
        title: message.split("\n")[0],
        message,
        parent_ids: current === undefined ? [] : [current.sha],
      },
      201,
    );
  }

  private protect(p: FakeProject, body: Json): Reply {
    const bad = need(body, ["name"]);
    if (bad !== null) return bad;
    const name = text(body, "name");
    if (p.protected_branches.has(name))
      return fail(409, `Protected branch '${name}' already exists`);
    // GitLab keeps the level entry beside any user or group entry, and the
    // level defaults to Maintainers when the request leaves it out.
    const rule: FakeProtectedBranch = {
      id: this.nextProtectionId++,
      name,
      push: [
        level(num(body, "push_access_level") ?? 40),
        ...grants(list(body, "allowed_to_push")),
      ],
      merge: [
        level(num(body, "merge_access_level") ?? 40),
        ...grants(list(body, "allowed_to_merge")),
      ],
      allow_force_push: bool(body, "allow_force_push") ?? false,
    };
    p.protected_branches.set(name, rule);
    return ok(protectionJson(rule), 201);
  }

  private deploy(p: FakeProject, body: Json): Reply {
    const bad =
      need(body, ["environment", "sha", "ref", "tag", "status"]) ??
      invalid(body, "status", DEPLOYMENT_STATUSES);
    if (bad !== null) return bad;
    const deployment: FakeDeployment = {
      id: this.nextDeploymentId++,
      iid: p.deployments.length + 1,
      environment: text(body, "environment"),
      ref: text(body, "ref"),
      sha: text(body, "sha"),
      status: text(body, "status"),
    };
    p.deployments.push(deployment);
    return ok(deploymentJson(deployment), 201);
  }
}
