import { describe, expect, it } from "vitest";
import { GitLabApiError } from "../client";
import { STEERING_BRANCH, writeFirstCommit } from "./first-commit";
import type { GitlabResponse, GitlabRest } from "./http";
import { FakeGitlab } from "./testing/fake-gitlab";
import type { FakeGitlabSnapshot } from "./testing/fake-gitlab";
import type { SeedFile } from "./types";

const GROUP = { id: 7, full_path: "acme" };
const MESSAGE = "Seed the steering repo";
const COMMITS = "/projects/1/repository/commits";

const FILES: SeedFile[] = [
  { path: ".oxagen/rules/README.md", content: "# Rules\n\nOne rule per file.\n" },
  {
    path: ".oxagen/steering.json",
    content: `${JSON.stringify({ version: 1, rules: [] }, null, 2)}\n`,
  },
  { path: "README.md", content: "# Steering\n" },
];

const SEEDED = Object.fromEntries(FILES.map((f) => [f.path, f.content]));

/** A fake holding one empty project with id 1. */
function newFake(): FakeGitlab {
  const fake = new FakeGitlab({ group: GROUP, bot: { user_id: 99, username: "group_7_bot" } });
  fake.seedProject({ name: "oxagen-support", description: "d" });
  return fake;
}

function write(fake: FakeGitlab, files: readonly SeedFile[] = FILES) {
  return writeFirstCommit(fake.rest(), { project_id: 1, files, message: MESSAGE });
}

async function cleanSnapshot(): Promise<FakeGitlabSnapshot> {
  const fake = newFake();
  await write(fake);
  return fake.snapshot();
}

function mainOf(fake: FakeGitlab): { sha: string; files: Record<string, string> } | undefined {
  return fake.snapshot().projects["acme/oxagen-support"]?.branches.main;
}

/** Change main behind the step's back: edit one seed, drop one, and add a stray file. */
async function drift(fake: FakeGitlab): Promise<void> {
  await fake.rest().request("POST", COMMITS, {
    branch: "main",
    commit_message: "Edit by hand",
    actions: [
      { action: "update", file_path: "README.md", content: "# Edited\n" },
      { action: "delete", file_path: ".oxagen/steering.json" },
      { action: "create", file_path: "stray.txt", content: "left behind\n" },
    ],
  });
}

/** A rest helper that records the body of each request before the fake answers it. */
function recording(fake: FakeGitlab): { rest: GitlabRest; bodies: unknown[] } {
  const bodies: unknown[] = [];
  const inner = fake.rest();
  return {
    bodies,
    rest: {
      request<T>(method: string, path: string, body?: unknown, accept?: readonly number[]) {
        if (body !== undefined) bodies.push(body);
        return inner.request<T>(method, path, body, accept);
      },
    },
  };
}

describe("writeFirstCommit", () => {
  it("names main as the steering branch", () => {
    expect(STEERING_BRANCH).toBe("main");
  });

  it("creates main with every seed file in one commit", async () => {
    const fake = newFake();
    const result = await write(fake);
    expect(result.written).toBe(true);
    expect(result.commit_sha).toBe(mainOf(fake)?.sha);
    expect(mainOf(fake)?.files).toEqual(SEEDED);
    expect(fake.snapshot().projects["acme/oxagen-support"]?.default_branch).toBe("main");
    expect(fake.writes()).toEqual([{ method: "POST", path: COMMITS }]);
  });

  it("sends a create action for each seed on an empty project", async () => {
    const fake = newFake();
    const { rest, bodies } = recording(fake);
    await writeFirstCommit(rest, { project_id: 1, files: FILES, message: MESSAGE });
    expect(bodies).toEqual([
      {
        branch: "main",
        commit_message: MESSAGE,
        actions: FILES.map((f) => ({ action: "create", file_path: f.path, content: f.content })),
      },
    ]);
  });

  it("writes nothing on a rerun when main already holds the seed files", async () => {
    const fake = newFake();
    const first = await write(fake);
    const rerun = await write(fake);
    expect(rerun).toEqual({ commit_sha: first.commit_sha, written: false });
    expect(fake.writes()).toHaveLength(1);
  });

  it("fixes main on a rerun after someone changed it", async () => {
    const fake = newFake();
    await write(fake);
    await drift(fake);
    const { rest, bodies } = recording(fake);
    const rerun = await writeFirstCommit(rest, { project_id: 1, files: FILES, message: MESSAGE });
    expect(rerun.written).toBe(true);
    expect(bodies).toEqual([
      {
        branch: "main",
        commit_message: MESSAGE,
        actions: [
          {
            action: "create",
            file_path: ".oxagen/steering.json",
            content: SEEDED[".oxagen/steering.json"],
          },
          { action: "update", file_path: "README.md", content: "# Steering\n" },
          { action: "delete", file_path: "stray.txt" },
        ],
      },
    ]);
    expect(mainOf(fake)?.files).toEqual(SEEDED);
    expect(rerun.commit_sha).toBe(mainOf(fake)?.sha);
    // The fake derives a sha from the tree and the message, so the same end state gives the same sha.
    expect(fake.snapshot()).toEqual(await cleanSnapshot());
  });

  it("reads every page of a large tree", async () => {
    const many: SeedFile[] = Array.from({ length: 150 }, (_, i) => ({
      path: `rules/r${String(i).padStart(3, "0")}.md`,
      content: `rule ${i}\n`,
    }));
    const fake = newFake();
    await write(fake, many);
    const rerun = await write(fake, many);
    expect(rerun.written).toBe(false);
    const treeCalls = fake.calls.filter((c) => c.path.includes("/repository/tree"));
    expect(treeCalls.map((c) => c.path)).toEqual([
      "/projects/1/repository/tree?ref=main&recursive=true&per_page=100&page=1",
      "/projects/1/repository/tree?ref=main&recursive=true&per_page=100&page=2",
    ]);
  });

  it("stops reading a tree that never ends", async () => {
    let treeReads = 0;
    const rest: GitlabRest = {
      request<T>(_method: string, path: string): Promise<GitlabResponse<T>> {
        if (path.includes("/repository/branches/"))
          return Promise.resolve({
            status: 200,
            data: { name: "main", commit: { id: "abc" } } as T,
            message: null,
          });
        treeReads += 1;
        const entries = Array.from({ length: 100 }, (_, i) => ({ path: `d${i}`, type: "tree" }));
        return Promise.resolve({ status: 200, data: entries as T, message: null });
      },
    };
    await expect(
      writeFirstCommit(rest, { project_id: 1, files: FILES, message: MESSAGE }),
    ).rejects.toThrow(
      "The steering repo holds more than 10000 tree entries on main, so provisioning stopped reading it.",
    );
    expect(treeReads).toBe(100);
  });

  it("throws a 403 when main is protected against the bot", async () => {
    const fake = newFake();
    await write(fake);
    await drift(fake);
    await fake.rest().request("POST", "/projects/1/protected_branches", {
      name: "main",
      push_access_level: 0,
    });
    const run = write(fake);
    await expect(run).rejects.toBeInstanceOf(GitLabApiError);
    await expect(run).rejects.toMatchObject({ status: 403 });
  });
});

describe("writeFirstCommit after a failure", () => {
  it("reaches the clean state after the first commit fails before GitLab applies it", async () => {
    const fake = newFake();
    fake.failNext({ method: "POST", path: COMMITS, status: 500 });
    await expect(write(fake)).rejects.toMatchObject({ status: 500 });
    expect(mainOf(fake)).toBeUndefined();
    const rerun = await write(fake);
    expect(rerun.written).toBe(true);
    expect(fake.snapshot()).toEqual(await cleanSnapshot());
  });

  it("returns the head on a rerun after the first commit answer was lost", async () => {
    const fake = newFake();
    fake.failNext({ method: "POST", path: COMMITS, status: 502, after: true });
    await expect(write(fake)).rejects.toMatchObject({ status: 502 });
    const rerun = await write(fake);
    expect(rerun).toEqual({ commit_sha: mainOf(fake)?.sha, written: false });
    expect(fake.writes()).toHaveLength(1);
    expect(fake.snapshot()).toEqual(await cleanSnapshot());
  });

  it("reaches the clean state after the fixing commit fails before GitLab applies it", async () => {
    const fake = newFake();
    await write(fake);
    await drift(fake);
    fake.failNext({ method: "POST", path: COMMITS, status: 500 });
    await expect(write(fake)).rejects.toMatchObject({ status: 500 });
    expect(mainOf(fake)?.files).toHaveProperty("stray.txt");
    const rerun = await write(fake);
    expect(rerun.written).toBe(true);
    expect(fake.snapshot()).toEqual(await cleanSnapshot());
  });

  it("writes nothing on a rerun after the fixing commit answer was lost", async () => {
    const fake = newFake();
    await write(fake);
    await drift(fake);
    fake.failNext({ method: "POST", path: COMMITS, status: 502, after: true });
    await expect(write(fake)).rejects.toMatchObject({ status: 502 });
    const writesBefore = fake.writes().length;
    const rerun = await write(fake);
    expect(rerun).toEqual({ commit_sha: mainOf(fake)?.sha, written: false });
    expect(fake.writes()).toHaveLength(writesBefore);
    expect(fake.snapshot()).toEqual(await cleanSnapshot());
  });

  it("throws when the branch read fails and writes nothing", async () => {
    const fake = newFake();
    fake.failNext({ method: "GET", path: "/projects/1/repository/branches/main", status: 500 });
    await expect(write(fake)).rejects.toMatchObject({ status: 500 });
    expect(fake.writes()).toEqual([]);
    await write(fake);
    expect(fake.snapshot()).toEqual(await cleanSnapshot());
  });
});
