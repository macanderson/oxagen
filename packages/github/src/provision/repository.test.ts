import { describe, expect, it } from "vitest";
import { GitHubApiError, GitHubRateLimitedError } from "../fetch-client";
import type { GithubResponse, GithubRest } from "./http";
import {
  addRepositoryToInstallation,
  candidateName,
  createOrAdoptRepository,
  createRepository,
  getRepository,
  listSteeringInstallations,
  SteeringReauthorizeError,
  type CreateOrAdoptInput,
} from "./repository";
import { FakeGithub, type FakeGithubOptions } from "./testing/fake-github";
import type { SteeringApp } from "./types";

const APP: SteeringApp = { symbol: "oxagen-steering", id: 4242, slug: "oxagen-steering" };
const MARKER = "oxagen-scope:ws_123";
const DESCRIPTION = `Steering for Support. ${MARKER}`;

function makeFake(opts: Partial<FakeGithubOptions> = {}): FakeGithub {
  return new FakeGithub({ org: "acme", app: APP, ...opts });
}

function adoptInput(
  fake: FakeGithub,
  extra: Partial<CreateOrAdoptInput> = {},
): CreateOrAdoptInput {
  return {
    org: "acme",
    base_name: "oxagen-support",
    description: DESCRIPTION,
    marker: MARKER,
    lookups: [fake.appRest(), fake.userRest()],
    ...extra,
  };
}

/** A client that returns the given answers in order, for shapes the fake never sends. */
function scripted(...answers: GithubResponse<unknown>[]): GithubRest {
  const queue = [...answers];
  return {
    request<T>(): Promise<GithubResponse<T>> {
      const next = queue.shift();
      if (next === undefined) throw new Error("The scripted client ran out of answers.");
      return Promise.resolve(next as GithubResponse<T>);
    },
  };
}

async function rejection<E extends Error>(
  promise: Promise<unknown>,
  type: new (...args: never[]) => E,
): Promise<E> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof type) return e;
    throw e;
  }
  throw new Error("The call resolved, and the test expected it to throw.");
}

describe("candidateName", () => {
  it("keeps the base name for the first attempt and numbers the rest", () => {
    expect(candidateName("oxagen-support", 0)).toBe("oxagen-support");
    expect(candidateName("oxagen-support", 1)).toBe("oxagen-support");
    expect(candidateName("oxagen-support", 2)).toBe("oxagen-support-2");
    expect(candidateName("oxagen-support", 12)).toBe("oxagen-support-12");
  });
});

describe("createRepository", () => {
  it("creates a private repository that is not yet in the installation", async () => {
    const fake = makeFake();
    const result = await createRepository(fake.appRest(), {
      org: "acme",
      name: "oxagen-support",
      description: DESCRIPTION,
    });
    expect(result).toEqual({
      status: "created",
      repository: {
        id: expect.any(Number),
        owner: "acme",
        name: "oxagen-support",
        full_name: "acme/oxagen-support",
        default_branch: "main",
      },
    });
    expect(fake.writes()).toEqual([{ method: "POST", path: "/orgs/acme/repos" }]);
    expect(fake.snapshot()).toMatchObject({
      repositories: {
        "oxagen-support": {
          private: true,
          description: DESCRIPTION,
          in_installation: false,
        },
      },
    });
  });

  it("records the organization's default branch", async () => {
    const fake = makeFake({ org_default_branch: "master" });
    const result = await createRepository(fake.appRest(), {
      org: "acme",
      name: "r",
      description: "",
    });
    expect(result.status === "created" && result.repository.default_branch).toBe("master");
  });

  it("reports a taken name as name_taken", async () => {
    const fake = makeFake();
    fake.seedRepository({ name: "oxagen-support" });
    const result = await createRepository(fake.appRest(), {
      org: "acme",
      name: "oxagen-support",
      description: DESCRIPTION,
    });
    expect(result).toEqual({ status: "name_taken" });
  });

  it("throws on a 422 that is not a taken name", async () => {
    const fake = makeFake();
    const err = await rejection(
      createRepository(fake.appRest(), { org: "acme", name: "", description: "" }),
      GitHubApiError,
    );
    expect(err.status).toBe(422);
    expect(err.message).toContain("name is missing");
  });

  it("throws on a 422 that carries no message", async () => {
    const rest = scripted({ status: 422, data: null, message: null });
    const err = await rejection(
      createRepository(rest, { org: "acme", name: "r", description: "" }),
      GitHubApiError,
    );
    expect(err.message).toBe("GitHub API error 422: status 422");
  });

  it("throws when a 2xx answer carries no repository", async () => {
    const rest = scripted({ status: 201, data: null, message: null });
    const err = await rejection(
      createRepository(rest, { org: "acme", name: "r", description: "" }),
      GitHubApiError,
    );
    expect(err.status).toBe(201);
    expect(err.message).toContain("GitHub returned no repository");
  });

  it("reads a missing default branch as main", async () => {
    const rest = scripted({
      status: 201,
      data: {
        id: 9,
        name: "r",
        full_name: "acme/r",
        owner: { login: "acme" },
        default_branch: null,
      },
      message: null,
    });
    const result = await createRepository(rest, { org: "acme", name: "r", description: "" });
    expect(result).toEqual({
      status: "created",
      repository: { id: 9, owner: "acme", name: "r", full_name: "acme/r", default_branch: "main" },
    });
  });

  it("stops at a rate limit instead of reading it as a taken name", async () => {
    const fake = makeFake();
    fake.failNext({ path: "/orgs/acme/repos", status: 429, message: "slow down" });
    await rejection(
      createRepository(fake.appRest(), { org: "acme", name: "r", description: "" }),
      GitHubRateLimitedError,
    );
  });
});

describe("getRepository", () => {
  it("returns the repository with its description", async () => {
    const fake = makeFake();
    fake.seedRepository({ name: "r", description: "hello", in_installation: true });
    const found = await getRepository(fake.appRest(), { owner: "acme", name: "r" });
    expect(found).toEqual({
      id: expect.any(Number),
      owner: "acme",
      name: "r",
      full_name: "acme/r",
      default_branch: "main",
      description: "hello",
    });
  });

  it("reads an empty description as an empty string", async () => {
    const fake = makeFake();
    fake.seedRepository({ name: "r", in_installation: true });
    const found = await getRepository(fake.appRest(), { owner: "acme", name: "r" });
    expect(found?.description).toBe("");
  });

  it("returns null when the token cannot see the repository", async () => {
    const fake = makeFake();
    fake.seedRepository({ name: "r" });
    expect(await getRepository(fake.appRest(), { owner: "acme", name: "r" })).toBeNull();
    expect(await getRepository(fake.userRest(), { owner: "acme", name: "r" })).not.toBeNull();
  });
});

describe("createOrAdoptRepository", () => {
  it("creates the repository on the first attempt", async () => {
    const fake = makeFake();
    const result = await createOrAdoptRepository(fake.appRest(), adoptInput(fake));
    expect(result.attempt).toBe(1);
    expect(result.adopted).toBe(false);
    expect(result.repository.name).toBe("oxagen-support");
  });

  it("moves to the -2 name when the first name is taken", async () => {
    const fake = makeFake();
    fake.seedRepository({ name: "oxagen-support", description: "Someone else's repository" });
    const result = await createOrAdoptRepository(
      fake.appRest(),
      adoptInput(fake, { lookups: [] }),
    );
    expect(result.attempt).toBe(2);
    expect(result.adopted).toBe(false);
    expect(result.repository.name).toBe("oxagen-support-2");
  });

  it("skips a taken name whose description lacks the marker", async () => {
    const fake = makeFake();
    fake.seedRepository({
      name: "oxagen-support",
      description: "Support team notes",
      in_installation: true,
    });
    const result = await createOrAdoptRepository(fake.appRest(), adoptInput(fake));
    expect(result).toMatchObject({ attempt: 2, adopted: false });
    expect(result.repository.name).toBe("oxagen-support-2");
    // The app token saw the foreign repository, so the user token was not asked.
    expect(fake.calls.filter((c) => c.path === "/repos/acme/oxagen-support")).toHaveLength(1);
  });

  it("asks the user token when the app token cannot see a taken name", async () => {
    const fake = makeFake();
    fake.seedRepository({ name: "oxagen-support", description: "Support team notes" });
    const result = await createOrAdoptRepository(fake.appRest(), adoptInput(fake));
    expect(result).toMatchObject({ attempt: 2, adopted: false });
    expect(fake.calls.filter((c) => c.path === "/repos/acme/oxagen-support")).toHaveLength(2);
  });

  it("adopts the repository an earlier run created, through the user token", async () => {
    const fake = makeFake();
    const first = await createOrAdoptRepository(fake.appRest(), adoptInput(fake));
    const before = fake.snapshot();

    // The earlier run stopped before it added the repository to the
    // installation, so only the user token can see it.
    const rerun = await createOrAdoptRepository(fake.appRest(), adoptInput(fake));
    expect(rerun).toEqual({ repository: first.repository, attempt: 1, adopted: true });
    expect(rerun.repository).not.toHaveProperty("description");
    expect(fake.snapshot()).toEqual(before);
  });

  it("adopts through the app token when the repository is already in the installation", async () => {
    const fake = makeFake();
    const id = fake.seedRepository({
      name: "oxagen-support",
      description: DESCRIPTION,
      in_installation: true,
    });
    const result = await createOrAdoptRepository(fake.appRest(), adoptInput(fake));
    expect(result).toMatchObject({ attempt: 1, adopted: true, repository: { id } });
    expect(fake.calls.filter((c) => c.path === "/repos/acme/oxagen-support")).toHaveLength(1);
  });

  it("throws a 422 when every name is taken", async () => {
    const fake = makeFake();
    for (const name of ["oxagen-support", "oxagen-support-2", "oxagen-support-3"])
      fake.seedRepository({ name, description: "taken" });
    const err = await rejection(
      createOrAdoptRepository(fake.appRest(), adoptInput(fake, { max_attempts: 3 })),
      GitHubApiError,
    );
    expect(err.status).toBe(422);
    expect(err.message).toBe(
      "GitHub API error 422: Every name from oxagen-support to oxagen-support-3 is taken in acme.",
    );
  });

  it("calls on_attempt before each create, in order", async () => {
    const fake = makeFake();
    fake.seedRepository({ name: "oxagen-support", description: "taken" });
    fake.seedRepository({ name: "oxagen-support-2", description: "taken" });
    const seen: [number, string, number][] = [];
    const result = await createOrAdoptRepository(
      fake.appRest(),
      adoptInput(fake, {
        lookups: [],
        on_attempt: (attempt, name) => {
          seen.push([attempt, name, fake.writes().length]);
          return Promise.resolve();
        },
      }),
    );
    expect(result.attempt).toBe(3);
    expect(seen).toEqual([
      [1, "oxagen-support", 0],
      [2, "oxagen-support-2", 1],
      [3, "oxagen-support-3", 2],
    ]);
  });

  it("stops when on_attempt throws, before it creates anything", async () => {
    const fake = makeFake();
    await expect(
      createOrAdoptRepository(
        fake.appRest(),
        adoptInput(fake, { on_attempt: () => Promise.reject(new Error("store down")) }),
      ),
    ).rejects.toThrow("store down");
    expect(fake.writes()).toEqual([]);
  });

  it("starts from first_attempt", async () => {
    const fake = makeFake();
    const seen: string[] = [];
    const result = await createOrAdoptRepository(
      fake.appRest(),
      adoptInput(fake, {
        first_attempt: 3,
        on_attempt: (_attempt, name) => {
          seen.push(name);
          return Promise.resolve();
        },
      }),
    );
    expect(result).toMatchObject({ attempt: 3, adopted: false });
    expect(result.repository.name).toBe("oxagen-support-3");
    expect(seen).toEqual(["oxagen-support-3"]);
  });

  it("reads a first_attempt below 1 as 1", async () => {
    const fake = makeFake();
    const result = await createOrAdoptRepository(
      fake.appRest(),
      adoptInput(fake, { first_attempt: 0 }),
    );
    expect(result.attempt).toBe(1);
    expect(result.repository.name).toBe("oxagen-support");
  });

  it("counts max_attempts from first_attempt", async () => {
    const fake = makeFake();
    fake.seedRepository({ name: "oxagen-support-3", description: "taken" });
    fake.seedRepository({ name: "oxagen-support-4", description: "taken" });
    const err = await rejection(
      createOrAdoptRepository(
        fake.appRest(),
        adoptInput(fake, { first_attempt: 3, max_attempts: 2, lookups: [] }),
      ),
      GitHubApiError,
    );
    expect(err.message).toContain("from oxagen-support-3 to oxagen-support-4");
  });

  it("tries twenty names by default", async () => {
    const fake = makeFake();
    for (let n = 1; n <= 20; n++)
      fake.seedRepository({ name: candidateName("oxagen-support", n), description: "taken" });
    const err = await rejection(
      createOrAdoptRepository(fake.appRest(), adoptInput(fake, { lookups: [] })),
      GitHubApiError,
    );
    expect(err.message).toContain("to oxagen-support-20 ");
    expect(fake.writes()).toHaveLength(20);
  });
});

describe("listSteeringInstallations", () => {
  it("lists the installation the owner's token can reach", async () => {
    const fake = makeFake();
    const list = await listSteeringInstallations(fake.userRest());
    expect(list).toEqual([
      {
        id: 77,
        account_login: "acme",
        account_type: "Organization",
        repository_selection: "selected",
      },
    ]);
    expect(fake.calls).toEqual([{ method: "GET", path: "/user/installations?per_page=100" }]);
  });

  it("lists every installation the fake was given", async () => {
    const fake = makeFake({
      user_installations: [
        { id: 1, account_login: "acme", account_type: "Organization", repository_selection: "all" },
        { id: 2, account_login: "mac", account_type: "User", repository_selection: "selected" },
      ],
    });
    const list = await listSteeringInstallations(fake.userRest());
    expect(list.map((i) => [i.id, i.account_login, i.repository_selection])).toEqual([
      [1, "acme", "all"],
      [2, "mac", "selected"],
    ]);
  });

  it("leaves out an installation with no account", async () => {
    const rest = scripted({
      status: 200,
      data: {
        installations: [
          { id: 1, account: null, repository_selection: "all" },
          { id: 2, account: { login: "acme", type: "Organization" }, repository_selection: "selected" },
          { id: 3, account: {}, repository_selection: "selected" },
        ],
      },
      message: null,
    });
    expect(await listSteeringInstallations(rest)).toEqual([
      { id: 2, account_login: "acme", account_type: "Organization", repository_selection: "selected" },
      { id: 3, account_login: "", account_type: "", repository_selection: "selected" },
    ]);
  });

  it("asks for authorization again when the user token is revoked", async () => {
    const fake = makeFake();
    fake.revokeUserToken();
    const err = await rejection(listSteeringInstallations(fake.userRest()), SteeringReauthorizeError);
    expect(err.code).toBe("steering_reauthorize");
    expect(err.name).toBe("SteeringReauthorizeError");
    expect(err.message).toContain("status 401");
  });

  it("asks for authorization again on a 403", async () => {
    const fake = makeFake();
    const err = await rejection(listSteeringInstallations(fake.appRest()), SteeringReauthorizeError);
    expect(err.message).toContain("status 403");
  });

  it("throws a rate limit rather than asking for authorization", async () => {
    const fake = makeFake();
    fake.failNext({
      path: "/user/installations",
      status: 403,
      message: "API rate limit exceeded for user.",
    });
    await rejection(listSteeringInstallations(fake.userRest()), GitHubRateLimitedError);
  });
});

describe("addRepositoryToInstallation", () => {
  async function created(fake: FakeGithub): Promise<number> {
    const result = await createRepository(fake.appRest(), {
      org: "acme",
      name: "oxagen-support",
      description: DESCRIPTION,
    });
    if (result.status !== "created") throw new Error("The fake did not create the repository.");
    return result.repository.id;
  }

  it("adds the repository, so the app token can see it", async () => {
    const fake = makeFake();
    const id = await created(fake);
    const added = await addRepositoryToInstallation(fake.userRest(), {
      installation_id: 77,
      repository_id: id,
    });
    expect(added).toBe("added");
    expect(fake.writes().at(-1)).toEqual({
      method: "PUT",
      path: `/user/installations/77/repositories/${id}`,
    });
    expect(await getRepository(fake.appRest(), { owner: "acme", name: "oxagen-support" })).not.toBeNull();
  });

  it("returns already_added on a rerun", async () => {
    const fake = makeFake();
    const id = await created(fake);
    const input = { installation_id: 77, repository_id: id };
    await addRepositoryToInstallation(fake.userRest(), input);
    const before = fake.snapshot();
    expect(await addRepositoryToInstallation(fake.userRest(), input)).toBe("already_added");
    expect(fake.snapshot()).toEqual(before);
  });

  it("asks for authorization again on a 401", async () => {
    const fake = makeFake();
    const id = await created(fake);
    fake.revokeUserToken();
    const err = await rejection(
      addRepositoryToInstallation(fake.userRest(), { installation_id: 77, repository_id: id }),
      SteeringReauthorizeError,
    );
    expect(err.message).toContain("status 401");
  });

  it("asks for authorization again on a 403", async () => {
    const fake = makeFake();
    const id = await created(fake);
    const err = await rejection(
      addRepositoryToInstallation(fake.appRest(), { installation_id: 77, repository_id: id }),
      SteeringReauthorizeError,
    );
    expect(err.message).toContain("status 403");
  });

  it("asks for authorization again on a 404", async () => {
    const fake = makeFake();
    const id = await created(fake);
    const err = await rejection(
      addRepositoryToInstallation(fake.userRest(), { installation_id: 999, repository_id: id }),
      SteeringReauthorizeError,
    );
    expect(err.message).toContain("status 404");
  });

  it("throws other errors as they are", async () => {
    const fake = makeFake();
    const id = await created(fake);
    fake.failNext({ method: "PUT", path: "/user/installations/", status: 500 });
    const err = await rejection(
      addRepositoryToInstallation(fake.userRest(), { installation_id: 77, repository_id: id }),
      GitHubApiError,
    );
    expect(err).not.toBeInstanceOf(SteeringReauthorizeError);
    expect(err.status).toBe(500);
  });
});
