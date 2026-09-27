import { describe, expect, it } from "vitest";
import { GitLabApiError } from "../client";
import { GitLabRateLimitedError, SteeringGitlabReauthorizeError } from "./http";
import type { GitlabResponse, GitlabRest } from "./http";
import {
  candidateName,
  createOrAdoptProject,
  createProject,
  getCurrentUser,
  getGroup,
  getProject,
} from "./project";
import type { CreateOrAdoptProjectInput } from "./project";
import { FakeGitlab } from "./testing/fake-gitlab";

const GROUP = { id: 7, full_path: "acme" };
const MARKER = "oxagen-steering:ws_0192";
const INPUT: CreateOrAdoptProjectInput = {
  group: GROUP,
  base_name: "oxagen-support",
  description: `Steering rules for Oxagen. ${MARKER}`,
  marker: MARKER,
};

function newFake(): FakeGitlab {
  return new FakeGitlab({ group: GROUP, bot: { user_id: 99, username: "group_7_bot" } });
}

/** A rest helper that answers each request with the next response in `answers`. */
function stubRest(answers: GitlabResponse<unknown>[]): GitlabRest {
  return {
    request<T>(): Promise<GitlabResponse<T>> {
      const next = answers.shift();
      if (next === undefined) throw new Error("the stub has no answer left");
      return Promise.resolve(next as GitlabResponse<T>);
    },
  };
}

/** The snapshot of a run that met no failure. */
async function cleanSnapshot(): Promise<ReturnType<FakeGitlab["snapshot"]>> {
  const fake = newFake();
  await createOrAdoptProject(fake.rest(), INPUT);
  return fake.snapshot();
}

describe("candidateName", () => {
  it("adds the attempt number from the second attempt on", () => {
    expect(candidateName("oxagen-support", 0)).toBe("oxagen-support");
    expect(candidateName("oxagen-support", 1)).toBe("oxagen-support");
    expect(candidateName("oxagen-support", 2)).toBe("oxagen-support-2");
    expect(candidateName("oxagen-support", 12)).toBe("oxagen-support-12");
  });
});

describe("createOrAdoptProject", () => {
  it("creates a private project under the base name", async () => {
    const fake = newFake();
    const result = await createOrAdoptProject(fake.rest(), INPUT);
    expect(result).toEqual({
      project: {
        id: 1,
        path_with_namespace: "acme/oxagen-support",
        namespace_path: "acme",
        name: "oxagen-support",
        default_branch: "main",
      },
      attempt: 1,
      adopted: false,
    });
    expect(fake.writes()).toEqual([{ method: "POST", path: "/projects" }]);
    expect(fake.snapshot().projects["acme/oxagen-support"]).toMatchObject({
      description: INPUT.description,
      visibility: "private",
      default_branch: null,
      branches: {},
    });
  });

  it("moves on to the next name when another project holds the base name", async () => {
    const fake = newFake();
    fake.seedProject({ name: "oxagen-support", description: "Owned by someone else." });
    const result = await createOrAdoptProject(fake.rest(), INPUT);
    expect(result.attempt).toBe(2);
    expect(result.adopted).toBe(false);
    expect(result.project).toMatchObject({
      id: 2,
      name: "oxagen-support-2",
      path_with_namespace: "acme/oxagen-support-2",
    });
    expect(fake.snapshot().projects["acme/oxagen-support"]?.description).toBe(
      "Owned by someone else.",
    );
  });

  it("adopts a project whose description carries the marker and writes nothing", async () => {
    const fake = newFake();
    fake.seedProject({ name: "oxagen-support", description: INPUT.description });
    const result = await createOrAdoptProject(fake.rest(), INPUT);
    expect(result).toEqual({
      project: {
        id: 1,
        path_with_namespace: "acme/oxagen-support",
        namespace_path: "acme",
        name: "oxagen-support",
        default_branch: "main",
      },
      attempt: 1,
      adopted: true,
    });
    expect(fake.writes()).toEqual([]);
  });

  it("moves on when the lookup of a taken name finds nothing", async () => {
    const fake = newFake();
    fake.seedProject({ name: "oxagen-support", description: INPUT.description });
    fake.failNext({ method: "GET", path: "/projects/acme/oxagen-support", status: 404 });
    const result = await createOrAdoptProject(fake.rest(), INPUT);
    expect(result).toMatchObject({ attempt: 2, adopted: false });
    expect(result.project.name).toBe("oxagen-support-2");
  });

  it("throws a 400 naming the range when every name is taken", async () => {
    const fake = newFake();
    for (const name of ["oxagen-support", "oxagen-support-2", "oxagen-support-3"])
      fake.seedProject({ name });
    const run = createOrAdoptProject(fake.rest(), { ...INPUT, max_attempts: 3 });
    await expect(run).rejects.toBeInstanceOf(GitLabApiError);
    await expect(run).rejects.toMatchObject({
      status: 400,
      message:
        "GitLab API error 400: Every name from oxagen-support to oxagen-support-3 is taken in acme.",
    });
    expect(fake.writes()).toEqual([]);
  });

  it("tries 20 names by default", async () => {
    const fake = newFake();
    for (let n = 1; n <= 20; n++) fake.seedProject({ name: candidateName("oxagen-support", n) });
    await expect(createOrAdoptProject(fake.rest(), INPUT)).rejects.toThrow(
      "Every name from oxagen-support to oxagen-support-20 is taken in acme.",
    );
    expect(fake.calls.filter((c) => c.method === "POST")).toHaveLength(20);
  });

  it("resumes the count from the first attempt it is given", async () => {
    const fake = newFake();
    const resumed = await createOrAdoptProject(fake.rest(), { ...INPUT, first_attempt: 3 });
    expect(resumed).toMatchObject({ attempt: 3, project: { name: "oxagen-support-3" } });
    const fromZero = await createOrAdoptProject(newFake().rest(), { ...INPUT, first_attempt: 0 });
    expect(fromZero).toMatchObject({ attempt: 1, project: { name: "oxagen-support" } });
  });

  it("reports each attempt before it sends the create", async () => {
    const fake = newFake();
    fake.seedProject({ name: "oxagen-support" });
    const seen: [number, string, number][] = [];
    await createOrAdoptProject(fake.rest(), {
      ...INPUT,
      on_attempt: (attempt, name) => {
        seen.push([attempt, name, fake.calls.length]);
        return Promise.resolve();
      },
    });
    // The first attempt sends a create and a lookup, so the second starts after two calls.
    expect(seen).toEqual([
      [1, "oxagen-support", 0],
      [2, "oxagen-support-2", 2],
    ]);
  });

  it("reaches the clean state on a rerun after the create fails before GitLab applies it", async () => {
    const fake = newFake();
    fake.failNext({ method: "POST", path: "/projects", status: 500 });
    await expect(createOrAdoptProject(fake.rest(), INPUT)).rejects.toMatchObject({ status: 500 });
    expect(fake.snapshot()).toEqual({ projects: {} });
    const rerun = await createOrAdoptProject(fake.rest(), INPUT);
    expect(rerun).toMatchObject({ attempt: 1, adopted: false });
    expect(fake.snapshot()).toEqual(await cleanSnapshot());
  });

  it("adopts the project on a rerun after the create answer was lost", async () => {
    const fake = newFake();
    fake.failNext({ method: "POST", path: "/projects", status: 502, after: true });
    await expect(createOrAdoptProject(fake.rest(), INPUT)).rejects.toMatchObject({ status: 502 });
    const rerun = await createOrAdoptProject(fake.rest(), INPUT);
    expect(rerun).toMatchObject({
      attempt: 1,
      adopted: true,
      project: { id: 1, name: "oxagen-support" },
    });
    expect(fake.writes()).toEqual([{ method: "POST", path: "/projects" }]);
    expect(fake.snapshot()).toEqual(await cleanSnapshot());
  });

  it("adopts the project on a third run when the lookup after a lost answer also fails", async () => {
    const fake = newFake();
    fake.failNext({ method: "POST", path: "/projects", status: 502, after: true });
    fake.failNext({ method: "GET", path: "/projects/acme/oxagen-support", status: 500 });
    await expect(createOrAdoptProject(fake.rest(), INPUT)).rejects.toMatchObject({ status: 502 });
    await expect(createOrAdoptProject(fake.rest(), INPUT)).rejects.toMatchObject({ status: 500 });
    const third = await createOrAdoptProject(fake.rest(), INPUT);
    expect(third).toMatchObject({ attempt: 1, adopted: true });
    expect(fake.snapshot()).toEqual(await cleanSnapshot());
  });

  it("throws the rate limit error when GitLab answers 429", async () => {
    const fake = newFake();
    fake.failNext({ method: "POST", path: "/projects", status: 429 });
    await expect(createOrAdoptProject(fake.rest(), INPUT)).rejects.toBeInstanceOf(
      GitLabRateLimitedError,
    );
  });

  it("asks the owner to connect again when the token is revoked", async () => {
    const fake = newFake();
    fake.revokeToken();
    await expect(createOrAdoptProject(fake.rest(), INPUT)).rejects.toBeInstanceOf(
      SteeringGitlabReauthorizeError,
    );
  });
});

describe("createProject", () => {
  it("throws a 400 that is not about a taken name", async () => {
    const fake = newFake();
    const run = createProject(fake.rest(), { namespace_id: 8, name: "x", description: "" });
    await expect(run).rejects.toBeInstanceOf(GitLabApiError);
    await expect(run).rejects.toMatchObject({
      status: 400,
      message: "GitLab API error 400: namespace is not valid",
    });
  });

  it("throws a 400 that carries no message", async () => {
    const rest = stubRest([{ status: 400, data: null, message: null }]);
    await expect(
      createProject(rest, { namespace_id: 7, name: "x", description: "" }),
    ).rejects.toMatchObject({ status: 400, message: "GitLab API error 400: status 400" });
  });

  it("sends a private project with no README and main as its default branch", async () => {
    const sent: unknown[] = [];
    const fake = newFake();
    const rest: GitlabRest = {
      request<T>(method: string, path: string, body?: unknown, accept?: readonly number[]) {
        sent.push(body);
        return fake.rest().request<T>(method, path, body, accept);
      },
    };
    await createProject(rest, { namespace_id: 7, name: "oxagen-support", description: "d" });
    expect(sent).toEqual([
      {
        name: "oxagen-support",
        path: "oxagen-support",
        namespace_id: 7,
        description: "d",
        visibility: "private",
        initialize_with_readme: false,
        default_branch: "main",
      },
    ]);
  });
});

describe("lookups", () => {
  it("reads the token's user", async () => {
    expect(await getCurrentUser(newFake().rest())).toEqual({ id: 99, username: "group_7_bot" });
  });

  it("reads the group, or null when the token cannot see it", async () => {
    const fake = newFake();
    expect(await getGroup(fake.rest(), 7)).toEqual(GROUP);
    expect(await getGroup(fake.rest(), 8)).toBeNull();
    expect(fake.calls).toEqual([
      { method: "GET", path: "/groups/7?with_projects=false" },
      { method: "GET", path: "/groups/8?with_projects=false" },
    ]);
  });

  it("reads a project by its full path, or null when there is none", async () => {
    const fake = newFake();
    expect(await getProject(fake.rest(), "acme/oxagen-support")).toBeNull();
    fake.seedProject({ name: "oxagen-support", description: "d" });
    await fake.rest().request("POST", "/projects/1/repository/commits", {
      branch: "trunk",
      commit_message: "first",
      actions: [{ action: "create", file_path: "README.md", content: "hi\n" }],
    });
    expect(await getProject(fake.rest(), "acme/oxagen-support")).toEqual({
      id: 1,
      path_with_namespace: "acme/oxagen-support",
      namespace_path: "acme",
      name: "oxagen-support",
      default_branch: "trunk",
      description: "d",
    });
    expect(fake.calls[0]).toEqual({ method: "GET", path: "/projects/acme%2Foxagen-support" });
  });

  it("reads a null description as empty", async () => {
    const rest = stubRest([
      {
        status: 200,
        data: {
          id: 5,
          path: "x",
          path_with_namespace: "acme/x",
          description: null,
          default_branch: null,
          namespace: { full_path: "acme" },
        },
        message: null,
      },
    ]);
    expect(await getProject(rest, "acme/x")).toEqual({
      id: 5,
      path_with_namespace: "acme/x",
      namespace_path: "acme",
      name: "x",
      default_branch: "main",
      description: "",
    });
  });
});
