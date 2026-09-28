import { describe, expect, it } from "vitest";
import { GitHubApiError } from "../fetch-client";
import { STEERING_BRANCH, writeFirstCommit, type FirstCommitInput } from "./first-commit";
import type { GithubResponse, GithubRest } from "./http";
import { FakeGithub } from "./testing/fake-github";
import type { RepoAddress, SeedFile, SteeringApp } from "./types";

const APP: SteeringApp = { symbol: "oxagen-steering", id: 4242, slug: "oxagen-steering" };
const REPO: RepoAddress = { owner: "acme", name: "oxagen-support" };
const ROOT = "/repos/acme/oxagen-support";
const FILES: SeedFile[] = [
  { path: "README.md", content: "# Support steering\n" },
  { path: ".oxagen/steering.toml", content: "version = 1\n" },
];
const MESSAGE = "Oxagen steering v1";

/** A fake with the steering repo already created and added to the installation. */
function setup(initialBranch: string): { fake: FakeGithub; input: FirstCommitInput } {
  const fake = new FakeGithub({ org: "acme", app: APP, org_default_branch: initialBranch });
  fake.seedRepository({ name: REPO.name, in_installation: true });
  return {
    fake,
    input: { repo: REPO, files: FILES, message: MESSAGE, initial_branch: initialBranch },
  };
}

function writesSince(fake: FakeGithub, from: number): { method: string; path: string }[] {
  return fake.calls.slice(from).filter((c) => c.method !== "GET");
}

/** A pattern that matches one path and nothing longer. */
function exactly(path: string): RegExp {
  return new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
}

function seedFiles(): Record<string, string> {
  return Object.fromEntries(FILES.map((f) => [f.path, f.content]));
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

async function cleanRun(initialBranch: string) {
  const { fake, input } = setup(initialBranch);
  const result = await writeFirstCommit(fake.appRest(), input);
  return { result, writes: fake.writes(), snapshot: fake.snapshot() };
}

describe("writeFirstCommit", () => {
  it("publishes from main", () => {
    expect(STEERING_BRANCH).toBe("main");
  });

  it("replaces GitHub's first commit on main with the seed files", async () => {
    const { fake, input } = setup("main");
    const result = await writeFirstCommit(fake.appRest(), input);

    expect(result.written).toBe(true);
    expect(result.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.tree_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(fake.writes()).toEqual([
      { method: "POST", path: `${ROOT}/git/trees` },
      { method: "POST", path: `${ROOT}/git/commits` },
      { method: "PATCH", path: `${ROOT}/git/refs/heads/main` },
    ]);
    expect(fake.snapshot()).toMatchObject({
      repositories: {
        [REPO.name]: {
          default_branch: "main",
          branches: { main: result.commit_sha },
          files: { main: seedFiles() },
        },
      },
    });
  });

  it("writes a commit with no parents", async () => {
    const { fake, input } = setup("main");
    const result = await writeFirstCommit(fake.appRest(), input);
    const commit = await fake
      .appRest()
      .request<{ message: string; tree: { sha: string }; parents: unknown[] }>(
        "GET",
        `${ROOT}/git/commits/${result.commit_sha}`,
      );
    expect(commit.data).toMatchObject({
      message: MESSAGE,
      tree: { sha: result.tree_sha },
      parents: [],
    });
  });

  it("creates main, makes it the default, and deletes master when the org starts on master", async () => {
    const { fake, input } = setup("master");
    const result = await writeFirstCommit(fake.appRest(), input);

    expect(result.written).toBe(true);
    expect(fake.writes()).toEqual([
      { method: "POST", path: `${ROOT}/git/trees` },
      { method: "POST", path: `${ROOT}/git/commits` },
      { method: "POST", path: `${ROOT}/git/refs` },
      { method: "PATCH", path: ROOT },
      { method: "DELETE", path: `${ROOT}/git/refs/heads/master` },
    ]);
    const snapshot = fake.snapshot() as {
      repositories: Record<string, { default_branch: string; branches: Record<string, string> }>;
    };
    const repo = snapshot.repositories[REPO.name];
    expect(repo?.default_branch).toBe("main");
    expect(repo?.branches).toEqual({ main: result.commit_sha });
  });

  it("ends a master run in the same commit a main run makes", async () => {
    const onMain = await cleanRun("main");
    const onMaster = await cleanRun("master");
    expect(onMaster.result.commit_sha).toBe(onMain.result.commit_sha);
    expect(onMaster.result.tree_sha).toBe(onMain.result.tree_sha);
  });

  it("deletes an initial branch whose name holds a slash", async () => {
    const { fake, input } = setup("release/v1");
    await writeFirstCommit(fake.appRest(), input);
    expect(fake.writes().at(-1)).toEqual({
      method: "DELETE",
      path: `${ROOT}/git/refs/heads/release/v1`,
    });
    const snapshot = fake.snapshot() as {
      repositories: Record<string, { branches: Record<string, string> }>;
    };
    expect(Object.keys(snapshot.repositories[REPO.name]?.branches ?? {})).toEqual(["main"]);
  });

  it("changes nothing on a rerun when main already holds the seed files", async () => {
    const { fake, input } = setup("main");
    const first = await writeFirstCommit(fake.appRest(), input);
    const before = fake.snapshot();
    const from = fake.calls.length;

    const again = await writeFirstCommit(fake.appRest(), input);

    expect(again).toEqual({ ...first, written: false });
    // Creating a tree object moves no ref, so it is the one write a rerun sends.
    expect(writesSince(fake, from)).toEqual([{ method: "POST", path: `${ROOT}/git/trees` }]);
    expect(fake.snapshot()).toEqual(before);
  });

  it("changes nothing on a rerun after the org's master branch is gone", async () => {
    const { fake, input } = setup("master");
    const first = await writeFirstCommit(fake.appRest(), input);
    const before = fake.snapshot();
    const from = fake.calls.length;

    const again = await writeFirstCommit(fake.appRest(), input);

    expect(again).toEqual({ ...first, written: false });
    // The delete finds no master and GitHub answers 422, which the step accepts.
    expect(writesSince(fake, from)).toEqual([
      { method: "POST", path: `${ROOT}/git/trees` },
      { method: "DELETE", path: `${ROOT}/git/refs/heads/master` },
    ]);
    expect(fake.snapshot()).toEqual(before);
  });

  it("accepts a 404 for an initial branch an earlier run deleted", async () => {
    const { fake, input } = setup("master");
    await writeFirstCommit(fake.appRest(), input);
    const before = fake.snapshot();
    fake.failNext({ method: "DELETE", path: "/git/refs/heads/master", status: 404 });
    const again = await writeFirstCommit(fake.appRest(), input);
    expect(again.written).toBe(false);
    expect(fake.snapshot()).toEqual(before);
  });

  it("writes a new commit when the seed files change", async () => {
    const { fake, input } = setup("main");
    const first = await writeFirstCommit(fake.appRest(), input);
    const changed = await writeFirstCommit(fake.appRest(), {
      ...input,
      files: [...FILES, { path: "rules/extra.md", content: "extra\n" }],
    });
    expect(changed.written).toBe(true);
    expect(changed.commit_sha).not.toBe(first.commit_sha);
    expect(changed.tree_sha).not.toBe(first.tree_sha);
  });

  for (const initialBranch of ["main", "master"]) {
    it(`converges after a failure at each write when the org starts on ${initialBranch}`, async () => {
      const clean = await cleanRun(initialBranch);
      expect(clean.writes.length).toBeGreaterThan(0);

      for (const write of clean.writes) {
        const { fake, input } = setup(initialBranch);
        fake.failNext({ method: write.method, path: exactly(write.path), status: 500 });

        const failed = await writeFirstCommit(fake.appRest(), input).then(
          () => null,
          (e: unknown) => e,
        );
        expect(failed, `${write.method} ${write.path}`).toBeInstanceOf(GitHubApiError);

        const rerun = await writeFirstCommit(fake.appRest(), input);
        expect(rerun.commit_sha, `${write.method} ${write.path}`).toBe(clean.result.commit_sha);
        expect(fake.snapshot(), `${write.method} ${write.path}`).toEqual(clean.snapshot);
      }
    });
  }

  it("throws when GitHub returns no tree sha", async () => {
    const rest = scripted({ status: 201, data: { sha: "" }, message: null });
    await expect(
      writeFirstCommit(rest, { repo: REPO, files: FILES, message: MESSAGE, initial_branch: "main" }),
    ).rejects.toThrow("GitHub returned no tree sha");
  });

  it("throws when GitHub returns no commit", async () => {
    const rest = scripted(
      { status: 201, data: { sha: "tree-sha" }, message: null },
      { status: 404, data: null, message: "Not Found" },
      { status: 201, data: null, message: null },
    );
    await expect(
      writeFirstCommit(rest, { repo: REPO, files: FILES, message: MESSAGE, initial_branch: "main" }),
    ).rejects.toThrow("GitHub returned no commit sha");
  });

  it("throws when the commit sha is not a string", async () => {
    const rest = scripted(
      { status: 201, data: { sha: "tree-sha" }, message: null },
      { status: 404, data: null, message: "Not Found" },
      { status: 201, data: { sha: 7 }, message: null },
    );
    await expect(
      writeFirstCommit(rest, { repo: REPO, files: FILES, message: MESSAGE, initial_branch: "main" }),
    ).rejects.toThrow("GitHub returned no commit sha");
  });
});
