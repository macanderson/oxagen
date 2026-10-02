// `unlink_repository` (ADR-212). The steering record decides which code
// repositories a workspace links, so the handler reads workspace.toml on the
// steering repository's production branch before it changes anything:
//   - it lists the repository: the handler opens a steering PR that removes
//     the entry, and the head stays until that PR merges.
//   - it does not list it, is missing, or names another schema: the link
//     predates the steering record, and the handler deletes the head now,
//     under the workspace's repository lock.
//   - it names workspace/v1 and does not read: the handler refuses.
// The steering repository itself is never unlinked, and the binding versions
// a head pointed at always stay.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeCTX, TEST_CTX } from "./test-utils/fixtures";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  assertOrgRole: vi.fn(async () => "Owner"),
  resolveActingUserId: vi.fn(async (c: { userId: string | null }) => c.userId),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const __dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...__dbMock, withOrgDb: __dbMock.withTenantDb };
});

vi.mock("@oxagen/iam/org-role", () => ({
  assertOrgRole: mocks.assertOrgRole,
  resolveActingUserId: mocks.resolveActingUserId,
  resolveActorOrgRole: async () => null,
  resolveActorWorkspaceRole: async () => null,
}));

import { schema } from "@oxagen/database";
import { repositoryUnlink } from "@oxagen/oxagen/contracts/repository.unlink";
import { WORKSPACE_TOML_PATH } from "@oxagen/oxagen/steering-repo/paths";
import { schemaDirective } from "@oxagen/oxagen/steering-repo/schema-ids";
import type { SteeringRepository } from "./context.steering.github";
import type { RepositorySteeringHost } from "./repository.link";
import { workspaceRepositoriesLock } from "./repository.binding-write";
import { MemoryStore as ProposalStore } from "./context.steering.test-support";
import { createRepositoryUnlinkHandler } from "./repository.unlink";
import { readWorkspaceToml } from "./repository.workspace-toml";

const INPUT = { bindingId: "rpb_0123abcd" };

/** The workspace's steering repository, where workspace.toml lives. */
const STEERING_REPO: SteeringRepository = {
  provider: "github",
  owner: "acme",
  repo: "rules",
  fullName: "acme/rules",
  currentFullName: "acme/rules",
  defaultBranch: "main",
};

/**
 * A linked head, with every column the handler selects. The mixed case shows
 * that the branch and the workspace.toml entry are lowercase.
 */
const LINKED_HEAD = {
  id: "head-linked",
  role: "linked",
  provider: "github",
  owner: "Acme",
  name: "Docs",
  fullName: "Acme/Docs",
};

const REF = "github.com/acme/docs";
const BRANCH = "workspace/unlink-acme-docs-a9799a26";
const OPENED_URL = "https://github.com/acme/rules/pull/42";

/** A workspace/v1 file that lists `repositories` in order. */
function workspaceToml(repositories: string[]): string {
  return [
    schemaDirective("workspace/v1"),
    'schema = "workspace/v1"',
    'organization = "acme"',
    'workspace = "core-platform"',
    ...repositories.flatMap((url) => [
      "",
      "[[repositories]]",
      `url = ${JSON.stringify(url)}`,
    ]),
    "",
  ].join("\n");
}

/** What one transaction did, in order. */
interface TxLog {
  events: string[];
  locks: unknown[];
  deletes: unknown[];
}

/**
 * A transaction that answers the head read (select, from, innerJoin, where,
 * limit) with `rows` and records the lock, the delete, and any other write.
 */
function fakeTx(rows: unknown[], log: TxLog) {
  return {
    execute: async (query: unknown) => {
      log.events.push("lock");
      log.locks.push(query);
      return [];
    },
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: async () => {
              log.events.push("select");
              return rows;
            },
          }),
        }),
      }),
    }),
    delete: (table: unknown) => ({
      where: async () => {
        log.events.push("delete");
        log.deletes.push(table);
        return [];
      },
    }),
    update: () => {
      log.events.push("update");
      return { set: () => ({ where: async () => [] }) };
    },
    insert: () => {
      log.events.push("insert");
      return { values: async () => [] };
    },
  };
}

/**
 * The handler opens at most two transactions. The first reads the head. On
 * the delete path the second takes the lock, reads the head again, and
 * deletes it. `head` answers the first read and `locked` the second, which
 * defaults to `head`.
 */
function wire(opts: { head: unknown[]; locked?: unknown[] }): {
  read: TxLog;
  write: TxLog;
} {
  const read: TxLog = { events: [], locks: [], deletes: [] };
  const write: TxLog = { events: [], locks: [], deletes: [] };
  mocks.withTenantDb
    .mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(fakeTx(opts.head, read)),
    )
    .mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(fakeTx(opts.locked ?? opts.head, write)),
    );
  return { read, write };
}

/**
 * A steering host whose production branch holds `workspaceToml`, and which
 * finds `openPullRequest` already open on the steering PR's branch.
 */
function steering(opts: {
  workspaceToml: string | null;
  openPullRequest?: { number: number; htmlUrl: string; body: string };
}) {
  const host = {
    resolveRepository: vi.fn<RepositorySteeringHost["resolveRepository"]>(
      async () => STEERING_REPO,
    ),
    readFile: vi.fn<RepositorySteeringHost["readFile"]>(
      async () => opts.workspaceToml,
    ),
    ensureBranch: vi.fn<RepositorySteeringHost["ensureBranch"]>(
      async () => {},
    ),
    putFile: vi.fn<RepositorySteeringHost["putFile"]>(async () => ({
      commitSha: "c0ffee",
    })),
    findOpenPullRequest: vi.fn<RepositorySteeringHost["findOpenPullRequest"]>(
      async () => opts.openPullRequest ?? null,
    ),
    openPullRequest: vi.fn<RepositorySteeringHost["openPullRequest"]>(
      async () => ({ number: 42, htmlUrl: OPENED_URL }),
    ),
  };
  return { host, run: createRepositoryUnlinkHandler({ steering: host }) };
}

type Host = ReturnType<typeof steering>["host"];

/** The handler made no call on the steering host at all. */
function expectHostUntouched(host: Host) {
  for (const call of Object.values(host)) expect(call).not.toHaveBeenCalled();
}

/** The handler opened no steering PR and wrote nothing to a branch. */
function expectNoSteeringPullRequest(host: Host) {
  expect(host.ensureBranch).not.toHaveBeenCalled();
  expect(host.putFile).not.toHaveBeenCalled();
  expect(host.findOpenPullRequest).not.toHaveBeenCalled();
  expect(host.openPullRequest).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.assertOrgRole.mockResolvedValue("Owner");
  mocks.resolveActingUserId.mockImplementation(
    async (c: { userId: string | null }) => c.userId,
  );
});

describe("unlink_repository: the refusals", () => {
  it("refuses a caller who is not an org Owner or Admin or the workspace Owner, before it reads anything", async () => {
    mocks.assertOrgRole.mockRejectedValueOnce(new Error("org_role_required"));
    const { host, run } = steering({ workspaceToml: workspaceToml([REF]) });

    await expect(run(INPUT, makeCTX())).rejects.toThrow("org_role_required");

    expect(mocks.assertOrgRole).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u_1" }),
      { org: ["Owner", "Admin"], workspace: ["Owner"] },
    );
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expectHostUntouched(host);
  });

  it("checks the role against the acting user the context resolves (INV-29)", async () => {
    mocks.resolveActingUserId.mockResolvedValueOnce("u_acting");
    wire({ head: [LINKED_HEAD] });
    const { run } = steering({ workspaceToml: null });

    await run(INPUT, makeCTX({ userId: "u_session" }));

    expect(mocks.resolveActingUserId).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u_session" }),
    );
    expect(mocks.assertOrgRole).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u_acting" }),
      { org: ["Owner", "Admin"], workspace: ["Owner"] },
    );
  });

  it("refuses a binding id that no head in this workspace carries, and leaves the steering host alone", async () => {
    const { read } = wire({ head: [] });
    const { host, run } = steering({ workspaceToml: workspaceToml([REF]) });

    await expect(run(INPUT, makeCTX())).rejects.toMatchObject({
      code: "not_found",
      reason: "repository_not_linked",
    });

    expect(mocks.withTenantDb).toHaveBeenCalledTimes(1);
    expect(read.events).toEqual(["select"]);
    expect(read.deletes).toEqual([]);
    expectHostUntouched(host);
  });

  it("refuses the steering head with main_repo_unlink_refused, and leaves the steering host alone", async () => {
    const { read } = wire({
      head: [
        {
          ...LINKED_HEAD,
          id: "head-steering",
          role: "steering",
          owner: "Acme",
          name: "Rules",
          fullName: "Acme/Rules",
        },
      ],
    });
    const { host, run } = steering({
      workspaceToml: workspaceToml(["github.com/acme/rules"]),
    });

    const err = await run(INPUT, makeCTX()).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toMatchObject({
      code: "conflict",
      reason: "main_repo_unlink_refused",
    });
    expect((err as Error).message).toContain("Acme/Rules");
    expect(mocks.withTenantDb).toHaveBeenCalledTimes(1);
    expect(read.events).toEqual(["select"]);
    expectHostUntouched(host);
  });

  it("refuses with workspace_toml_unreadable when workspace.toml names workspace/v1 and does not read, and changes nothing", async () => {
    const { read } = wire({ head: [LINKED_HEAD] });
    const { host, run } = steering({
      workspaceToml: `${schemaDirective("workspace/v1")}\n[stella\n`,
    });

    const err = await run(INPUT, makeCTX()).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toMatchObject({
      code: "conflict",
      reason: "workspace_toml_unreadable",
    });
    expect((err as Error).message).toMatch(
      /^workspace\.toml on acme\/rules@main does not read as workspace\/v1/,
    );
    expect(host.readFile).toHaveBeenCalledWith(
      STEERING_REPO,
      WORKSPACE_TOML_PATH,
      "main",
    );
    expect(mocks.withTenantDb).toHaveBeenCalledTimes(1);
    expect(read.deletes).toEqual([]);
    expectNoSteeringPullRequest(host);
  });
});

describe("unlink_repository: workspace.toml lists the repository", () => {
  it("opens a steering PR that removes the entry and keeps the others, and deletes no head", async () => {
    const { read } = wire({ head: [LINKED_HEAD] });
    const { host, run } = steering({
      workspaceToml: workspaceToml([
        "github.com/acme/api",
        REF,
        "github.com/acme/web",
      ]),
    });

    const out = await run(INPUT, makeCTX());

    expect(host.resolveRepository).toHaveBeenCalledWith({
      orgId: TEST_CTX.orgId,
      workspaceId: TEST_CTX.workspaceId,
    });
    expect(host.readFile).toHaveBeenCalledWith(
      STEERING_REPO,
      WORKSPACE_TOML_PATH,
      "main",
    );
    expect(host.ensureBranch).toHaveBeenCalledWith(
      STEERING_REPO,
      BRANCH,
      "main",
    );

    expect(host.putFile).toHaveBeenCalledTimes(1);
    expect(host.putFile.mock.calls[0]?.[0]).toBe(STEERING_REPO);
    const put = host.putFile.mock.calls[0]?.[1];
    expect(put).toMatchObject({ path: WORKSPACE_TOML_PATH, branch: BRANCH });
    // Read the new file back the way the steering sync will read it.
    expect(readWorkspaceToml(put?.content ?? null)).toMatchObject({
      kind: "read",
      repositories: ["github.com/acme/api", "github.com/acme/web"],
      value: { organization: "acme", workspace: "core-platform" },
    });

    expect(host.findOpenPullRequest).toHaveBeenCalledWith(STEERING_REPO, {
      head: BRANCH,
      base: "main",
    });
    expect(host.openPullRequest).toHaveBeenCalledWith(
      STEERING_REPO,
      expect.objectContaining({
        head: BRANCH,
        base: "main",
        title: "Unlink Acme/Docs",
      }),
    );

    expect(out).toEqual({
      bindingId: "rpb_0123abcd",
      fullName: "Acme/Docs",
      status: "proposed",
      unlinkedAt: null,
      steeringPullRequest: { number: 42, url: OPENED_URL, reused: false },
    });
    expect(repositoryUnlink.output.parse(out)).toEqual(out);

    // The head stays until the steering PR merges and the sync reads it.
    expect(mocks.withTenantDb).toHaveBeenCalledTimes(1);
    expect(read.events).toEqual(["select"]);
    expect(read.deletes).toEqual([]);
  });

  it("reuses the steering PR already open on the unlink branch", async () => {
    wire({ head: [LINKED_HEAD] });
    const { host, run } = steering({
      workspaceToml: workspaceToml([REF, "github.com/acme/api"]),
      openPullRequest: {
        number: 7,
        htmlUrl: "https://github.com/acme/rules/pull/7",
        body: "An earlier unlink of Acme/Docs.",
      },
    });

    const out = await run(INPUT, makeCTX());

    // The file lands on the branch first, so the reused PR carries it.
    expect(host.putFile).toHaveBeenCalledTimes(1);
    expect(host.openPullRequest).not.toHaveBeenCalled();
    expect(out).toEqual({
      bindingId: "rpb_0123abcd",
      fullName: "Acme/Docs",
      status: "proposed",
      unlinkedAt: null,
      steeringPullRequest: {
        number: 7,
        url: "https://github.com/acme/rules/pull/7",
        reused: true,
      },
    });
    expect(repositoryUnlink.output.parse(out)).toEqual(out);
    expect(mocks.withTenantDb).toHaveBeenCalledTimes(1);
  });
});

describe("unlink_repository: workspace.toml does not list the repository", () => {
  it.each([
    { file: "is missing", workspaceToml: null },
    {
      file: "lists other repositories",
      workspaceToml: workspaceToml(["github.com/acme/api"]),
    },
    { file: "names another schema", workspaceToml: '[tool]\nname = "other"\n' },
  ])(
    "deletes the legacy head under the lock when workspace.toml $file",
    async ({ workspaceToml: text }) => {
      const { write } = wire({ head: [LINKED_HEAD] });
      const { host, run } = steering({ workspaceToml: text });
      const before = Date.now();

      const out = await run(INPUT, makeCTX());

      expect(mocks.withTenantDb).toHaveBeenCalledTimes(2);
      // The lock comes first, so the re-read sees any unlink or sync that
      // committed before it.
      expect(write.events).toEqual(["lock", "select", "delete"]);
      expect(write.locks).toEqual([
        workspaceRepositoriesLock(TEST_CTX.workspaceId),
      ]);
      // Only the head goes. The binding versions it pointed at stay, because
      // admitted runs cite them.
      expect(write.deletes).toEqual([schema.repositoryBindingHeads]);

      expect(out).toMatchObject({
        bindingId: "rpb_0123abcd",
        fullName: "Acme/Docs",
        status: "unlinked",
        steeringPullRequest: null,
      });
      expect(out.unlinkedAt).not.toBeNull();
      expect(Date.parse(out.unlinkedAt ?? "")).toBeGreaterThanOrEqual(before);
      expect(repositoryUnlink.output.parse(out)).toEqual(out);
      expectNoSteeringPullRequest(host);
    },
  );

  it.each([
    { what: "gone", locked: [] },
    { what: "replaced", locked: [{ ...LINKED_HEAD, id: "head-other" }] },
  ])(
    "refuses with repository_not_linked when the locked re-read finds the head $what",
    async ({ locked }) => {
      const { write } = wire({ head: [LINKED_HEAD], locked });
      const { host, run } = steering({ workspaceToml: null });

      await expect(run(INPUT, makeCTX())).rejects.toMatchObject({
        code: "not_found",
        reason: "repository_not_linked",
      });

      expect(mocks.withTenantDb).toHaveBeenCalledTimes(2);
      expect(write.events).toEqual(["lock", "select"]);
      expect(write.deletes).toEqual([]);
      expectNoSteeringPullRequest(host);
    },
  );

  it("deletes a GitHub head whose name no workspace.toml ref can spell, instead of failing with an internal error", async () => {
    // `..` is no ref segment, so workspace.toml cannot list this head.
    const oddHead = { ...LINKED_HEAD, name: "..", fullName: "Acme/.." };
    const { write } = wire({ head: [oddHead] });
    const { host, run } = steering({ workspaceToml: workspaceToml([REF]) });

    const out = await run(INPUT, makeCTX());

    expect(write.events).toEqual(["lock", "select", "delete"]);
    expect(write.deletes).toEqual([schema.repositoryBindingHeads]);
    expect(out).toMatchObject({
      status: "unlinked",
      steeringPullRequest: null,
    });
    expect(repositoryUnlink.output.parse(out)).toEqual(out);
    expectNoSteeringPullRequest(host);
  });

  it("deletes a head on another provider even when workspace.toml lists a github.com entry of the same owner and name", async () => {
    const gitlabHead = { ...LINKED_HEAD, provider: "gitlab" };
    const { write } = wire({ head: [gitlabHead] });
    const { host, run } = steering({ workspaceToml: workspaceToml([REF]) });

    const out = await run(INPUT, makeCTX());

    expect(mocks.withTenantDb).toHaveBeenCalledTimes(2);
    expect(write.events).toEqual(["lock", "select", "delete"]);
    expect(write.deletes).toEqual([schema.repositoryBindingHeads]);
    expect(out).toMatchObject({
      status: "unlinked",
      steeringPullRequest: null,
    });
    expect(repositoryUnlink.output.parse(out)).toEqual(out);
    expectNoSteeringPullRequest(host);
  });
});

describe("unlink_repository: the proposal row (#5122)", () => {
  it("writes the PR's workspace proposal row, authored by the acting user a key resolves to", async () => {
    mocks.resolveActingUserId.mockResolvedValueOnce("u_key_owner");
    wire({ head: [LINKED_HEAD] });
    const { host } = steering({
      workspaceToml: workspaceToml(["github.com/acme/api", REF]),
    });
    const proposals = new ProposalStore();
    const run = createRepositoryUnlinkHandler({ steering: host, proposals });

    await run(INPUT, makeCTX({ userId: null, apiKeyId: "key_1" }));

    expect(proposals.proposals).toHaveLength(1);
    expect(proposals.proposals[0]).toMatchObject({
      kind: "workspace",
      lineageId: BRANCH,
      status: "pr_open",
      prNumber: 42,
      createdById: "u_key_owner",
      source: "api_key:key_1",
    });
  });
});
