import { describe, expect, it } from "vitest";
import { createGitlabRest, SteeringGitlabReauthorizeError } from "../http";
import { EXAMPLE_GITLAB_BASELINE, FakeGitlab } from "./fake-gitlab";

const GROUP = { id: 7, full_path: "acme" };
const BOT = { user_id: 99, username: "group_7_bot" };
const API = "https://gitlab.com/api/v4";

interface Answer {
  status: number;
  body: unknown;
}

/** Send one raw request to the fake and read its status and parsed body. */
async function send(
  fake: FakeGitlab,
  method: string,
  path: string,
  body?: unknown,
  token = "group-token",
): Promise<Answer> {
  const res = await fake.fetch(`${API}${path}`, {
    method,
    headers: { "PRIVATE-TOKEN": token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text === "" ? null : (JSON.parse(text) as unknown),
  };
}

function newFake(): FakeGitlab {
  return new FakeGitlab({ group: GROUP, bot: BOT });
}

/** A fake holding one project, `acme/steering`, whose main branch holds `files`. */
async function withMain(
  files: Record<string, string> = { "README.md": "hello\n" },
): Promise<{ fake: FakeGitlab; id: number; sha: string }> {
  const fake = newFake();
  const id = fake.seedProject({ name: "steering" });
  const actions = Object.entries(files).map(([file_path, content]) => ({
    action: "create",
    file_path,
    content,
  }));
  const res = await send(fake, "POST", `/projects/${id}/repository/commits`, {
    branch: "main",
    commit_message: "seed",
    actions,
  });
  expect(res.status).toBe(201);
  return { fake, id, sha: (res.body as { id: string }).id };
}

function paths(body: unknown): { path: string; type: string }[] {
  return (body as { path: string; type: string }[]).map(({ path, type }) => ({
    path,
    type,
  }));
}

describe("FakeGitlab requests", () => {
  it("answers 404 for a route it does not know", async () => {
    const fake = newFake();
    expect(await send(fake, "GET", "/projects/1/wikis")).toEqual({
      status: 404,
      body: { message: "fake gitlab has no route for GET /projects/1/wikis" },
    });
    expect((await send(fake, "PATCH", "/user")).status).toBe(404);
  });

  it("answers 401 to a wrong token and to the group token after it is revoked", async () => {
    const fake = newFake();
    expect(await send(fake, "GET", "/user", undefined, "stolen")).toEqual({
      status: 401,
      body: { message: "401 Unauthorized" },
    });
    await expect(fake.rest("stolen").request("GET", "/user")).rejects.toBeInstanceOf(
      SteeringGitlabReauthorizeError,
    );
    expect((await fake.rest().request("GET", "/user")).status).toBe(200);
    fake.revokeToken();
    await expect(fake.rest().request("GET", "/user")).rejects.toBeInstanceOf(
      SteeringGitlabReauthorizeError,
    );
  });

  it("uses the token it was given", async () => {
    const fake = new FakeGitlab({ group: GROUP, bot: BOT, token: "glpat-steering" });
    expect((await fake.rest().request("GET", "/user")).status).toBe(200);
    expect((await send(fake, "GET", "/user", undefined, "glpat-steering")).status).toBe(
      200,
    );
    expect((await send(fake, "GET", "/user")).status).toBe(401);
  });

  it("reads the path after /api/v4 behind a path prefix", async () => {
    const fake = newFake();
    const rest = createGitlabRest({
      token: "group-token",
      baseUrl: "https://git.example.com/gitlab/",
      fetch: fake.fetch,
    });
    const res = await rest.request<{ id: number }>("GET", "/user");
    expect(res.data).toEqual({ id: 99, username: "group_7_bot", bot: true });
    expect(fake.calls).toEqual([{ method: "GET", path: "/user" }]);
  });

  it("logs every call with its query and an upper case method", async () => {
    const fake = newFake();
    await send(fake, "get", "/groups/7?with_projects=false");
    await send(fake, "GET", "/nowhere?a=1");
    expect(fake.calls).toEqual([
      { method: "GET", path: "/groups/7?with_projects=false" },
      { method: "GET", path: "/nowhere?a=1" },
    ]);
  });
});

describe("FakeGitlab groups and projects", () => {
  it("finds the group by id or full path", async () => {
    const fake = newFake();
    const found = { status: 200, body: { id: 7, full_path: "acme" } };
    expect(await send(fake, "GET", "/groups/7")).toEqual(found);
    expect(await send(fake, "GET", "/groups/acme")).toEqual(found);
    expect(await send(fake, "GET", "/groups/8")).toEqual({
      status: 404,
      body: { message: "404 Group Not Found" },
    });
  });

  it("finds a project by id or by its path in any case", async () => {
    const fake = newFake();
    const id = fake.seedProject({ name: "steering" });
    expect(id).toBe(1);
    const byId = await send(fake, "GET", "/projects/1");
    expect(byId.body).toMatchObject({
      id: 1,
      name: "steering",
      path: "steering",
      path_with_namespace: "acme/steering",
      description: "",
      visibility: "private",
      default_branch: null,
      empty_repo: true,
      namespace: { id: 7, full_path: "acme", kind: "group" },
    });
    expect((await send(fake, "GET", "/projects/ACME%2FSteering")).body).toEqual(byId.body);
    expect(await send(fake, "GET", "/projects/acme%2Fother")).toEqual({
      status: 404,
      body: { message: "404 Project Not Found" },
    });
  });

  it("creates a project and answers 201", async () => {
    const fake = newFake();
    const created = await send(fake, "POST", "/projects", {
      name: "Steering Rules",
      path: "steering-rules",
      namespace_id: 7,
      description: "rules",
      visibility: "internal",
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: "Steering Rules",
      path: "steering-rules",
      path_with_namespace: "acme/steering-rules",
      visibility: "internal",
    });
    const bare = await send(fake, "POST", "/projects", { name: "bare", namespace_id: 7 });
    expect(bare.body).toMatchObject({ path: "bare", visibility: "private", description: "" });
  });

  it("refuses a project create with a missing, invalid, or taken field", async () => {
    const fake = newFake();
    fake.seedProject({ name: "steering" });
    const before = fake.snapshot();
    expect(await send(fake, "POST", "/projects", { namespace_id: 7 })).toEqual({
      status: 400,
      body: { error: "name is missing" },
    });
    expect(await send(fake, "POST", "/projects", { name: "x" })).toEqual({
      status: 400,
      body: { error: "namespace_id is missing" },
    });
    expect(
      await send(fake, "POST", "/projects", { name: "x", namespace_id: 7, visibility: "secret" }),
    ).toEqual({ status: 400, body: { error: "visibility does not have a valid value" } });
    expect(await send(fake, "POST", "/projects", { name: "x", namespace_id: 8 })).toEqual({
      status: 400,
      body: { message: { namespace: ["is not valid"] } },
    });
    const taken = {
      status: 400,
      body: {
        message: { name: ["has already been taken"], path: ["has already been taken"] },
      },
    };
    expect(await send(fake, "POST", "/projects", { name: "Steering", namespace_id: 7 })).toEqual(
      taken,
    );
    expect(
      await send(fake, "POST", "/projects", { name: "other", path: "STEERING", namespace_id: 7 }),
    ).toEqual(taken);
    expect(fake.snapshot()).toEqual(before);
  });

  it("updates each project field it is sent and leaves the rest", async () => {
    const fake = newFake();
    fake.seedProject({ name: "steering", description: "old" });
    const untouched = fake.snapshot();
    expect((await send(fake, "PUT", "/projects/1", {})).status).toBe(200);
    expect(fake.snapshot()).toEqual(untouched);

    const res = await send(fake, "PUT", "/projects/1", {
      visibility: "internal",
      description: "new",
      default_branch: "trunk",
      squash_option: "never",
      only_allow_merge_if_pipeline_succeeds: true,
      remove_source_branch_after_merge: false,
      builds_access_level: "private",
    });
    expect(res.status).toBe(200);
    expect(fake.snapshot().projects["acme/steering"]).toMatchObject({
      description: "new",
      visibility: "internal",
      default_branch: "trunk",
      settings: {
        squash_option: "never",
        only_allow_merge_if_pipeline_succeeds: true,
        remove_source_branch_after_merge: false,
        builds_access_level: "private",
      },
    });
  });

  it("keeps approvals on push until the project turns on reset", async () => {
    const fake = newFake();
    fake.seedProject({ name: "steering" });
    expect(await send(fake, "GET", "/projects/1/approvals")).toMatchObject({
      status: 200,
      body: { reset_approvals_on_push: false },
    });
    const res = await send(fake, "POST", "/projects/1/approvals", {
      reset_approvals_on_push: true,
    });
    expect(res).toMatchObject({ status: 200, body: { reset_approvals_on_push: true } });
    expect(fake.snapshot().projects["acme/steering"]?.settings.reset_approvals_on_push).toBe(
      true,
    );
    expect((await send(fake, "GET", "/projects/9/approvals")).status).toBe(404);
  });

  it.each([
    [{ visibility: "secret" }, "visibility does not have a valid value"],
    [{ squash_option: "sometimes" }, "squash_option does not have a valid value"],
    [{ builds_access_level: 1 }, "builds_access_level does not have a valid value"],
  ])("refuses the update %j", async (body, error) => {
    const fake = newFake();
    fake.seedProject({ name: "steering" });
    const before = fake.snapshot();
    expect(await send(fake, "PUT", "/projects/1", body)).toEqual({ status: 400, body: { error } });
    expect(fake.snapshot()).toEqual(before);
  });
});

describe("FakeGitlab repository", () => {
  it("reports a branch head and 404 for a missing branch", async () => {
    const { fake, sha } = await withMain();
    expect(await send(fake, "GET", "/projects/1/repository/branches/main")).toEqual({
      status: 200,
      body: {
        name: "main",
        commit: { id: sha, short_id: sha.slice(0, 8) },
        protected: false,
        default: true,
      },
    });
    expect(await send(fake, "GET", "/projects/1/repository/branches/dev")).toEqual({
      status: 404,
      body: { message: "404 Branch Not Found" },
    });
  });

  it("lists the tree of the default branch, one level or every level, a page at a time", async () => {
    const { fake } = await withMain({
      "README.md": "a",
      "docs/guide.md": "b",
      "docs/deep/x.md": "c",
    });
    const top = await send(fake, "GET", "/projects/1/repository/tree");
    expect(paths(top.body)).toEqual([
      { path: "README.md", type: "blob" },
      { path: "docs", type: "tree" },
    ]);
    const all = await send(fake, "GET", "/projects/1/repository/tree?ref=main&recursive=true");
    expect(paths(all.body)).toEqual([
      { path: "README.md", type: "blob" },
      { path: "docs", type: "tree" },
      { path: "docs/deep", type: "tree" },
      { path: "docs/deep/x.md", type: "blob" },
      { path: "docs/guide.md", type: "blob" },
    ]);
    expect(all.body).toContainEqual(
      expect.objectContaining({ name: "x.md", path: "docs/deep/x.md", mode: "100644" }),
    );
    const second = await send(
      fake,
      "GET",
      "/projects/1/repository/tree?ref=main&recursive=true&per_page=2&page=2",
    );
    expect(paths(second.body)).toEqual([
      { path: "docs/deep", type: "tree" },
      { path: "docs/deep/x.md", type: "blob" },
    ]);
  });

  it("answers 404 for the tree of a missing branch or an empty project", async () => {
    const { fake } = await withMain();
    const missing = { status: 404, body: { message: "404 Tree Not Found" } };
    expect(await send(fake, "GET", "/projects/1/repository/tree?ref=dev")).toEqual(missing);
    fake.seedProject({ name: "empty" });
    expect(await send(fake, "GET", "/projects/2/repository/tree")).toEqual(missing);
  });

  it("reads a file as base64 and refuses a missing ref, branch, or file", async () => {
    const { fake, sha } = await withMain({ "docs/guide.md": '{"a":1}\n' });
    const res = await send(fake, "GET", "/projects/1/repository/files/docs%2Fguide.md?ref=main");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      file_name: "guide.md",
      file_path: "docs/guide.md",
      encoding: "base64",
      ref: "main",
      commit_id: sha,
    });
    const content = (res.body as { content: string }).content;
    expect(Buffer.from(content, "base64").toString("utf8")).toBe('{"a":1}\n');

    expect(await send(fake, "GET", "/projects/1/repository/files/docs%2Fguide.md")).toEqual({
      status: 400,
      body: { error: "ref is missing" },
    });
    const missing = { status: 404, body: { message: "404 File Not Found" } };
    expect(await send(fake, "GET", "/projects/1/repository/files/nope.md?ref=main")).toEqual(
      missing,
    );
    expect(await send(fake, "GET", "/projects/1/repository/files/docs%2Fguide.md?ref=dev")).toEqual(
      missing,
    );
  });

  it("links a commit to its parent and titles it with the first line", async () => {
    const { fake, sha } = await withMain();
    const res = await send(fake, "POST", "/projects/1/repository/commits", {
      branch: "main",
      commit_message: "Add rules\n\nWith a body.",
      actions: [
        { action: "update", file_path: "README.md", content: "changed\n" },
        { action: "create", file_path: "rules.md", content: "rule\n" },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ title: "Add rules", parent_ids: [sha] });
    const del = await send(fake, "POST", "/projects/1/repository/commits", {
      branch: "main",
      commit_message: "Remove rules",
      actions: [{ action: "delete", file_path: "rules.md" }],
    });
    expect(del.status).toBe(201);
    expect(fake.snapshot().projects["acme/steering"]?.branches.main?.files).toEqual({
      "README.md": "changed\n",
    });
  });

  it.each([
    [{ commit_message: "m", actions: [] }, { error: "branch is missing" }],
    [{ branch: "main", actions: [] }, { error: "commit_message is missing" }],
    [{ branch: "main", commit_message: "m" }, { error: "actions is missing" }],
    [
      { branch: "dev", commit_message: "m", actions: [] },
      { message: "You can only create or edit files when you are on a branch" },
    ],
    [
      {
        branch: "main",
        commit_message: "m",
        actions: [
          { action: "create", file_path: "new.md", content: "n" },
          { action: "create", file_path: "README.md", content: "x" },
        ],
      },
      { message: "A file with this name already exists" },
    ],
    [
      { branch: "main", commit_message: "m", actions: [{ action: "update", file_path: "nope.md", content: "x" }] },
      { message: "A file with this name doesn't exist" },
    ],
    [
      { branch: "main", commit_message: "m", actions: [{ action: "delete", file_path: "nope.md" }] },
      { message: "A file with this name doesn't exist" },
    ],
    [
      { branch: "main", commit_message: "m", actions: [{ action: "move", file_path: "README.md" }] },
      { error: "actions[action] does not have a valid value" },
    ],
  ])("refuses the commit %j and changes nothing", async (body, answer) => {
    const { fake } = await withMain();
    const before = fake.snapshot();
    expect(await send(fake, "POST", "/projects/1/repository/commits", body)).toEqual({
      status: 400,
      body: answer,
    });
    expect(fake.snapshot()).toEqual(before);
  });

  it.each([
    [{ push_access_level: 0 }, false],
    [{ push_access_level: 60 }, false],
    [{ push_access_level: 0, allowed_to_push: [{ group_id: 3 }] }, false],
    [{ push_access_level: 30 }, true],
    [{ push_access_level: 40 }, true],
    [{ push_access_level: 0, allowed_to_push: [{ user_id: 99 }] }, true],
  ])("lets the bot push to a branch protected with %j only when a rule allows it", async (rule, allowed) => {
    const { fake } = await withMain();
    expect(
      (await send(fake, "POST", "/projects/1/protected_branches", { name: "main", ...rule })).status,
    ).toBe(201);
    const res = await send(fake, "POST", "/projects/1/repository/commits", {
      branch: "main",
      commit_message: "push",
      actions: [{ action: "update", file_path: "README.md", content: "pushed\n" }],
    });
    const refused = {
      status: 403,
      body: { message: "403 Forbidden - You are not allowed to push into this branch" },
    };
    expect(res).toEqual(allowed ? expect.objectContaining({ status: 201 }) : refused);
    const files = fake.snapshot().projects["acme/steering"]?.branches.main?.files;
    expect(files).toEqual({ "README.md": allowed ? "pushed\n" : "hello\n" });
  });
});

describe("FakeGitlab protected branches", () => {
  it("protects a branch at Maintainers when the request names no level", async () => {
    const { fake } = await withMain();
    const res = await send(fake, "POST", "/projects/1/protected_branches", { name: "main" });
    const maintainers = [{ access_level: 40, user_id: null, group_id: null }];
    expect(res).toEqual({
      status: 201,
      body: {
        id: 1,
        name: "main",
        push_access_levels: maintainers,
        merge_access_levels: maintainers,
        allow_force_push: false,
        code_owner_approval_required: false,
      },
    });
  });

  it("keeps the level entry beside each user, group, and level grant", async () => {
    const { fake } = await withMain();
    await send(fake, "POST", "/projects/1/protected_branches", {
      name: "release/*",
      push_access_level: 0,
      merge_access_level: 30,
      allowed_to_merge: [{ user_id: 5 }, { group_id: 3 }, { access_level: 60 }, {}],
      allow_force_push: true,
    });
    expect(fake.snapshot().projects["acme/steering"]?.protected_branches).toEqual({
      "release/*": {
        push_access_levels: [{ access_level: 0, user_id: null, group_id: null }],
        merge_access_levels: [
          { access_level: 30, user_id: null, group_id: null },
          { access_level: 40, user_id: 5, group_id: null },
          { access_level: 40, user_id: null, group_id: 3 },
          { access_level: 60, user_id: null, group_id: null },
        ],
        allow_force_push: true,
      },
    });
    const listed = await send(fake, "GET", "/projects/1/protected_branches?per_page=100");
    expect(listed.body).toEqual([expect.objectContaining({ name: "release/*" })]);
  });

  it("refuses a duplicate or nameless protection and deletes by name", async () => {
    const { fake } = await withMain();
    await send(fake, "POST", "/projects/1/protected_branches", { name: "release/*" });
    expect(await send(fake, "POST", "/projects/1/protected_branches", { name: "release/*" })).toEqual({
      status: 409,
      body: { message: "Protected branch 'release/*' already exists" },
    });
    expect(await send(fake, "POST", "/projects/1/protected_branches", {})).toEqual({
      status: 400,
      body: { error: "name is missing" },
    });
    expect(await send(fake, "DELETE", "/projects/1/protected_branches/release%2F*")).toEqual({
      status: 204,
      body: null,
    });
    expect(await send(fake, "DELETE", "/projects/1/protected_branches/release%2F*")).toEqual({
      status: 404,
      body: { message: "404 Protected Branch Not Found" },
    });
  });
});

describe("FakeGitlab deployments", () => {
  async function withDeployments(): Promise<FakeGitlab> {
    const { fake } = await withMain();
    for (const [environment, sha, status] of [
      ["steering", "aaa", "running"],
      ["review", "bbb", "success"],
      ["steering", "ccc", "failed"],
    ] as const) {
      const res = await send(fake, "POST", "/projects/1/deployments", {
        environment,
        sha,
        ref: "main",
        tag: false,
        status,
      });
      expect(res.status).toBe(201);
    }
    return fake;
  }

  it("lists every deployment in id order, or one environment newest first", async () => {
    const fake = await withDeployments();
    const all = await send(fake, "GET", "/projects/1/deployments");
    expect(all.body).toEqual([
      { id: 1, iid: 1, ref: "main", sha: "aaa", status: "running", environment: { name: "steering" } },
      { id: 2, iid: 2, ref: "main", sha: "bbb", status: "success", environment: { name: "review" } },
      { id: 3, iid: 3, ref: "main", sha: "ccc", status: "failed", environment: { name: "steering" } },
    ]);
    const steering = await send(
      fake,
      "GET",
      "/projects/1/deployments?environment=steering&order_by=id&sort=desc",
    );
    expect((steering.body as { id: number }[]).map((d) => d.id)).toEqual([3, 1]);
  });

  it("refuses a deployment with a missing field or an unknown status", async () => {
    const fake = await withDeployments();
    const base = { environment: "steering", sha: "ddd", ref: "main", tag: false, status: "success" };
    expect(await send(fake, "POST", "/projects/1/deployments", { ...base, tag: undefined })).toEqual({
      status: 400,
      body: { error: "tag is missing" },
    });
    expect(await send(fake, "POST", "/projects/1/deployments", { ...base, status: "done" })).toEqual({
      status: 400,
      body: { error: "status does not have a valid value" },
    });
  });

  it("sets a deployment status and refuses a missing deployment or status", async () => {
    const fake = await withDeployments();
    const res = await send(fake, "PUT", "/projects/1/deployments/1", { status: "success" });
    expect(res.body).toMatchObject({ id: 1, status: "success" });
    expect(await send(fake, "PUT", "/projects/1/deployments/42", { status: "success" })).toEqual({
      status: 404,
      body: { message: "404 Deployment Not Found" },
    });
    expect(await send(fake, "PUT", "/projects/1/deployments/1", {})).toEqual({
      status: 400,
      body: { error: "status is missing" },
    });
    expect(await send(fake, "PUT", "/projects/1/deployments/1", { status: "done" })).toEqual({
      status: 400,
      body: { error: "status does not have a valid value" },
    });
  });
});

describe("FakeGitlab failure injection", () => {
  it("fails a matching request the given number of times, with a default message", async () => {
    const fake = newFake();
    fake.failNext({ path: "/user", status: 503, times: 2 });
    const failed = { status: 503, body: { message: "fake gitlab failed GET /user" } };
    expect(await send(fake, "GET", "/user")).toEqual(failed);
    expect(await send(fake, "GET", "/user")).toEqual(failed);
    expect((await send(fake, "GET", "/user")).status).toBe(200);
  });

  it("matches the method in any case and leaves other methods alone", async () => {
    const fake = newFake();
    fake.seedProject({ name: "steering" });
    fake.failNext({ method: "put", path: "/projects/1", status: 500, message: "boom" });
    expect((await send(fake, "GET", "/projects/1")).status).toBe(200);
    expect(await send(fake, "PUT", "/projects/1", { visibility: "public" })).toEqual({
      status: 500,
      body: { message: "boom" },
    });
    expect(fake.snapshot().projects["acme/steering"]?.visibility).toBe("private");
  });

  it("matches a RegExp against the path as sent", async () => {
    const { fake } = await withMain();
    fake.failNext({ path: /\/projects\/acme%2Fsteering$/, status: 502 });
    expect((await send(fake, "GET", "/projects/1")).status).toBe(200);
    expect((await send(fake, "GET", "/projects/acme%2Fsteering")).status).toBe(502);
  });

  it("matches a string path as sent or with each segment decoded", async () => {
    const { fake } = await withMain();
    fake.failNext({ path: "/projects/acme/steering", status: 500 });
    fake.failNext({ path: "/projects/1/repository/files/docs%2Fa.md", status: 500 });
    expect((await send(fake, "GET", "/projects/acme%2Fsteering")).status).toBe(500);
    expect((await send(fake, "GET", "/projects/1/repository/files/docs%2Fa.md?ref=main")).status).toBe(
      500,
    );
  });

  it("applies the request before failing when the rule says after", async () => {
    const fake = newFake();
    fake.seedProject({ name: "steering" });
    fake.failNext({ method: "PUT", path: "/projects/1", status: 502, after: true });
    expect((await send(fake, "PUT", "/projects/1", { visibility: "internal" })).status).toBe(502);
    expect(fake.snapshot().projects["acme/steering"]?.visibility).toBe("internal");
    expect(fake.writes()).toEqual([{ method: "PUT", path: "/projects/1" }]);

    fake.failNext({ method: "PUT", path: "/projects/1", status: 502, after: true });
    expect((await send(fake, "PUT", "/projects/1", { visibility: "secret" })).status).toBe(502);
    expect(fake.writes()).toHaveLength(1);
  });

  it("records only the writes it applied", async () => {
    const fake = newFake();
    await send(fake, "GET", "/user");
    await send(fake, "POST", "/projects", { name: "steering", namespace_id: 7 });
    await send(fake, "POST", "/projects", { name: "steering", namespace_id: 7 });
    fake.failNext({ method: "PUT", path: "/projects/1", status: 500 });
    await send(fake, "PUT", "/projects/1", { visibility: "public" });
    await send(fake, "POST", "/projects/1/protected_branches?x=1", { name: "main" });
    await send(fake, "DELETE", "/projects/1/protected_branches/main");
    expect(fake.writes()).toEqual([
      { method: "POST", path: "/projects" },
      { method: "POST", path: "/projects/1/protected_branches?x=1" },
      { method: "DELETE", path: "/projects/1/protected_branches/main" },
    ]);
  });
});

describe("FakeGitlab snapshot", () => {
  it("orders projects by path and holds no ids or token", async () => {
    const fake = newFake();
    fake.seedProject({ name: "b-repo" });
    fake.seedProject({ name: "a-repo", description: "first" });
    await send(fake, "POST", "/projects/2/deployments", {
      environment: "steering",
      sha: "bbb",
      ref: "main",
      tag: false,
      status: "success",
    });
    await send(fake, "POST", "/projects/2/deployments", {
      environment: "steering",
      sha: "aaa",
      ref: "main",
      tag: false,
      status: "success",
    });
    const snap = fake.snapshot();
    expect(Object.keys(snap.projects)).toEqual(["acme/a-repo", "acme/b-repo"]);
    const project = snap.projects["acme/a-repo"];
    expect(project?.description).toBe("first");
    expect(project?.deployments.map((d) => d.sha)).toEqual(["aaa", "bbb"]);
    expect(Object.keys(project ?? {}).sort()).toEqual([
      "branches",
      "default_branch",
      "deployments",
      "description",
      "name",
      "path",
      "protected_branches",
      "settings",
      "visibility",
    ]);
    expect(JSON.stringify(snap)).not.toContain("group-token");
  });

  it("gives equal content and message the same sha", async () => {
    const one = await withMain({ "a.md": "a", "b.md": "b" });
    const two = await withMain({ "b.md": "b", "a.md": "a" });
    expect(one.sha).toBe(two.sha);
    expect(one.fake.snapshot()).toEqual(two.fake.snapshot());
    const res = await send(two.fake, "POST", "/projects/1/repository/commits", {
      branch: "main",
      commit_message: "another message",
      actions: [],
    });
    expect((res.body as { id: string }).id).not.toBe(one.sha);
  });

  it("re-exports the example baseline", () => {
    expect(EXAMPLE_GITLAB_BASELINE.protected_branches.main?.merge_access).toBe(
      "oxagen-steering",
    );
    expect(EXAMPLE_GITLAB_BASELINE.ci_cd.builds_access_level).toBe("disabled");
  });
});
