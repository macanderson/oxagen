import { describe, expect, it } from "vitest";
import { EXAMPLE_GITHUB_BASELINE as BASELINE } from "./testing/baseline";
import {
  EXAMPLE_GITHUB_BASELINE,
  FakeGithub,
  type FakeGithubOptions,
} from "./testing/fake-github";
import type { SteeringApp } from "./types";

const APP: SteeringApp = { symbol: "oxagen-steering", id: 4242, slug: "oxagen-steering" };
const ROOT = "/repos/acme/oxagen-support";
const API = "https://api.github.com";

type Json = Record<string, unknown>;

interface Answer<T> {
  status: number;
  body: T;
}

async function answer<T>(
  fake: FakeGithub,
  method: string,
  path: string,
  token: string | null,
  body: string | undefined,
): Promise<Answer<T>> {
  const headers: Record<string, string> =
    token === null ? {} : { Authorization: `Bearer ${token}` };
  const init = body === undefined ? { method, headers } : { method, headers, body };
  const res = await fake.fetch(`${API}${path}`, init);
  const text = await res.text();
  return { status: res.status, body: (text.length === 0 ? null : JSON.parse(text)) as T };
}

/** Send one request straight to the fake and read the status and body, whatever the status. */
function send<T = Json>(
  fake: FakeGithub,
  method: string,
  path: string,
  body?: unknown,
  token: string | null = "app-token",
): Promise<Answer<T>> {
  return answer<T>(fake, method, path, token, body === undefined ? undefined : JSON.stringify(body));
}

function sendRaw(fake: FakeGithub, method: string, path: string, raw: string): Promise<Answer<Json>> {
  return answer<Json>(fake, method, path, "app-token", raw);
}

function invalid(message: string): Answer<Json> {
  return { status: 422, body: { message: "Validation Failed", errors: [message] } };
}

const NOT_FOUND: Answer<Json> = { status: 404, body: { message: "Not Found" } };

/** A fake with acme/oxagen-support seeded into the installation. */
function repoFake(opts: Partial<FakeGithubOptions> = {}): FakeGithub {
  const fake = new FakeGithub({ org: "acme", app: APP, ...opts });
  fake.seedRepository({ name: "oxagen-support", in_installation: true });
  return fake;
}

async function headOf(fake: FakeGithub, branch = "main"): Promise<string> {
  const ref = await send<{ object: { sha: string } }>(
    fake,
    "GET",
    `${ROOT}/git/ref/heads/${branch}`,
  );
  return ref.body.object.sha;
}

/** Write one file on top of `parent` and return the new commit's sha. */
async function commitOn(fake: FakeGithub, parent: string, content: string): Promise<string> {
  const tree = await send<{ sha: string }>(fake, "POST", `${ROOT}/git/trees`, {
    tree: [{ path: "notes.md", mode: "100644", type: "blob", content }],
  });
  const commit = await send<{ sha: string }>(fake, "POST", `${ROOT}/git/commits`, {
    message: content,
    tree: tree.body.sha,
    parents: [parent],
  });
  return commit.body.sha;
}

describe("FakeGithub authentication", () => {
  it("answers 401 to a request with no token or an unknown token", async () => {
    const fake = repoFake();
    for (const token of [null, "stolen"])
      expect(await send(fake, "GET", ROOT, undefined, token), String(token)).toEqual({
        status: 401,
        body: { message: "Bad credentials" },
      });
  });

  it("answers 401 to the user token after it is revoked", async () => {
    const fake = repoFake();
    expect((await send(fake, "GET", ROOT, undefined, "user-token")).status).toBe(200);
    fake.revokeUserToken();
    expect((await send(fake, "GET", ROOT, undefined, "user-token")).status).toBe(401);
    expect((await send(fake, "GET", ROOT)).status).toBe(200);
  });

  it("uses the tokens and the installation id it is given", async () => {
    const fake = new FakeGithub({
      org: "acme",
      app: APP,
      app_token: "ghs_app",
      user_token: "ghu_user",
      installation_id: 9,
    });
    const id = fake.seedRepository({ name: "oxagen-support" });

    expect((await send(fake, "GET", ROOT)).status).toBe(401);
    expect((await fake.appRest().request("GET", ROOT, undefined, [404])).status).toBe(404);
    const list = await fake
      .userRest()
      .request<{ installations: { id: number }[] }>("GET", "/user/installations");
    expect(list.data?.installations.map((i) => i.id)).toEqual([9]);
    await fake.userRest().request("PUT", `/user/installations/9/repositories/${id}`);
    expect((await fake.rest("ghs_app").request("GET", ROOT)).status).toBe(200);
  });
});

describe("FakeGithub routing", () => {
  it("answers 400 to a body that is not JSON", async () => {
    const fake = repoFake();
    expect(await sendRaw(fake, "PATCH", ROOT, "{")).toEqual({
      status: 400,
      body: { message: "Problems parsing JSON" },
    });
  });

  it("reads a JSON body that is not an object as empty", async () => {
    const fake = repoFake();
    expect(await send(fake, "PUT", `${ROOT}/actions/permissions`, [true])).toEqual(
      invalid("enabled is missing"),
    );
  });

  it("names the route it lacks", async () => {
    const fake = repoFake();
    const missing = [
      ["GET", "/repos"],
      ["GET", "/repos/acme"],
      ["GET", `${ROOT}/branches`],
      ["GET", `${ROOT}/git/ref/heads`],
      ["DELETE", "/orgs/acme/repos"],
      ["GET", "/meta"],
    ] as const;
    for (const [method, path] of missing)
      expect(await send(fake, method, path), `${method} ${path}`).toEqual({
        status: 404,
        body: { message: `fake github has no route for ${method} ${path}` },
      });
  });

  it("leaves the query out of the route it names", async () => {
    const fake = repoFake();
    const res = await send(fake, "GET", `${ROOT}/pulls?state=open`);
    expect(res.body).toEqual({ message: `fake github has no route for GET ${ROOT}/pulls` });
  });

  it("answers 404 for a repository in another org, a missing one, or one the app cannot see", async () => {
    const fake = repoFake();
    fake.seedRepository({ name: "hidden" });
    for (const path of ["/repos/other/oxagen-support", "/repos/acme/missing", "/repos/acme/hidden"])
      expect(await send(fake, "GET", path), path).toEqual(NOT_FOUND);
    expect((await send(fake, "GET", "/repos/acme/hidden", undefined, "user-token")).status).toBe(200);
  });

  it("lets the app see every repository when the installation covers all of them", async () => {
    const fake = new FakeGithub({ org: "acme", app: APP, repository_selection: "all" });
    fake.seedRepository({ name: "oxagen-support" });
    expect((await send(fake, "GET", ROOT)).status).toBe(200);
    const list = await send<{ installations: { repository_selection: string }[] }>(
      fake,
      "GET",
      "/user/installations",
      undefined,
      "user-token",
    );
    expect(list.body.installations.map((i) => i.repository_selection)).toEqual(["all"]);
  });

  it("finds a repository by its name in any case", async () => {
    const fake = repoFake();
    const res = await send<{ name: string }>(fake, "GET", "/repos/acme/OXAGEN-Support");
    expect(res.body.name).toBe("oxagen-support");
  });

  it("logs every call with its query and lists the writes", async () => {
    const fake = repoFake();
    await send(fake, "get", `${ROOT}/deployments?per_page=5`);
    await send(fake, "PUT", `${ROOT}/actions/permissions`, { enabled: false });
    expect(fake.calls).toEqual([
      { method: "GET", path: `${ROOT}/deployments?per_page=5` },
      { method: "PUT", path: `${ROOT}/actions/permissions` },
    ]);
    expect(fake.writes()).toEqual([{ method: "PUT", path: `${ROOT}/actions/permissions` }]);
  });
});

describe("FakeGithub.failNext", () => {
  it("fails the next request of any method whose path holds a string, once", async () => {
    const fake = repoFake();
    fake.failNext({ path: "/actions/permissions", status: 502 });
    expect(await send(fake, "PUT", `${ROOT}/actions/permissions`, { enabled: false })).toEqual({
      status: 502,
      body: { message: "fake failure" },
    });
    expect((await send(fake, "GET", `${ROOT}/actions/permissions`)).body).toEqual({
      enabled: true,
    });
  });

  it("matches a method in any case and a pattern, as many times as it is told", async () => {
    const fake = repoFake();
    fake.failNext({ method: "get", path: /\/rulesets$/, status: 500, message: "boom", times: 2 });
    expect((await send(fake, "POST", `${ROOT}/rulesets`, { name: "a" })).status).toBe(201);
    for (let i = 0; i < 2; i++)
      expect(await send(fake, "GET", `${ROOT}/rulesets`)).toEqual({
        status: 500,
        body: { message: "boom" },
      });
    expect((await send(fake, "GET", `${ROOT}/rulesets`)).status).toBe(200);
  });

  it("fails a request before it reads the token and still logs it", async () => {
    const fake = repoFake();
    fake.failNext({ path: ROOT, status: 503 });
    expect((await send(fake, "GET", ROOT, undefined, null)).status).toBe(503);
    expect(fake.calls).toEqual([{ method: "GET", path: ROOT }]);
  });
});

describe("FakeGithub.seedRepository", () => {
  it("starts a repository on the org's default branch with one commit", async () => {
    const fake = new FakeGithub({ org: "acme", app: APP, org_default_branch: "master" });
    const id = fake.seedRepository({
      name: "oxagen-support",
      description: "Steering",
      in_installation: true,
    });

    expect((await send(fake, "GET", ROOT)).body).toEqual({
      id,
      name: "oxagen-support",
      full_name: "acme/oxagen-support",
      owner: { login: "acme", type: "Organization" },
      private: true,
      visibility: "private",
      description: "Steering",
      default_branch: "master",
      allow_squash_merge: true,
      allow_merge_commit: true,
      allow_rebase_merge: true,
      delete_branch_on_merge: false,
    });
    const head = await headOf(fake, "master");
    expect((await send(fake, "GET", `${ROOT}/git/commits/${head}`)).body).toMatchObject({
      message: "Initial commit",
      parents: [],
    });
  });

  it("takes a default branch of its own and leaves the repository out of the installation", () => {
    const fake = new FakeGithub({ org: "acme", app: APP });
    fake.seedRepository({ name: "oxagen-support", default_branch: "trunk" });
    expect(fake.snapshot()).toMatchObject({
      repositories: { "oxagen-support": { default_branch: "trunk", in_installation: false } },
    });
  });

  it("throws on a repository it already has", () => {
    const fake = repoFake();
    expect(() => fake.seedRepository({ name: "Oxagen-Support" })).toThrow(
      "fake github already has acme/Oxagen-Support",
    );
  });
});

describe("FakeGithub organization routes", () => {
  it("creates a private repository that starts outside the installation", async () => {
    const fake = new FakeGithub({ org: "acme", app: APP, org_default_branch: "master" });
    const res = await send(fake, "POST", "/orgs/acme/repos", {
      name: "oxagen-support",
      private: true,
      auto_init: true,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: "oxagen-support",
      private: true,
      visibility: "private",
      description: null,
      default_branch: "master",
    });
    expect(await send(fake, "GET", ROOT)).toEqual(NOT_FOUND);
    expect(fake.snapshot()).toMatchObject({
      repositories: {
        "oxagen-support": {
          in_installation: false,
          files: { master: { "README.md": "# oxagen-support\n" } },
        },
      },
    });
  });

  it("creates a public repository with a description when asked", async () => {
    const fake = new FakeGithub({ org: "acme", app: APP });
    const res = await send(fake, "POST", "/orgs/acme/repos", {
      name: "oxagen-support",
      description: "Steering",
      private: false,
    });
    expect(res.body).toMatchObject({ private: false, visibility: "public", description: "Steering" });
  });

  it("refuses a repository in another org, one with no name, and one that exists", async () => {
    const fake = repoFake();
    expect(await send(fake, "POST", "/orgs/other/repos", { name: "x" })).toEqual(NOT_FOUND);
    expect(await send(fake, "POST", "/orgs/acme/repos", {})).toEqual(invalid("name is missing"));
    const taken = await send(fake, "POST", "/orgs/acme/repos", { name: "OXAGEN-SUPPORT" });
    expect(taken.status).toBe(422);
    expect(taken.body).toMatchObject({
      message: "Repository creation failed.",
      errors: [{ resource: "Repository", code: "custom", field: "name" }],
    });
  });

  it("lists the user's installations and refuses the app token", async () => {
    const fake = repoFake();
    expect(await send(fake, "GET", "/user/installations")).toEqual({
      status: 403,
      body: { message: "Resource not accessible by integration" },
    });
    expect((await send(fake, "GET", "/user/installations", undefined, "user-token")).body).toEqual({
      total_count: 1,
      installations: [
        {
          id: 77,
          app_id: 4242,
          account: { login: "acme", type: "Organization" },
          repository_selection: "selected",
        },
      ],
    });
  });

  it("lists the installations it is given", async () => {
    const fake = new FakeGithub({
      org: "acme",
      app: APP,
      user_installations: [
        { id: 5, account_login: "someone", account_type: "User", repository_selection: "all" },
      ],
    });
    expect((await send(fake, "GET", "/user/installations", undefined, "user-token")).body).toEqual({
      total_count: 1,
      installations: [
        {
          id: 5,
          app_id: 4242,
          account: { login: "someone", type: "User" },
          repository_selection: "all",
        },
      ],
    });
  });

  it("adds a repository to the installation once", async () => {
    const fake = new FakeGithub({ org: "acme", app: APP });
    const id = fake.seedRepository({ name: "oxagen-support" });
    const path = `/user/installations/77/repositories/${id}`;

    expect((await send(fake, "PUT", path)).status).toBe(403);
    const wrongInstallation = `/user/installations/78/repositories/${id}`;
    expect(await send(fake, "PUT", wrongInstallation, undefined, "user-token")).toEqual(NOT_FOUND);
    const unknownRepo = "/user/installations/77/repositories/9999";
    expect(await send(fake, "PUT", unknownRepo, undefined, "user-token")).toEqual(NOT_FOUND);
    expect(await send(fake, "PUT", path, undefined, "user-token")).toEqual({ status: 204, body: null });
    expect(await send(fake, "PUT", path, undefined, "user-token")).toEqual({ status: 304, body: null });
    expect((await send(fake, "GET", ROOT)).status).toBe(200);
  });
});

describe("FakeGithub repository settings", () => {
  it("updates the settings a PATCH names and leaves the rest", async () => {
    const fake = repoFake();
    const res = await send(fake, "PATCH", ROOT, {
      description: "Steering",
      visibility: "public",
      allow_merge_commit: false,
      delete_branch_on_merge: true,
      allow_rebase_merge: "no",
    });
    expect(res).toMatchObject({
      status: 200,
      body: {
        description: "Steering",
        visibility: "public",
        private: false,
        allow_squash_merge: true,
        allow_merge_commit: false,
        allow_rebase_merge: true,
        delete_branch_on_merge: true,
      },
    });
    const back = await send(fake, "PATCH", ROOT, { private: true });
    expect(back.body).toMatchObject({ private: true, visibility: "private", description: "Steering" });
  });

  it("refuses a default branch that does not exist and changes nothing", async () => {
    const fake = repoFake();
    expect(await send(fake, "PATCH", ROOT, { default_branch: "trunk", description: "x" })).toEqual(
      invalid("The branch trunk was not found."),
    );
    expect((await send(fake, "GET", ROOT)).body).toMatchObject({
      default_branch: "main",
      description: null,
    });
  });

  it("switches the default branch to one that exists", async () => {
    const fake = repoFake();
    const head = await headOf(fake);
    await send(fake, "POST", `${ROOT}/git/refs`, { ref: "refs/heads/trunk", sha: head });
    expect((await send(fake, "PATCH", ROOT, { default_branch: "trunk" })).body).toMatchObject({
      default_branch: "trunk",
    });
  });

  it("turns Actions off and back on", async () => {
    const fake = repoFake();
    const path = `${ROOT}/actions/permissions`;
    expect((await send(fake, "GET", path)).body).toEqual({ enabled: true });
    expect(await send(fake, "PUT", path, {})).toEqual(invalid("enabled is missing"));
    expect(await send(fake, "PUT", path, { enabled: "false" })).toEqual(invalid("enabled is missing"));
    expect(await send(fake, "PUT", path, { enabled: false })).toEqual({ status: 204, body: null });
    expect((await send(fake, "GET", path)).body).toEqual({ enabled: false });
    await send(fake, "PUT", path, { enabled: true });
    expect((await send(fake, "GET", path)).body).toEqual({ enabled: true });
  });
});

describe("FakeGithub git routes", () => {
  it("names a tree by its content whatever the entry order", async () => {
    const fake = repoFake();
    const path = `${ROOT}/git/trees`;
    const a = { path: "a.md", content: "1" };
    const b = { path: "b.md", content: "2" };
    const forward = await send<{ sha: string }>(fake, "POST", path, { tree: [a, b] });
    const backward = await send<{ sha: string }>(fake, "POST", path, { tree: [b, a] });
    const other = await send<{ sha: string }>(fake, "POST", path, { tree: [a] });

    expect(forward.status).toBe(201);
    expect(forward.body.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(backward.body.sha).toBe(forward.body.sha);
    expect(other.body.sha).not.toBe(forward.body.sha);
  });

  it("refuses a tree entry with no path or no content", async () => {
    const fake = repoFake();
    for (const entry of [{ content: "x" }, { path: "a.md" }, "a.md"])
      expect(
        await send(fake, "POST", `${ROOT}/git/trees`, { tree: [entry] }),
        JSON.stringify(entry),
      ).toEqual(invalid("Each tree entry needs a path and content."));
  });

  it("writes a commit on a known tree and parent and reads it back", async () => {
    const fake = repoFake();
    const head = await headOf(fake);
    const sha = await commitOn(fake, head, "one");
    expect((await send(fake, "GET", `${ROOT}/git/commits/${sha}`)).body).toMatchObject({
      sha,
      message: "one",
      parents: [{ sha: head }],
    });
    expect(await send(fake, "GET", `${ROOT}/git/commits/${"f".repeat(40)}`)).toEqual(NOT_FOUND);
  });

  it("refuses a commit on an unknown tree or parent", async () => {
    const fake = repoFake();
    const tree = await send<{ sha: string }>(fake, "POST", `${ROOT}/git/trees`, {
      tree: [{ path: "a.md", content: "1" }],
    });
    expect(
      await send(fake, "POST", `${ROOT}/git/commits`, { message: "m", tree: "nope", parents: [] }),
    ).toEqual(invalid("Tree SHA does not exist"));
    expect(
      await send(fake, "POST", `${ROOT}/git/commits`, {
        message: "m",
        tree: tree.body.sha,
        parents: ["nope"],
      }),
    ).toEqual(invalid("Parent SHA does not exist or is not a commit object"));
  });

  it("answers 404 for a branch it does not have", async () => {
    const fake = repoFake();
    expect(await send(fake, "GET", `${ROOT}/git/ref/heads/nope`)).toEqual(NOT_FOUND);
  });

  it("creates a branch at a known commit once", async () => {
    const fake = repoFake();
    const head = await headOf(fake);
    const refs = `${ROOT}/git/refs`;

    expect(await send(fake, "POST", refs, { ref: "refs/tags/v1", sha: head })).toEqual(
      invalid("The fake only models refs/heads/ references."),
    );
    expect(await send(fake, "POST", refs, { ref: "refs/heads/next", sha: "nope" })).toEqual(
      invalid("Object does not exist"),
    );
    expect(await send(fake, "POST", refs, { ref: "refs/heads/main", sha: head })).toEqual(
      invalid("Reference already exists"),
    );
    expect(await send(fake, "POST", refs, { ref: "refs/heads/release/v1", sha: head })).toEqual({
      status: 201,
      body: { ref: "refs/heads/release/v1", object: { sha: head, type: "commit" } },
    });
    expect(await headOf(fake, "release/v1")).toBe(head);
  });

  it("moves a branch forward, and anywhere only when forced", async () => {
    const fake = repoFake();
    const root = await headOf(fake);
    const one = await commitOn(fake, root, "one");
    const side = await commitOn(fake, root, "side");
    const path = `${ROOT}/git/refs/heads/main`;

    expect((await send(fake, "PATCH", path, { sha: one })).status).toBe(200);
    expect(await send(fake, "PATCH", path, { sha: side })).toEqual(
      invalid("Update is not a fast forward"),
    );
    expect(await send(fake, "PATCH", path, { sha: side, force: true })).toMatchObject({
      status: 200,
      body: { object: { sha: side } },
    });
    expect(await headOf(fake)).toBe(side);
  });

  it("refuses to move a branch it does not have or to an unknown commit", async () => {
    const fake = repoFake();
    const head = await headOf(fake);
    expect(await send(fake, "PATCH", `${ROOT}/git/refs/heads/nope`, { sha: head })).toEqual(
      invalid("Reference does not exist"),
    );
    expect(await send(fake, "PATCH", `${ROOT}/git/refs/heads/main`, { sha: "nope" })).toEqual(
      invalid("Object does not exist"),
    );
  });

  it("deletes a branch but not the default branch or one it does not have", async () => {
    const fake = repoFake();
    const head = await headOf(fake);
    await send(fake, "POST", `${ROOT}/git/refs`, { ref: "refs/heads/old", sha: head });
    const old = `${ROOT}/git/refs/heads/old`;

    expect(await send(fake, "DELETE", old)).toEqual({ status: 204, body: null });
    expect(await send(fake, "DELETE", old)).toEqual(invalid("Reference does not exist"));
    expect(await send(fake, "DELETE", `${ROOT}/git/refs/heads/main`)).toEqual(
      invalid("Cannot delete the default branch"),
    );
  });
});

describe("FakeGithub rulesets", () => {
  it("creates rulesets with unique names and lists them in creation order", async () => {
    const fake = repoFake();
    const path = `${ROOT}/rulesets`;
    expect(await send(fake, "POST", path, { target: "branch" })).toEqual(
      invalid("Name can't be blank"),
    );
    const b = await send<{ id: number }>(fake, "POST", path, {
      name: "b",
      target: "branch",
      enforcement: "active",
      rules: [],
      extra: 1,
    });
    const a = await send<{ id: number }>(fake, "POST", path, { name: "a" });

    expect(b.status).toBe(201);
    expect(b.body).toEqual({
      id: b.body.id,
      name: "b",
      target: "branch",
      enforcement: "active",
      rules: [],
      source_type: "Repository",
      source: "acme/oxagen-support",
    });
    expect(await send(fake, "POST", path, { name: "b" })).toEqual(invalid("Name must be unique"));
    expect((await send(fake, "GET", path)).body).toEqual([
      { id: b.body.id, name: "b", source_type: "Repository" },
      { id: a.body.id, name: "a", source_type: "Repository" },
    ]);
  });

  it("reads a ruleset by id and merges the fields a PUT sends", async () => {
    const fake = repoFake();
    const made = await send<{ id: number }>(fake, "POST", `${ROOT}/rulesets`, {
      name: "steer",
      target: "branch",
      enforcement: "active",
    });
    await send(fake, "POST", `${ROOT}/rulesets`, { name: "other" });
    const path = `${ROOT}/rulesets/${made.body.id}`;

    expect(await send(fake, "PUT", path, { name: "other" })).toEqual(invalid("Name must be unique"));
    const renamed = await send(fake, "PUT", path, { name: "steer v2", enforcement: "evaluate" });
    expect(renamed.body).toMatchObject({ name: "steer v2", target: "branch", enforcement: "evaluate" });
    const kept = await send(fake, "PUT", path, { enforcement: "active" });
    expect(kept.body).toMatchObject({ name: "steer v2", target: "branch", enforcement: "active" });
    expect((await send(fake, "GET", path)).body).toEqual(kept.body);
  });

  it("answers 404 for a ruleset id it does not have", async () => {
    const fake = repoFake();
    expect(await send(fake, "GET", `${ROOT}/rulesets/999`)).toEqual(NOT_FOUND);
    expect(await send(fake, "PUT", `${ROOT}/rulesets/999`, { name: "x" })).toEqual(NOT_FOUND);
  });
});

describe("FakeGithub environments", () => {
  it("creates an environment on PUT and keeps its policy until a PUT names one", async () => {
    const fake = repoFake();
    const path = `${ROOT}/environments/steering`;
    const custom = { protected_branches: false, custom_branch_policies: true };

    expect(await send(fake, "GET", path)).toEqual(NOT_FOUND);
    const made = await send<{ id: number }>(fake, "PUT", path, {});
    expect(made.body).toEqual({
      id: made.body.id,
      name: "steering",
      deployment_branch_policy: null,
      protection_rules: [],
    });
    await send(fake, "PUT", path, { deployment_branch_policy: custom });
    expect((await send(fake, "PUT", path, { wait_timer: 0 })).body).toMatchObject({
      id: made.body.id,
      deployment_branch_policy: custom,
    });
    expect(
      (await send(fake, "PUT", path, { deployment_branch_policy: { protected_branches: "yes" } }))
        .body,
    ).toMatchObject({
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: false },
    });
    await send(fake, "PUT", path, { deployment_branch_policy: null });
    expect((await send(fake, "GET", path)).body).toMatchObject({ deployment_branch_policy: null });
  });

  it("answers 404 for the branch policies of an environment it does not have", async () => {
    const fake = repoFake();
    const policies = `${ROOT}/environments/steering/deployment-branch-policies`;
    expect(await send(fake, "GET", policies)).toEqual(NOT_FOUND);
    expect(await send(fake, "POST", policies, { name: "main" })).toEqual(NOT_FOUND);
    expect(await send(fake, "DELETE", `${policies}/1`)).toEqual(NOT_FOUND);
  });

  it("adds, lists, and deletes branch policies", async () => {
    const fake = repoFake();
    const env = `${ROOT}/environments/steering`;
    const policies = `${env}/deployment-branch-policies`;
    await send(fake, "PUT", env, {});

    expect(await send(fake, "POST", policies, {})).toEqual(invalid("name is missing"));
    const main = await send<{ id: number }>(fake, "POST", policies, { name: "main" });
    expect(main).toEqual({ status: 200, body: { id: main.body.id, name: "main", type: "branch" } });
    expect(await send(fake, "POST", policies, { name: "main", type: "branch" })).toEqual({
      status: 303,
      body: { message: "The branch policy already exists." },
    });
    const tag = await send<{ id: number }>(fake, "POST", policies, { name: "main", type: "tag" });
    expect(tag.status).toBe(200);
    expect((await send(fake, "GET", policies)).body).toEqual({
      total_count: 2,
      branch_policies: [main.body, tag.body],
    });

    expect(await send(fake, "DELETE", `${policies}/999`)).toEqual(NOT_FOUND);
    expect(await send(fake, "DELETE", `${policies}/${main.body.id}`)).toEqual({
      status: 204,
      body: null,
    });
    expect((await send(fake, "GET", policies)).body).toEqual({
      total_count: 1,
      branch_policies: [tag.body],
    });
  });
});

describe("FakeGithub deployments", () => {
  it("deploys a branch head to production by default and creates the environment", async () => {
    const fake = repoFake();
    const head = await headOf(fake);
    const res = await send(fake, "POST", `${ROOT}/deployments`, { ref: "main" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      sha: head,
      ref: "main",
      environment: "production",
      payload: {},
      description: "",
      creator: { login: "oxagen-steering[bot]", type: "Bot" },
      performed_via_github_app: { id: 4242, slug: "oxagen-steering" },
    });
    expect(await send(fake, "GET", `${ROOT}/environments/production`)).toMatchObject({
      status: 200,
      body: { deployment_branch_policy: null },
    });
  });

  it("deploys a commit by its sha and names the user who deployed it", async () => {
    const fake = repoFake();
    const head = await headOf(fake);
    const res = await send(
      fake,
      "POST",
      `${ROOT}/deployments`,
      { ref: head, environment: "steering", payload: { version: 3 }, description: "Version 3" },
      "user-token",
    );
    expect(res.body).toMatchObject({
      sha: head,
      ref: head,
      environment: "steering",
      payload: { version: 3 },
      description: "Version 3",
      creator: { login: "fake-owner", type: "User" },
      performed_via_github_app: null,
    });
  });

  it("refuses a ref it cannot resolve", async () => {
    const fake = repoFake();
    expect(await send(fake, "POST", `${ROOT}/deployments`, { ref: "nope" })).toEqual({
      status: 422,
      body: { message: "No ref found for: nope" },
    });
    expect(await send(fake, "POST", `${ROOT}/deployments`, {})).toEqual({
      status: 422,
      body: { message: "No ref found for: " },
    });
  });

  it("lists deployments newest first, by environment, one page at a time", async () => {
    const fake = repoFake();
    const ids: number[] = [];
    for (let i = 0; i < 31; i++) {
      const environment = i === 0 ? "steering" : "production";
      const res = await send<{ id: number }>(fake, "POST", `${ROOT}/deployments`, {
        ref: "main",
        environment,
      });
      ids.push(res.body.id);
    }
    const idsOf = async (query: string) =>
      (await send<{ id: number }[]>(fake, "GET", `${ROOT}/deployments${query}`)).body.map(
        (d) => d.id,
      );

    const newestThirty = ids.slice(1).reverse();
    expect(await idsOf("")).toEqual(newestThirty);
    expect(await idsOf("?per_page=0")).toEqual(newestThirty);
    expect(await idsOf("?per_page=many")).toEqual(newestThirty);
    expect(await idsOf("?per_page=100")).toHaveLength(31);
    expect(await idsOf("?per_page=2")).toEqual([ids[30], ids[29]]);
    expect(await idsOf("?environment=steering")).toEqual([ids[0]]);
  });

  it("records statuses newest first and fills in their defaults", async () => {
    const fake = repoFake();
    const deployment = await send<{ id: number }>(fake, "POST", `${ROOT}/deployments`, {
      ref: "main",
      environment: "steering",
    });
    const statuses = `${ROOT}/deployments/${deployment.body.id}/statuses`;

    expect(await send(fake, "POST", statuses, { state: "bogus" })).toEqual(
      invalid("state bogus is not valid"),
    );
    expect(await send(fake, "POST", statuses, {})).toEqual(invalid("state  is not valid"));
    expect(await send(fake, "POST", statuses, { state: "pending" })).toMatchObject({
      status: 201,
      body: { state: "pending", environment: "steering", description: "" },
    });
    await send(fake, "POST", statuses, {
      state: "success",
      environment: "elsewhere",
      description: "Done",
    });

    const list = await send<{ state: string; environment: string }[]>(fake, "GET", statuses);
    expect(list.body.map((s) => [s.state, s.environment])).toEqual([
      ["success", "elsewhere"],
      ["pending", "steering"],
    ]);
    expect((await send<unknown[]>(fake, "GET", `${statuses}?per_page=1`)).body).toHaveLength(1);
  });

  it("answers 404 for the statuses of a deployment it does not have", async () => {
    const fake = repoFake();
    const statuses = `${ROOT}/deployments/999/statuses`;
    expect(await send(fake, "GET", statuses)).toEqual(NOT_FOUND);
    expect(await send(fake, "POST", statuses, { state: "success" })).toEqual(NOT_FOUND);
  });
});

describe("FakeGithub.snapshot", () => {
  /** Configure the steering environment, two rulesets, and one deployment. */
  async function steer(fake: FakeGithub, detour: boolean): Promise<number> {
    const env = `${ROOT}/environments/steering`;
    const policies = `${env}/deployment-branch-policies`;
    await send(fake, "PUT", env, {
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    });
    if (detour) {
      // A policy made and then deleted takes an id, so the ids of the two runs differ.
      const extra = await send<{ id: number }>(fake, "POST", policies, { name: "tmp" });
      await send(fake, "DELETE", `${policies}/${extra.body.id}`);
    }
    await send(fake, "POST", policies, { name: "v*", type: "tag" });
    await send(fake, "POST", policies, { name: "main" });
    await send(fake, "POST", `${ROOT}/rulesets`, { name: "zeta", enforcement: "active" });
    await send(fake, "POST", `${ROOT}/rulesets`, { name: "alpha", enforcement: "evaluate" });
    const deployment = await send<{ id: number }>(fake, "POST", `${ROOT}/deployments`, {
      ref: "main",
      environment: "steering",
      payload: { version: 1 },
    });
    await send(fake, "POST", `${ROOT}/deployments/${deployment.body.id}/statuses`, {
      state: "success",
    });
    return deployment.body.id;
  }

  it("leaves out ids, so two runs that make the same changes compare equal", async () => {
    const plain = repoFake();
    const detoured = repoFake();
    const plainId = await steer(plain, false);
    const detouredId = await steer(detoured, true);

    expect(detouredId).not.toBe(plainId);
    expect(detoured.snapshot()).toEqual(plain.snapshot());
  });

  it("sorts rulesets by name and branch policies by type and name", async () => {
    const fake = repoFake();
    await steer(fake, false);
    const head = await headOf(fake);

    expect(fake.snapshot()).toEqual({
      org: "acme",
      repositories: {
        "oxagen-support": {
          name: "oxagen-support",
          description: "",
          private: true,
          visibility: "private",
          default_branch: "main",
          branches: { main: head },
          files: { main: { "README.md": "# oxagen-support\n" } },
          merge: {
            allow_squash_merge: true,
            allow_merge_commit: true,
            allow_rebase_merge: true,
            delete_branch_on_merge: false,
          },
          actions_enabled: true,
          rulesets: [
            { name: "alpha", enforcement: "evaluate" },
            { name: "zeta", enforcement: "active" },
          ],
          environments: {
            steering: {
              deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
              branch_policies: ["branch:main", "tag:v*"],
            },
          },
          deployments: [
            {
              sha: head,
              ref: "main",
              environment: "steering",
              payload: { version: 1 },
              description: "",
              latest_status: "success",
            },
          ],
          in_installation: true,
        },
      },
    });
  });
});

describe("EXAMPLE_GITHUB_BASELINE", () => {
  it("is the baseline module's value, re-exported beside the fake", () => {
    expect(EXAMPLE_GITHUB_BASELINE).toBe(BASELINE);
    expect(Object.keys(EXAMPLE_GITHUB_BASELINE.rulesets)).toEqual([
      "oxagen_steering",
      "oxagen_merges",
    ]);
    expect(EXAMPLE_GITHUB_BASELINE.environments.steering).toEqual({
      deployment_branches: ["main"],
      deployed_by: "oxagen-steering",
    });
  });
});
