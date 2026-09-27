import { describe, expect, it } from "vitest";
import { GitHubApiError } from "../fetch-client";
import { recordDeployment, type PublishDeploymentInput } from "./deployment";
import { writeFirstCommit } from "./first-commit";
import { createGithubRest, type GithubResponse, type GithubRest, type HttpFetch } from "./http";
import { FakeGithub } from "./testing/fake-github";
import type { RepoAddress, SteeringApp } from "./types";

const APP: SteeringApp = { symbol: "oxagen-steering", id: 4242, slug: "oxagen-steering" };
const REPO: RepoAddress = { owner: "acme", name: "oxagen-support" };
const ROOT = "/repos/acme/oxagen-support";

interface SnapshotDeployment {
  sha: string;
  ref: string;
  environment: string;
  payload: unknown;
  description: string;
  latest_status: string | null;
}

/** A fake whose steering repo holds its first commit, and the input that records it. */
async function published(): Promise<{ fake: FakeGithub; input: PublishDeploymentInput }> {
  const fake = new FakeGithub({ org: "acme", app: APP });
  fake.seedRepository({ name: REPO.name, in_installation: true });
  const commit = await writeFirstCommit(fake.appRest(), {
    repo: REPO,
    files: [{ path: "README.md", content: "# Support steering\n" }],
    message: "Oxagen steering v1",
    initial_branch: "main",
  });
  return {
    fake,
    input: {
      repo: REPO,
      environment: "steering",
      ref: "main",
      sha: commit.commit_sha,
      version: 1,
      description: "Version 1",
    },
  };
}

function deploymentsOf(fake: FakeGithub): SnapshotDeployment[] {
  const snapshot = fake.snapshot() as {
    repositories: Record<string, { deployments: SnapshotDeployment[] }>;
  };
  return snapshot.repositories[REPO.name]?.deployments ?? [];
}

function writesSince(fake: FakeGithub, from: number): { method: string; path: string }[] {
  return fake.calls.slice(from).filter((c) => c.method !== "GET");
}

/** Record a deployment the way another run or another tool would have. */
async function seedDeployment(
  fake: FakeGithub,
  body: { environment: string; payload: unknown },
  state?: string,
): Promise<number> {
  const rest = fake.appRest();
  const res = await rest.request<{ id: number }>("POST", `${ROOT}/deployments`, {
    ref: "main",
    ...body,
  });
  const id = res.data?.id;
  if (id === undefined) throw new Error("The fake returned no deployment.");
  if (state !== undefined)
    await rest.request("POST", `${ROOT}/deployments/${id}/statuses`, { state });
  return id;
}

/** A client whose nth write answers 502, before or after the fake applies it. */
function failingWrite(fake: FakeGithub, n: number, when: "before" | "after"): GithubRest {
  let seen = 0;
  const fetch: HttpFetch = async (url, init) => {
    if (init.method === "GET") return fake.fetch(url, init);
    seen += 1;
    if (seen !== n) return fake.fetch(url, init);
    if (when === "after") await fake.fetch(url, init);
    return { status: 502, text: () => Promise.resolve('{"message":"injected failure"}') };
  };
  return createGithubRest({ token: "app-token", fetch });
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

async function cleanRecord() {
  const { fake, input } = await published();
  const from = fake.calls.length;
  const result = await recordDeployment(fake.appRest(), input);
  return { result, writes: writesSince(fake, from), snapshot: fake.snapshot() };
}

describe("recordDeployment", () => {
  it("records a deployment and its success status on the first run", async () => {
    const { fake, input } = await published();
    const from = fake.calls.length;

    const result = await recordDeployment(fake.appRest(), input);

    expect(result.created).toBe(true);
    expect(fake.calls[from]).toEqual({
      method: "GET",
      path: `${ROOT}/deployments?environment=steering&per_page=100`,
    });
    expect(writesSince(fake, from)).toEqual([
      { method: "POST", path: `${ROOT}/deployments` },
      { method: "POST", path: `${ROOT}/deployments/${result.deployment_id}/statuses` },
    ]);
    expect(deploymentsOf(fake)).toEqual([
      {
        sha: input.sha,
        ref: "main",
        environment: "steering",
        payload: { version: 1 },
        description: "Version 1",
        latest_status: "success",
      },
    ]);
  });

  it("asks GitHub to wait on no checks and to treat the environment as production", async () => {
    const { fake, input } = await published();
    const sent: unknown[] = [];
    const fetch: HttpFetch = (url, init) => {
      if (init.method === "POST" && url.endsWith("/deployments") && init.body !== undefined)
        sent.push(JSON.parse(init.body));
      return fake.fetch(url, init);
    };
    await recordDeployment(createGithubRest({ token: "app-token", fetch }), input);
    expect(sent).toEqual([
      {
        ref: "main",
        environment: "steering",
        auto_merge: false,
        required_contexts: [],
        payload: { version: 1 },
        description: "Version 1",
        production_environment: true,
      },
    ]);
  });

  it("changes nothing on a rerun", async () => {
    const { fake, input } = await published();
    const first = await recordDeployment(fake.appRest(), input);
    const before = fake.snapshot();
    const from = fake.calls.length;

    const again = await recordDeployment(fake.appRest(), input);

    expect(again).toEqual({ deployment_id: first.deployment_id, created: false });
    expect(writesSince(fake, from)).toEqual([]);
    expect(fake.snapshot()).toEqual(before);
  });

  it("adds only the status on a rerun after a failure between the deployment and its status", async () => {
    const clean = await cleanRecord();
    const { fake, input } = await published();
    fake.failNext({ method: "POST", path: /\/statuses$/, status: 500 });

    const failed = await recordDeployment(fake.appRest(), input).then(
      () => null,
      (e: unknown) => e,
    );
    expect(failed).toBeInstanceOf(GitHubApiError);
    expect(deploymentsOf(fake).map((d) => d.latest_status)).toEqual([null]);

    const from = fake.calls.length;
    const rerun = await recordDeployment(fake.appRest(), input);

    expect(rerun).toEqual({ deployment_id: clean.result.deployment_id, created: false });
    expect(writesSince(fake, from)).toEqual([
      { method: "POST", path: `${ROOT}/deployments/${rerun.deployment_id}/statuses` },
    ]);
    expect(fake.snapshot()).toEqual(clean.snapshot);
  });

  for (const when of ["before", "after"] as const) {
    it(`converges on a rerun after a failure ${when} GitHub applies each write`, async () => {
      const clean = await cleanRecord();
      expect(clean.writes).toHaveLength(2);

      for (let n = 1; n <= clean.writes.length; n++) {
        const label = `write ${n}: ${clean.writes[n - 1]?.path}`;
        const { fake, input } = await published();

        const failed = await recordDeployment(failingWrite(fake, n, when), input).then(
          () => null,
          (e: unknown) => e,
        );
        expect(failed, label).toBeInstanceOf(GitHubApiError);

        const rerun = await recordDeployment(fake.appRest(), input);
        expect(rerun.deployment_id, label).toBe(clean.result.deployment_id);
        expect(fake.snapshot(), label).toEqual(clean.snapshot);
      }
    });
  }

  it("finds a deployment whose payload GitHub returns as a JSON string", async () => {
    const { fake, input } = await published();
    const id = await seedDeployment(
      fake,
      { environment: "steering", payload: JSON.stringify({ version: 1 }) },
      "success",
    );
    const from = fake.calls.length;

    const result = await recordDeployment(fake.appRest(), input);

    expect(result).toEqual({ deployment_id: id, created: false });
    expect(writesSince(fake, from)).toEqual([]);
  });

  it("adds a success status to a matching deployment whose latest status is not success", async () => {
    const { fake, input } = await published();
    const id = await seedDeployment(
      fake,
      { environment: "steering", payload: JSON.stringify({ version: 1 }) },
      "failure",
    );
    const from = fake.calls.length;

    const result = await recordDeployment(fake.appRest(), input);

    expect(result).toEqual({ deployment_id: id, created: false });
    expect(writesSince(fake, from)).toEqual([
      { method: "POST", path: `${ROOT}/deployments/${id}/statuses` },
    ]);
    expect(deploymentsOf(fake).map((d) => d.latest_status)).toEqual(["success"]);
  });

  it("creates a new deployment when no recorded payload names this version", async () => {
    const payloads: unknown[] = [
      "not json",
      "null",
      7,
      { version: "1" },
      { version: 2 },
      JSON.stringify({ version: 2 }),
      {},
    ];
    for (const payload of payloads) {
      const { fake, input } = await published();
      const id = await seedDeployment(fake, { environment: "steering", payload }, "success");

      const result = await recordDeployment(fake.appRest(), input);

      expect(result.created, JSON.stringify(payload)).toBe(true);
      expect(result.deployment_id, JSON.stringify(payload)).not.toBe(id);
      expect(deploymentsOf(fake), JSON.stringify(payload)).toHaveLength(2);
    }
  });

  it("creates a new deployment when the matching version was recorded to another environment", async () => {
    const { fake, input } = await published();
    await seedDeployment(fake, { environment: "production", payload: { version: 1 } }, "success");

    const result = await recordDeployment(fake.appRest(), input);

    expect(result.created).toBe(true);
    expect(deploymentsOf(fake).map((d) => d.environment)).toEqual(["production", "steering"]);
  });

  it("creates a new deployment when the recorded one points at another commit", async () => {
    const { fake, input } = await published();
    const first = await recordDeployment(fake.appRest(), input);

    const result = await recordDeployment(fake.appRest(), { ...input, sha: "0".repeat(40) });

    expect(result.created).toBe(true);
    expect(result.deployment_id).not.toBe(first.deployment_id);
  });

  it("reads a list or a status answer with no body as empty", async () => {
    const rest = scripted(
      { status: 200, data: null, message: null },
      { status: 201, data: { id: 9, sha: "abc" }, message: null },
      { status: 200, data: null, message: null },
      { status: 201, data: null, message: null },
    );
    const input: PublishDeploymentInput = {
      repo: REPO,
      environment: "steering",
      ref: "main",
      sha: "abc",
      version: 1,
      description: "Version 1",
    };
    expect(await recordDeployment(rest, input)).toEqual({ deployment_id: 9, created: true });
  });

  it("throws when GitHub returns no deployment", async () => {
    const input: PublishDeploymentInput = {
      repo: REPO,
      environment: "steering",
      ref: "main",
      sha: "abc",
      version: 1,
      description: "Version 1",
    };
    const empty = scripted(
      { status: 200, data: [], message: null },
      { status: 201, data: null, message: null },
    );
    await expect(recordDeployment(empty, input)).rejects.toThrow("GitHub returned no deployment");

    const noId = scripted(
      { status: 200, data: [], message: null },
      { status: 201, data: { id: "9", sha: "abc" }, message: null },
    );
    await expect(recordDeployment(noId, input)).rejects.toThrow("GitHub returned no deployment");
  });
});
