import { describe, expect, it } from "vitest";
import { recordGitlabDeployment } from "./deployment";
import { FakeGitlab } from "./testing/fake-gitlab";
import type { FakeGitlabSnapshot } from "./testing/fake-gitlab";

const GROUP = { id: 7, full_path: "acme" };
const DEPLOYMENTS = "/projects/1/deployments";
const ENVIRONMENT = "steering";

/** A project with one commit on main. Returns the fake and that commit's sha. */
async function project(): Promise<{ fake: FakeGitlab; sha: string }> {
  const fake = new FakeGitlab({ group: GROUP, bot: { user_id: 99, username: "group_7_bot" } });
  fake.seedProject({ name: "oxagen-support", description: "d" });
  const res = await fake.rest().request<{ id: string }>("POST", "/projects/1/repository/commits", {
    branch: "main",
    commit_message: "Seed",
    actions: [{ action: "create", file_path: "README.md", content: "# Steering\n" }],
  });
  return { fake, sha: res.data?.id ?? "" };
}

function record(fake: FakeGitlab, sha: string, environment = ENVIRONMENT) {
  return recordGitlabDeployment(fake.rest(), { project_id: 1, environment, ref: "main", sha });
}

/** Add a deployment by hand, as another run or a person would. */
async function seedDeployment(
  fake: FakeGitlab,
  input: { sha: string; status: string; environment?: string },
): Promise<void> {
  await fake.rest().request("POST", DEPLOYMENTS, {
    environment: input.environment ?? ENVIRONMENT,
    sha: input.sha,
    ref: "main",
    tag: false,
    status: input.status,
  });
}

function deploymentsOf(fake: FakeGitlab): FakeGitlabSnapshot["projects"][string]["deployments"] {
  return fake.snapshot().projects["acme/oxagen-support"]?.deployments ?? [];
}

async function cleanSnapshot(): Promise<FakeGitlabSnapshot> {
  const { fake, sha } = await project();
  await record(fake, sha);
  return fake.snapshot();
}

describe("recordGitlabDeployment", () => {
  it("creates a successful deployment for the sha", async () => {
    const { fake, sha } = await project();
    const setup = fake.writes().length;
    expect(await record(fake, sha)).toEqual({ deployment_id: 1, created: true });
    expect(deploymentsOf(fake)).toEqual([
      { environment: ENVIRONMENT, ref: "main", sha, status: "success" },
    ]);
    expect(fake.writes().slice(setup)).toEqual([{ method: "POST", path: DEPLOYMENTS }]);
    expect(fake.calls.at(-2)).toEqual({
      method: "GET",
      path: `${DEPLOYMENTS}?environment=steering&order_by=id&sort=desc&per_page=100`,
    });
  });

  it("creates nothing on a rerun", async () => {
    const { fake, sha } = await project();
    await record(fake, sha);
    const writes = fake.writes().length;
    expect(await record(fake, sha)).toEqual({ deployment_id: 1, created: false });
    expect(fake.writes()).toHaveLength(writes);
    expect(fake.snapshot()).toEqual(await cleanSnapshot());
  });

  it("only sets the status on a rerun that finds the deployment unfinished", async () => {
    const { fake, sha } = await project();
    await seedDeployment(fake, { sha, status: "running" });
    const setup = fake.writes().length;
    expect(await record(fake, sha)).toEqual({ deployment_id: 1, created: false });
    expect(fake.writes().slice(setup)).toEqual([{ method: "PUT", path: `${DEPLOYMENTS}/1` }]);
    expect(fake.snapshot()).toEqual(await cleanSnapshot());
  });

  it("creates a new deployment for another sha", async () => {
    const { fake, sha } = await project();
    await seedDeployment(fake, { sha: "0".repeat(40), status: "success" });
    expect(await record(fake, sha)).toEqual({ deployment_id: 2, created: true });
    expect(deploymentsOf(fake)).toHaveLength(2);
  });

  it("creates a new deployment when the same sha is live in another environment", async () => {
    const { fake, sha } = await project();
    await seedDeployment(fake, { sha, status: "success", environment: "preview" });
    expect(await record(fake, sha)).toEqual({ deployment_id: 2, created: true });
    // The snapshot sorts deployments, so preview comes first.
    expect(deploymentsOf(fake).map((d) => d.environment)).toEqual(["preview", "steering"]);
  });

  it("finds the deployment again when the environment name holds a slash", async () => {
    const { fake, sha } = await project();
    expect(await record(fake, sha, "review/steering")).toMatchObject({ created: true });
    expect(await record(fake, sha, "review/steering")).toMatchObject({ created: false });
    expect(fake.calls.at(-1)?.path).toBe(
      `${DEPLOYMENTS}?environment=review%2Fsteering&order_by=id&sort=desc&per_page=100`,
    );
  });
});

describe("recordGitlabDeployment after a failure", () => {
  it("reaches the clean state after the create fails before GitLab applies it", async () => {
    const { fake, sha } = await project();
    fake.failNext({ method: "POST", path: DEPLOYMENTS, status: 500 });
    await expect(record(fake, sha)).rejects.toMatchObject({ status: 500 });
    expect(deploymentsOf(fake)).toEqual([]);
    expect(await record(fake, sha)).toMatchObject({ created: true });
    expect(fake.snapshot()).toEqual(await cleanSnapshot());
  });

  it("reuses the deployment on a rerun after the create answer was lost", async () => {
    const { fake, sha } = await project();
    fake.failNext({ method: "POST", path: DEPLOYMENTS, status: 502, after: true });
    await expect(record(fake, sha)).rejects.toMatchObject({ status: 502 });
    const writes = fake.writes().length;
    expect(await record(fake, sha)).toEqual({ deployment_id: 1, created: false });
    expect(fake.writes()).toHaveLength(writes);
    expect(fake.snapshot()).toEqual(await cleanSnapshot());
  });

  it("reaches the clean state after the status update fails before GitLab applies it", async () => {
    const { fake, sha } = await project();
    await seedDeployment(fake, { sha, status: "running" });
    fake.failNext({ method: "PUT", path: `${DEPLOYMENTS}/1`, status: 500 });
    await expect(record(fake, sha)).rejects.toMatchObject({ status: 500 });
    expect(deploymentsOf(fake)[0]?.status).toBe("running");
    expect(await record(fake, sha)).toEqual({ deployment_id: 1, created: false });
    expect(fake.snapshot()).toEqual(await cleanSnapshot());
  });

  it("writes nothing on a rerun after the status update answer was lost", async () => {
    const { fake, sha } = await project();
    await seedDeployment(fake, { sha, status: "running" });
    fake.failNext({ method: "PUT", path: `${DEPLOYMENTS}/1`, status: 502, after: true });
    await expect(record(fake, sha)).rejects.toMatchObject({ status: 502 });
    const writes = fake.writes().length;
    expect(await record(fake, sha)).toEqual({ deployment_id: 1, created: false });
    expect(fake.writes()).toHaveLength(writes);
    expect(fake.snapshot()).toEqual(await cleanSnapshot());
  });

  it("throws when the list fails and writes nothing", async () => {
    const { fake, sha } = await project();
    const setup = fake.writes().length;
    fake.failNext({ method: "GET", path: DEPLOYMENTS, status: 500 });
    await expect(record(fake, sha)).rejects.toMatchObject({ status: 500 });
    expect(fake.writes()).toHaveLength(setup);
  });
});
