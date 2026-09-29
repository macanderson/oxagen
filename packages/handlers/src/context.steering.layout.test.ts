import { describe, expect, it, vi } from "vitest";
import { fixtureRepo } from "@oxagen/oxagen/steering-repo/fixture-repo";
import type { SteeringHost, SteeringRepository } from "./context.steering.github";
import { createGetSteeringLayoutHandler } from "./context.steering.layout";
import type { SteeringDeps } from "./context.steering.deps";

const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
};
const REPO: SteeringRepository = {
  provider: "github",
  owner: "a-intel",
  repo: "oxagen-core-platform",
  fullName: "a-intel/oxagen-core-platform",
  currentFullName: "a-intel/oxagen-core-platform",
  defaultBranch: "main",
};

function ctx() {
  return { orgId: SCOPE.orgId, workspaceId: SCOPE.workspaceId } as Parameters<
    ReturnType<typeof createGetSteeringLayoutHandler>
  >[1];
}

/** A host over `files`, resolving `REPO` on every call. */
function fakeHost(files: Map<string, string>): SteeringHost {
  return {
    resolveRepository: vi.fn(async () => REPO),
    readFile: vi.fn(
      async (_repo: SteeringRepository, path: string) => files.get(path) ?? null,
    ),
  } as unknown as SteeringHost;
}

describe("get_steering_layout", () => {
  it("answers steering for a repository carrying steering/governance.toml", async () => {
    const handler = createGetSteeringLayoutHandler({
      github: fakeHost(fixtureRepo()),
    } as Pick<SteeringDeps, "github">);
    await expect(handler({}, ctx())).resolves.toEqual({ layout: "steering" });
  });

  it("answers legacy for a repository with no steering/governance.toml", async () => {
    const handler = createGetSteeringLayoutHandler({
      github: fakeHost(new Map()),
    } as Pick<SteeringDeps, "github">);
    await expect(handler({}, ctx())).resolves.toEqual({ layout: "legacy" });
  });

  it("answers null when no repository is bound", async () => {
    const github = {
      resolveRepository: vi.fn(async () => {
        throw new Error("workspace_repository_missing");
      }),
      readFile: vi.fn(),
    } as unknown as SteeringHost;
    const handler = createGetSteeringLayoutHandler({
      github,
    } as Pick<SteeringDeps, "github">);
    await expect(handler({}, ctx())).resolves.toEqual({ layout: null });
  });

  it("answers null rather than a guess when the governance read fails", async () => {
    const github = {
      resolveRepository: vi.fn(async () => REPO),
      readFile: vi.fn(async () => {
        throw new Error("rate limited");
      }),
    } as unknown as SteeringHost;
    const handler = createGetSteeringLayoutHandler({
      github,
    } as Pick<SteeringDeps, "github">);
    await expect(handler({}, ctx())).resolves.toEqual({ layout: null });
  });

  it("answers null when governance.toml does not parse", async () => {
    const files = fixtureRepo();
    files.set("steering/governance.toml", "not = valid = toml = at = all");
    const handler = createGetSteeringLayoutHandler({
      github: fakeHost(files),
    } as Pick<SteeringDeps, "github">);
    await expect(handler({}, ctx())).resolves.toEqual({ layout: null });
  });
});
