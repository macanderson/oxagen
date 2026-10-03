// S5's publish() bound to a workspace's steering repo (S3, #4449): the key
// every caller stores versions under, the bundle identity, the deps over the
// host, the merge's publisher, and the repository sync's publish port.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureRepo } from "@oxagen/oxagen/steering-repo/fixture-repo";
import {
  gitBlobId,
  memoryVersionStore,
  type PublishDeps,
} from "@oxagen/steering-bundle";
import type {
  SteeringHost,
  SteeringRepository,
} from "../context.steering.github";

const db = vi.hoisted(() => ({
  rows: [] as { organization: string; workspace: string }[],
  calls: 0,
}));
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The slug read is select → from → innerJoin → where → limit.
  const chain: Record<string, unknown> = {};
  for (const step of ["select", "from", "innerJoin", "where"])
    chain[step] = () => chain;
  chain.limit = async () => db.rows;
  return {
    ...real,
    withSystemDb: async (fn: (tx: unknown) => Promise<unknown>) => {
      db.calls += 1;
      return fn(chain);
    },
  };
});

const log = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock("../logger", () => ({ logger: log }));

import {
  steeringBundleIdentity,
  steeringPublishDeps,
  steeringPublisher,
  steeringRepositoryKey,
  steeringSyncPublish,
} from "./publisher";
import { heldVersionStore } from "./version-store";

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
const KEY = "github.com/a-intel/oxagen-core-platform";
const HEAD = "5eed000000000000000000000000000000000001";
const LATER = "5eed000000000000000000000000000000000002";

/** A host over one tree, whose production branch points at `head`. */
function fakeHost(files: Map<string, string> = fixtureRepo()) {
  const tags = new Map<string, string>();
  const host = {
    tags,
    resolveRepository: vi.fn(async () => REPO),
    assertSteeringCommit: vi.fn(async (_repo: SteeringRepository, _commit: string) => undefined),
    readFile: vi.fn(
      async (_repo: SteeringRepository, path: string) =>
        files.get(path) ?? null,
    ),
    branchHead: vi.fn(async (): Promise<string | null> => HEAD),
    listTree: vi.fn(async () =>
      [...files].map(([path, text]) => ({ path, blob: gitBlobId(text) })),
    ),
    createTag: vi.fn(
      async (_repo: SteeringRepository, name: string, sha: string) => {
        tags.set(name, sha);
      },
    ),
    recordDeployment: vi.fn(
      async (
        _repo: SteeringRepository,
        _args: {
          sha: string;
          ref: string;
          environment: string;
          description: string;
        },
      ): Promise<{ url: string | null }> => ({ url: DEPLOYMENTS }),
    ),
  };
  return { fake: host, host: host as unknown as SteeringHost };
}

const DEPLOYMENTS =
  "https://github.com/a-intel/oxagen-core-platform/deployments/steering";

// No server compiles here, so the bundle's tool manifest stays null.
const noCompiler = (deps: Omit<PublishDeps, "project">): PublishDeps => ({
  ...deps,
  compiler: () => {
    throw new Error("the publisher tests compile no tools");
  },
});
const now = () => new Date("2026-09-27T08:00:00Z");

beforeEach(() => {
  db.rows = [{ organization: "a-intel", workspace: "core-platform" }];
  db.calls = 0;
  log.warn.mockClear();
});

describe("steeringRepositoryKey", () => {
  it("names a GitHub repository by host, owner, and name, lowercased", () => {
    expect(
      steeringRepositoryKey({
        ...REPO,
        fullName: "A-Intel/Oxagen-Core-Platform",
      }),
    ).toBe(KEY);
  });

  it("keeps a GitLab project's nested group in the owner", () => {
    expect(
      steeringRepositoryKey({
        provider: "gitlab",
        projectId: "42",
        owner: "acme/platform/tools",
        repo: "steering",
        fullName: "Acme/Platform/Tools/Steering",
        currentFullName: "Acme/Platform/Tools/Steering",
        defaultBranch: "main",
      }),
    ).toBe("gitlab.com/acme/platform/tools/steering");
  });

  it("keys a renamed repository by the name its binding recorded", () => {
    expect(
      steeringRepositoryKey({ ...REPO, currentFullName: "a-intel/renamed" }),
    ).toBe(KEY);
  });
});

describe("steeringBundleIdentity", () => {
  it("names the repository and the workspace's slugs", async () => {
    await expect(steeringBundleIdentity(SCOPE, REPO)).resolves.toEqual({
      repository: KEY,
      scope: "workspace",
      organization: "a-intel",
      workspace: "core-platform",
    });
    expect(db.calls).toBe(1);
  });

  it("refuses a workspace outside the organization", async () => {
    db.rows = [];
    await expect(steeringBundleIdentity(SCOPE, REPO)).rejects.toMatchObject({
      code: "not_found",
      reason: "workspace_not_found",
    });
  });
});

describe("steeringPublishDeps", () => {
  it("refuses a repository key other than its own", async () => {
    const { host } = fakeHost();
    const deps = steeringPublishDeps({ scope: SCOPE, host, repo: REPO });
    const other = "github.com/a-intel/other";
    const refusal = /Compute the key with steeringRepositoryKey/;
    await expect(deps.health(other)).rejects.toThrow(refusal);
    await expect(deps.head(other)).rejects.toThrow(refusal);
    await expect(deps.tree(other, HEAD)).rejects.toThrow(refusal);
    await expect(deps.tag(other, "steering/1", HEAD)).rejects.toThrow(refusal);
  });

  it("reads healthy until S2 reports health, and reads its health after", async () => {
    const { host } = fakeHost();
    const plain = steeringPublishDeps({ scope: SCOPE, host, repo: REPO });
    await expect(plain.health(KEY)).resolves.toBe("healthy");
    const readHealth = vi.fn(async () => "drifted" as const);
    const read = steeringPublishDeps({
      scope: SCOPE,
      host,
      repo: REPO,
      readHealth,
    });
    await expect(read.health(KEY)).resolves.toBe("drifted");
    expect(readHealth).toHaveBeenCalledWith(REPO, SCOPE);
  });

  it("reads the production branch's head, and refuses when the branch is gone", async () => {
    const { fake, host } = fakeHost();
    const deps = steeringPublishDeps({ scope: SCOPE, host, repo: REPO });
    await expect(deps.head(KEY)).resolves.toBe(HEAD);
    expect(fake.branchHead).toHaveBeenCalledWith(REPO, "main");
    fake.branchHead.mockResolvedValueOnce(null);
    await expect(deps.head(KEY)).rejects.toMatchObject({
      code: "conflict",
      reason: "production_branch_missing",
    });
  });

  it("lists the merged tree with blob ids and reads its files at the commit", async () => {
    const { fake, host } = fakeHost();
    const deps = steeringPublishDeps({ scope: SCOPE, host, repo: REPO });
    const tree = await deps.tree(KEY, HEAD);
    const entries = await tree.list();
    expect(entries).toContainEqual({
      path: "workspace.toml",
      blob: gitBlobId(fixtureRepo().get("workspace.toml") ?? ""),
    });
    expect(fake.listTree).toHaveBeenCalledWith(REPO, HEAD);
    await expect(tree.read("workspace.toml")).resolves.toBe(
      fixtureRepo().get("workspace.toml"),
    );
    expect(fake.readFile).toHaveBeenCalledWith(REPO, "workspace.toml", HEAD);
    await expect(tree.read("missing.md")).rejects.toThrow(
      "the host returned no file",
    );
  });

  it("tags the commit on the host", async () => {
    const { fake, host } = fakeHost();
    const deps = steeringPublishDeps({ scope: SCOPE, host, repo: REPO });
    await deps.tag(KEY, "steering/3", HEAD);
    expect(fake.createTag).toHaveBeenCalledWith(REPO, "steering/3", HEAD);
  });

  it("stores in the workspace's Postgres store, reads the wall clock, and compiles with MCP Studio by default", () => {
    const { host } = fakeHost();
    const deps = steeringPublishDeps({ scope: SCOPE, host, repo: REPO });
    expect(typeof deps.store.versionAt).toBe("function");
    expect(deps.now()).toBeInstanceOf(Date);
    // No compiler, so buildBundle falls back to compileServerFolder.
    expect(deps.compiler).toBeUndefined();
    const publisher = steeringPublisher({ scope: SCOPE, host });
    expect(typeof publisher.store.highestVersion).toBe("function");
  });
});

describe("steeringPublisher", () => {
  it.each(["missing", "refused", "unavailable"] as const)(
    "publishes nothing with healthy stored health when provenance is %s",
    async (failure) => {
      const { fake, host } = fakeHost();
      if (failure === "missing") delete host.assertSteeringCommit;
      else fake.assertSteeringCommit.mockRejectedValueOnce(new Error(failure));
      const store = memoryVersionStore();
      const project = vi.fn(async () => undefined);
      const publisher = steeringPublisher({
        scope: SCOPE,
        host,
        store,
        readHealth: async () => "healthy",
        extend: (deps) => ({ ...noCompiler(deps), project }),
      });

      await expect(publisher.publish(REPO, HEAD)).rejects.toThrow();

      expect(fake.listTree).not.toHaveBeenCalled();
      expect(project).not.toHaveBeenCalled();
      expect(fake.createTag).not.toHaveBeenCalled();
      expect(await store.current(KEY)).toBeNull();
      expect(await store.highestVersion(KEY)).toBe(0);
    },
  );

  it("keeps GitLab publication independent of the GitHub verifier", async () => {
    const { host } = fakeHost();
    delete host.assertSteeringCommit;
    const repo: SteeringRepository = { ...REPO, provider: "gitlab", projectId: "42" };
    const deps = steeringPublishDeps({ scope: SCOPE, host, repo });
    await expect(deps.tree(steeringRepositoryKey(repo), HEAD)).resolves.toBeDefined();
  });

  it("publishes a merge into the store the merge reads, and tags it", async () => {
    const { fake, host } = fakeHost();
    const store = memoryVersionStore();
    const publisher = steeringPublisher({
      scope: SCOPE,
      host,
      store,
      extend: noCompiler,
      now,
    });
    expect(publisher.repository(REPO)).toBe(KEY);
    expect(publisher.store).toBe(store);

    const result = await publisher.publish(REPO, HEAD);
    expect(result).toMatchObject({
      status: "published",
      version: 1,
      commit: HEAD,
      tag: "steering/1",
      bundle: {
        repository: KEY,
        organization: "a-intel",
        workspace: "core-platform",
        commit: HEAD,
      },
    });
    await expect(publisher.store.versionAt(KEY, HEAD)).resolves.toEqual({
      version: 1,
      published: true,
    });
    expect(fake.tags.get("steering/1")).toBe(HEAD);
    expect(fake.assertSteeringCommit).toHaveBeenCalledWith(REPO, HEAD);

    // The same commit again is already published.
    await expect(publisher.publish(REPO, HEAD)).resolves.toMatchObject({
      status: "current",
      version: 1,
    });
  });

  // #5344: publish left every gRPC server out with a warning nothing logged,
  // so production showed no trace of why agents lost its tools.
  it("logs the servers a published version left out", async () => {
    const { host } = fakeHost();
    const publisher = steeringPublisher({
      scope: SCOPE,
      host,
      store: memoryVersionStore(),
      extend: noCompiler,
      now,
    });

    const result = await publisher.publish(REPO, HEAD);
    expect(result.status).toBe("published");
    const warnings = result.status === "published" ? result.warnings : [];
    expect(warnings).toEqual(
      expect.arrayContaining([
        "tools/servers/billing is left out: the publisher tests compile no tools",
        "tools/servers/stripe is left out: the publisher tests compile no tools",
      ]),
    );

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      {
        repository: KEY,
        workspaceId: SCOPE.workspaceId,
        version: 1,
        commit: HEAD,
        warnings,
      },
      "steering-repo: the published version left something out",
    );

    // A version already published logs nothing again.
    await publisher.publish(REPO, HEAD);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("publishes nothing while the repository is not healthy", async () => {
    const { fake, host } = fakeHost();
    const publisher = steeringPublisher({
      scope: SCOPE,
      host,
      store: memoryVersionStore(),
      readHealth: async () => "diverged",
    });
    await expect(publisher.publish(REPO, HEAD)).resolves.toEqual({
      status: "refused",
      health: "diverged",
    });
    expect(fake.listTree).not.toHaveBeenCalled();
  });
});

describe("steeringPublisher withLock", () => {
  it("publishes under the lock it holds, and a publish that takes the lock waits for it", async () => {
    const { host } = fakeHost();
    const store = memoryVersionStore();
    const publisher = steeringPublisher({
      scope: SCOPE,
      host,
      store,
      extend: noCompiler,
      now,
    });
    const order: string[] = [];
    let waiting: Promise<unknown> | null = null;
    const result = await publisher.withLock(REPO, async (held) => {
      // A sync's publish() takes the lock itself, so it waits for this one.
      waiting = publisher
        .publish(REPO, HEAD)
        .then((r) => order.push(`sync ${r.status}`));
      await new Promise((resolve) => setTimeout(resolve, 20));
      await expect(store.highestVersion(KEY)).resolves.toBe(0);
      const published = await held(HEAD);
      order.push(`held ${published.status}`);
      return published;
    });
    expect(result).toMatchObject({ status: "published", version: 1 });
    await waiting;
    // The sync ran after the hold ended and found the commit published.
    expect(order).toEqual(["held published", "sync current"]);
  });
});

describe("heldVersionStore", () => {
  it("runs withLock's callback at once and passes every other call to the store", async () => {
    const store = memoryVersionStore();
    const held = heldVersionStore(store);
    // The outer hold is still open when the held store's withLock runs, so
    // taking the store's lock again would never return.
    await expect(
      store.withLock(KEY, () => held.withLock(KEY, async () => "inner")),
    ).resolves.toBe("inner");

    await steeringPublisher({
      scope: SCOPE,
      host: fakeHost().host,
      store,
      extend: noCompiler,
      now,
    }).publish(REPO, HEAD);
    await expect(held.highestVersion(KEY)).resolves.toBe(1);
    await expect(held.versionAt(KEY, HEAD)).resolves.toEqual({
      version: 1,
      published: true,
    });
    await expect(held.current(KEY)).resolves.toMatchObject({ version: 1 });
  });
});

describe("steeringSyncPublish", () => {
  it("publishes the production head, and then answers current", async () => {
    const { fake, host } = fakeHost();
    const store = memoryVersionStore();
    const storeFor = vi.fn(() => store);
    const port = steeringSyncPublish({
      host,
      store: storeFor,
      extend: noCompiler,
      now,
    });
    await expect(port(SCOPE)).resolves.toEqual({
      status: "published",
      version: 1,
    });
    await expect(port(SCOPE)).resolves.toEqual({
      status: "current",
      version: 1,
    });
    expect(fake.resolveRepository).toHaveBeenCalledWith(SCOPE);
    expect(storeFor).toHaveBeenCalledWith(SCOPE);
    expect(store.published.get(KEY)?.commit).toBe(HEAD);
    // Unasked, as provisioning's first publish is, it records no deployment.
    expect(fake.recordDeployment).not.toHaveBeenCalled();
  });

  it("records a version it publishes as one deployment, and none when the head is current", async () => {
    const { fake, host } = fakeHost();
    const store = memoryVersionStore();
    const port = steeringSyncPublish({
      host,
      store: () => store,
      extend: noCompiler,
      now,
      recordDeployments: true,
    });
    await expect(port(SCOPE)).resolves.toEqual({
      status: "published",
      version: 1,
    });
    expect(fake.recordDeployment).toHaveBeenCalledTimes(1);
    expect(fake.recordDeployment).toHaveBeenCalledWith(REPO, {
      sha: HEAD,
      ref: "main",
      environment: "steering",
      description: "Steering version 1",
    });

    // The next sync finds the head published, so nothing new is deployed.
    await expect(port(SCOPE)).resolves.toEqual({
      status: "current",
      version: 1,
    });
    expect(fake.recordDeployment).toHaveBeenCalledTimes(1);
  });

  it("records no deployment for a refusal, a stale head, or the legacy layout", async () => {
    const { fake, host } = fakeHost();
    const refused = steeringSyncPublish({
      host,
      store: () => memoryVersionStore(),
      readHealth: async () => "diverged",
      recordDeployments: true,
    });
    await expect(refused(SCOPE)).resolves.toMatchObject({ status: "refused" });

    fake.branchHead.mockResolvedValueOnce(HEAD).mockResolvedValueOnce(LATER);
    const stale = steeringSyncPublish({
      host,
      store: () => memoryVersionStore(),
      extend: noCompiler,
      now,
      recordDeployments: true,
    });
    await expect(stale(SCOPE)).resolves.toMatchObject({ status: "stale" });

    const legacy = fakeHost(new Map([["README.md", "# Platform\n"]]));
    const port = steeringSyncPublish({
      host: legacy.host,
      store: () => memoryVersionStore(),
      recordDeployments: true,
    });
    await expect(port(SCOPE)).resolves.toBeNull();

    expect(fake.recordDeployment).not.toHaveBeenCalled();
    expect(legacy.fake.recordDeployment).not.toHaveBeenCalled();
  });

  it("keeps the published version when the host refuses the deployment record", async () => {
    const { fake, host } = fakeHost();
    fake.recordDeployment.mockRejectedValueOnce(new Error("403 Forbidden"));
    const store = memoryVersionStore();
    const port = steeringSyncPublish({
      host,
      store: () => store,
      extend: noCompiler,
      now,
      recordDeployments: true,
    });
    await expect(port(SCOPE)).resolves.toEqual({
      status: "published",
      version: 1,
    });
    expect(fake.recordDeployment).toHaveBeenCalledTimes(1);
    expect(store.published.get(KEY)?.version).toBe(1);
  });

  it("publishes nothing from a repository in the legacy layout", async () => {
    // No steering/governance.toml: the legacy layout, in its default mode.
    const legacy = new Map([["README.md", "# Platform\n"]]);
    const { fake, host } = fakeHost(legacy);
    const store = memoryVersionStore();
    const port = steeringSyncPublish({ host, store: () => store });
    await expect(port(SCOPE)).resolves.toBeNull();
    expect(fake.branchHead).not.toHaveBeenCalled();
    expect(store.versions.size).toBe(0);
  });

  it("reports a refusal and a stale head without a version", async () => {
    const { fake, host } = fakeHost();
    const refused = steeringSyncPublish({
      host,
      store: () => memoryVersionStore(),
      readHealth: async () => "disconnected",
    });
    await expect(refused(SCOPE)).resolves.toEqual({
      status: "refused",
      version: null,
    });

    // The branch moves between the port's head read and publish()'s own.
    fake.branchHead.mockResolvedValueOnce(HEAD).mockResolvedValueOnce(LATER);
    const stale = steeringSyncPublish({
      host,
      store: () => memoryVersionStore(),
      extend: noCompiler,
      now,
    });
    await expect(stale(SCOPE)).resolves.toEqual({
      status: "stale",
      version: null,
    });
  });

  it("refuses when the production branch is gone", async () => {
    const { fake, host } = fakeHost();
    fake.branchHead.mockResolvedValueOnce(null);
    const port = steeringSyncPublish({
      host,
      store: () => memoryVersionStore(),
    });
    await expect(port(SCOPE)).rejects.toMatchObject({
      reason: "production_branch_missing",
    });
  });
});
