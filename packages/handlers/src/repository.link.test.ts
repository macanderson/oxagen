// `link_repository` (ADR-212). The handler writes no head. It opens a steering
// PR that adds the repository to workspace.toml on the steering repository's
// production branch, and the steering sync writes the head once that PR
// merges.
//
// The repository checks in `repository.link.write.ts` are stubs here, so each
// case names the refusal the handler must pass through. The steering host is
// a fake passed in deps, so the steering PR runs for real through
// `repository.steering-pr.ts` and `repository.workspace-toml.ts`.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OXAGEN_PR_LABELS, type GitHubRepoInfo } from "@oxagen/github";
import { HandlerError } from "@oxagen/oxagen";
import { repositoryLink } from "@oxagen/oxagen/contracts/repository.link";
import { WORKSPACE_TOML_PATH } from "@oxagen/oxagen/steering-repo/paths";
import { schemaDirective } from "@oxagen/oxagen/steering-repo/schema-ids";
import type { SteeringRepository } from "./context.steering.github";
import {
  createRepositoryLinkHandler,
  readWorkspaceNames,
  type RepositoryLinkDeps,
  type RepositorySteeringHost,
} from "./repository.link";
import type { LinkTarget } from "./repository.link.write";
import { readWorkspaceToml } from "./repository.workspace-toml";
import { MemoryStore as ProposalStore } from "./context.steering.test-support";
import { makeCTX } from "./test-utils/fixtures";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  withSystemDb: vi.fn(),
  assertOrgRole: vi.fn(async () => "Owner"),
  resolveActingUserId: vi.fn(async (c: { userId: string | null }) => c.userId),
  resolveLinkTarget:
    vi.fn<typeof import("./repository.link.write").resolveLinkTarget>(),
  assertLinkAllowed:
    vi.fn<typeof import("./repository.link.write").assertLinkAllowed>(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const __dbMock = {
    ...real,
    withTenantDb: mocks.withTenantDb,
    withSystemDb: mocks.withSystemDb,
  };
  return { ...__dbMock, withOrgDb: __dbMock.withTenantDb };
});

vi.mock("@oxagen/iam/org-role", () => ({
  assertOrgRole: mocks.assertOrgRole,
  resolveActingUserId: mocks.resolveActingUserId,
  resolveActorOrgRole: async () => null,
  resolveActorWorkspaceRole: async () => null,
}));

// The checks the steering sync also runs before it writes a head. Here they
// are seams, so a case can refuse at either one and watch what follows.
vi.mock("./repository.link.write", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./repository.link.write")>()),
  resolveLinkTarget: mocks.resolveLinkTarget,
  assertLinkAllowed: mocks.assertLinkAllowed,
}));

const SCOPE = { orgId: "org_1", workspaceId: "ws_1" };

/** The repository as the installation sees it. GitHub keeps the owner's case. */
const REPO: GitHubRepoInfo = {
  id: "9002",
  owner: "Acme",
  name: "Docs",
  fullName: "Acme/Docs",
  htmlUrl: "https://github.com/Acme/Docs",
  defaultBranch: "main",
};

const TARGET: LinkTarget = {
  connection: { id: "conn-uuid", publicId: "con_abc" },
  repo: REPO,
};

const INPUT = { provider: "github" as const, owner: "acme", name: "docs" };

/** The transaction `withTenantDb` hands the link check. */
const TX = { tx: "tenant" };

/**
 * The workspace's steering repository. Its production branch is not `main`,
 * so a PR base of `production` can only have come from here.
 */
const STEERING: SteeringRepository = {
  provider: "github",
  owner: "acme",
  repo: "steering",
  fullName: "acme/steering",
  currentFullName: "acme/steering",
  defaultBranch: "production",
};

/** How workspace.toml lists `REPO`: lowercase, host first. */
const REF = "github.com/acme/docs";
const BRANCH = "workspace/link-acme-docs-a9799a26";
const PR_URL = "https://github.com/acme/steering/pull/12";
const NAMES = { organization: "a-intel", workspace: "core-platform" };

/** A workspace/v1 file that lists `urls` as `[[repositories]]` entries. */
function workspaceToml(...urls: string[]): string {
  return [
    schemaDirective("workspace/v1"),
    'schema = "workspace/v1"',
    'organization = "a-intel"',
    'workspace = "core-platform"',
    ...urls.flatMap((url) => ["", "[[repositories]]", `url = "${url}"`]),
    "",
  ].join("\n");
}

/** A steering host whose production branch holds `toml` at workspace.toml. */
function steeringHost(toml: string | null) {
  return {
    resolveRepository: vi.fn<RepositorySteeringHost["resolveRepository"]>(
      async () => STEERING,
    ),
    readFile: vi.fn<RepositorySteeringHost["readFile"]>(async () => toml),
    ensureBranch: vi.fn<RepositorySteeringHost["ensureBranch"]>(
      async () => undefined,
    ),
    putFile: vi.fn<RepositorySteeringHost["putFile"]>(async () => ({
      commitSha: "c0ffee",
    })),
    findOpenPullRequest: vi.fn<RepositorySteeringHost["findOpenPullRequest"]>(
      async () => null,
    ),
    openPullRequest: vi.fn<RepositorySteeringHost["openPullRequest"]>(
      async () => ({ number: 12, htmlUrl: PR_URL }),
    ),
  };
}

type SteeringFake = ReturnType<typeof steeringHost>;

function handler(
  toml: string | null,
  names: { organization: string; workspace: string } | null = NAMES,
) {
  const steering = steeringHost(toml);
  const workspaceNames = vi.fn<RepositoryLinkDeps["workspaceNames"]>(
    async () => names,
  );
  const deps: RepositoryLinkDeps = {
    repository: vi.fn<RepositoryLinkDeps["repository"]>(async () => REPO),
    steering,
    workspaceNames,
  };
  return {
    run: createRepositoryLinkHandler(deps),
    deps,
    steering,
    workspaceNames,
  };
}

/** The error a call rejects with. Fails the test when the call resolves. */
async function refusal(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    () => {
      throw new Error("expected the handler to refuse");
    },
    (err: unknown) => err,
  );
}

/** The content the steering PR wrote to workspace.toml. */
function writtenContent(steering: SteeringFake): string {
  const call = steering.putFile.mock.calls[0];
  if (!call) throw new Error("the handler did not write workspace.toml");
  return call[1].content;
}

/** When a mock was first called, across every mock in the test. */
function firstCall(fn: { mock: { invocationCallOrder: number[] } }): number {
  const at = fn.mock.invocationCallOrder[0];
  if (at === undefined) throw new Error("the mock was not called");
  return at;
}

function expectNoSteeringPr(steering: SteeringFake): void {
  expect(steering.ensureBranch).not.toHaveBeenCalled();
  expect(steering.putFile).not.toHaveBeenCalled();
  expect(steering.findOpenPullRequest).not.toHaveBeenCalled();
  expect(steering.openPullRequest).not.toHaveBeenCalled();
}

function expectSteeringUntouched(steering: SteeringFake): void {
  expect(steering.resolveRepository).not.toHaveBeenCalled();
  expect(steering.readFile).not.toHaveBeenCalled();
  expectNoSteeringPr(steering);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.assertOrgRole.mockResolvedValue("Owner");
  mocks.resolveActingUserId.mockImplementation(
    async (c: { userId: string | null }) => c.userId,
  );
  mocks.withTenantDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => fn(TX),
  );
  mocks.resolveLinkTarget.mockResolvedValue(TARGET);
  mocks.assertLinkAllowed.mockResolvedValue(undefined);
});

describe("link_repository: role gate", () => {
  it("refuses a caller who is not an org Owner or Admin or the workspace Owner, before it reads anything", async () => {
    const denied = new Error("org_role_required");
    mocks.assertOrgRole.mockRejectedValueOnce(denied);
    const { run, steering, workspaceNames } = handler(workspaceToml());

    await expect(run(INPUT, makeCTX())).rejects.toBe(denied);

    expect(mocks.assertOrgRole).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u_1" }),
      { org: ["Owner", "Admin"], workspace: ["Owner"] },
    );
    expect(mocks.resolveLinkTarget).not.toHaveBeenCalled();
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(mocks.assertLinkAllowed).not.toHaveBeenCalled();
    expect(workspaceNames).not.toHaveBeenCalled();
    expectSteeringUntouched(steering);
  });

  it("checks the role of the acting user the context resolves (INV-29)", async () => {
    mocks.resolveActingUserId.mockResolvedValueOnce("u_acting");
    const { run } = handler(workspaceToml(REF));

    await run(INPUT, makeCTX({ userId: "u_session" }));

    expect(mocks.resolveActingUserId).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u_session" }),
    );
    expect(mocks.assertOrgRole).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u_acting",
        orgId: "org_1",
        workspaceId: "ws_1",
      }),
      { org: ["Owner", "Admin"], workspace: ["Owner"] },
    );
  });
});

describe("link_repository: repository checks", () => {
  it.each([
    ["github_not_connected", "conflict"],
    ["repository_not_installed", "not_found"],
  ] as const)(
    "passes a %s refusal from resolveLinkTarget through and leaves the steering repository alone",
    async (reason, code) => {
      const refused = new HandlerError({ code, reason, message: reason });
      mocks.resolveLinkTarget.mockRejectedValueOnce(refused);
      const { run, steering, workspaceNames } = handler(workspaceToml());

      await expect(run(INPUT, makeCTX())).rejects.toBe(refused);

      expect(mocks.withTenantDb).not.toHaveBeenCalled();
      expect(mocks.assertLinkAllowed).not.toHaveBeenCalled();
      expect(workspaceNames).not.toHaveBeenCalled();
      expectSteeringUntouched(steering);
    },
  );

  it.each([
    ["main_repo_unbound", "conflict"],
    ["main_repo", "conflict"],
    ["repository_already_linked", "conflict"],
  ] as const)(
    "passes a %s refusal from assertLinkAllowed through and leaves the steering repository alone",
    async (reason, code) => {
      const refused = new HandlerError({ code, reason, message: reason });
      mocks.assertLinkAllowed.mockRejectedValueOnce(refused);
      const { run, steering, workspaceNames } = handler(workspaceToml());

      await expect(run(INPUT, makeCTX())).rejects.toBe(refused);

      expect(mocks.assertLinkAllowed).toHaveBeenCalledWith(TX, SCOPE, REPO);
      expect(workspaceNames).not.toHaveBeenCalled();
      expectSteeringUntouched(steering);
    },
  );

  it("runs both checks on the caller's scope before it reads the steering repository", async () => {
    const { run, deps, steering } = handler(workspaceToml(REF));

    await run(INPUT, makeCTX());

    // The caller names the repository. The installation, never the caller,
    // decides which repository that is.
    expect(mocks.resolveLinkTarget).toHaveBeenCalledWith(
      SCOPE,
      "acme",
      "docs",
      deps,
    );
    // The heads check runs on the tenant transaction, against the repository
    // the installation answered with.
    expect(mocks.withTenantDb).toHaveBeenCalledTimes(1);
    expect(mocks.assertLinkAllowed).toHaveBeenCalledWith(TX, SCOPE, REPO);
    expect(firstCall(mocks.assertLinkAllowed)).toBeLessThan(
      firstCall(steering.resolveRepository),
    );
    expect(steering.resolveRepository).toHaveBeenCalledWith(SCOPE);
  });
});

describe("link_repository: workspace.toml", () => {
  it("answers listed with no steering PR when workspace.toml already lists the repository", async () => {
    // GitHub names the repository Acme/Docs. workspace.toml lists it in
    // lowercase, and the handler still finds it.
    const { run, steering, workspaceNames } = handler(
      workspaceToml("github.com/acme/other", REF),
    );

    const out = await run(INPUT, makeCTX());

    expect(out).toEqual({
      fullName: "Acme/Docs",
      defaultRef: "main",
      status: "listed",
      steeringPullRequest: null,
    });
    expect(repositoryLink.output.parse(out)).toEqual(out);
    // The file is read from the production branch of the steering repository.
    expect(steering.readFile).toHaveBeenCalledWith(
      STEERING,
      WORKSPACE_TOML_PATH,
      "production",
    );
    expect(workspaceNames).not.toHaveBeenCalled();
    expectNoSteeringPr(steering);
  });

  it("creates workspace.toml with this one entry when the file is missing", async () => {
    const { run, steering, workspaceNames } = handler(null);

    const out = await run(INPUT, makeCTX());

    expect(out.status).toBe("proposed");
    expect(workspaceNames).toHaveBeenCalledWith(SCOPE);
    const read = readWorkspaceToml(writtenContent(steering));
    expect(read).toMatchObject({
      kind: "read",
      value: { organization: "a-intel", workspace: "core-platform" },
      repositories: [REF],
    });
  });

  it("refuses with workspace_not_found when workspace.toml is missing and the workspace has no slugs", async () => {
    const { run, steering } = handler(null, null);

    await expect(run(INPUT, makeCTX())).rejects.toMatchObject({
      code: "not_found",
      reason: "workspace_not_found",
    });
    expectNoSteeringPr(steering);
  });

  it("appends the entry to a workspace/v1 file that does not list it, and keeps the rest of the file", async () => {
    const original = workspaceToml("github.com/acme/other");
    const { run, steering, workspaceNames } = handler(original);

    const out = await run(INPUT, makeCTX());

    expect(out.status).toBe("proposed");
    expect(workspaceNames).not.toHaveBeenCalled();
    const content = writtenContent(steering);
    expect(content.startsWith(original)).toBe(true);
    expect(readWorkspaceToml(content)).toMatchObject({
      kind: "read",
      value: { organization: "a-intel", workspace: "core-platform" },
      repositories: ["github.com/acme/other", REF],
    });
  });

  it.each([
    [
      "names another schema",
      '[tool]\nname = "other"\n',
      "does not name the workspace/v1 schema on its first line",
    ],
    [
      "names workspace/v1 and does not read against it",
      `${schemaDirective("workspace/v1")}\n[stella\n`,
      "does not read as workspace/v1",
    ],
  ] as const)(
    "refuses to edit a workspace.toml that %s",
    async (_case, text, detail) => {
      const { run, steering, workspaceNames } = handler(text);

      const err = await refusal(run(INPUT, makeCTX()));

      expect(err).toBeInstanceOf(HandlerError);
      expect(err).toMatchObject({
        code: "conflict",
        reason: "workspace_toml_unreadable",
      });
      const message = (err as HandlerError).message;
      expect(message).toContain(
        `${WORKSPACE_TOML_PATH} on acme/steering@production`,
      );
      expect(message).toContain(detail);
      expect(workspaceNames).not.toHaveBeenCalled();
      expectNoSteeringPr(steering);
    },
  );
});

describe("link_repository: the steering PR", () => {
  it("opens the steering PR from workspace/link-<owner>-<name>-<hash> into the production branch", async () => {
    const { run, steering } = handler(workspaceToml("github.com/acme/other"));

    const out = await run(INPUT, makeCTX());

    // The branch name is lowercase, whatever case GitHub gives the repository.
    expect(steering.ensureBranch).toHaveBeenCalledWith(
      STEERING,
      BRANCH,
      "production",
    );
    expect(steering.putFile).toHaveBeenCalledWith(STEERING, {
      path: WORKSPACE_TOML_PATH,
      content: expect.any(String),
      message: "Link Acme/Docs to the workspace",
      branch: BRANCH,
    });
    expect(steering.findOpenPullRequest).toHaveBeenCalledWith(STEERING, {
      head: BRANCH,
      base: "production",
    });
    expect(steering.openPullRequest).toHaveBeenCalledWith(STEERING, {
      title: "Link Acme/Docs",
      head: BRANCH,
      base: "production",
      body: expect.stringContaining(REF),
      labels: OXAGEN_PR_LABELS,
    });
    // The file lands on the branch before the handler looks for an open PR,
    // so a reused PR always carries this change.
    expect(firstCall(steering.ensureBranch)).toBeLessThan(
      firstCall(steering.putFile),
    );
    expect(firstCall(steering.putFile)).toBeLessThan(
      firstCall(steering.findOpenPullRequest),
    );

    // `defaultRef` is the linked repository's branch, not the steering base.
    expect(out).toEqual({
      fullName: "Acme/Docs",
      defaultRef: "main",
      status: "proposed",
      steeringPullRequest: { number: 12, url: PR_URL, reused: false },
    });
    expect(repositoryLink.output.parse(out)).toEqual(out);
  });

  it("reuses the open steering PR on a second call for the same repository", async () => {
    const { run, steering } = handler(workspaceToml());
    steering.findOpenPullRequest.mockResolvedValueOnce({
      number: 12,
      htmlUrl: PR_URL,
      body: "",
    });

    const out = await run(INPUT, makeCTX());

    expect(steering.putFile).toHaveBeenCalledTimes(1);
    expect(steering.openPullRequest).not.toHaveBeenCalled();
    expect(out).toEqual({
      fullName: "Acme/Docs",
      defaultRef: "main",
      status: "proposed",
      steeringPullRequest: { number: 12, url: PR_URL, reused: true },
    });
    expect(repositoryLink.output.parse(out)).toEqual(out);
  });
});

describe("link_repository: steering host errors", () => {
  it.each([
    [
      "ensureBranch",
      (s: SteeringFake, err: Error) => s.ensureBranch.mockRejectedValueOnce(err),
    ],
    [
      "putFile",
      (s: SteeringFake, err: Error) => s.putFile.mockRejectedValueOnce(err),
    ],
    [
      "findOpenPullRequest",
      (s: SteeringFake, err: Error) =>
        s.findOpenPullRequest.mockRejectedValueOnce(err),
    ],
    [
      "openPullRequest",
      (s: SteeringFake, err: Error) =>
        s.openPullRequest.mockRejectedValueOnce(err),
    ],
  ] as const)(
    "maps a %s failure to conflict: github_refused",
    async (_step, fail) => {
      const { run, steering } = handler(null);
      fail(steering, new Error("GitHub answered 502 Bad Gateway"));

      await expect(run(INPUT, makeCTX())).rejects.toMatchObject({
        code: "conflict",
        reason: "github_refused",
        message: "GitHub answered 502 Bad Gateway",
      });
    },
  );

  it("maps a failed read of workspace.toml to conflict: github_refused and opens no steering PR", async () => {
    const { run, steering, workspaceNames } = handler(workspaceToml());
    steering.readFile.mockRejectedValueOnce(new Error("GitHub timed out"));

    const err = await refusal(run(INPUT, makeCTX()));

    expect(err).toBeInstanceOf(HandlerError);
    expect(err).toMatchObject({
      code: "conflict",
      reason: "github_refused",
      message: "GitHub timed out",
    });
    expect(workspaceNames).not.toHaveBeenCalled();
    expectNoSteeringPr(steering);
  });

  it("passes a refusal the steering host raises as itself", async () => {
    const missing = new HandlerError({
      code: "not_found",
      reason: "workspace_repository_missing",
      message: "This workspace has no steering repository",
    });
    const { run, steering } = handler(workspaceToml());
    steering.resolveRepository.mockRejectedValueOnce(missing);

    await expect(run(INPUT, makeCTX())).rejects.toBe(missing);
    expect(steering.readFile).not.toHaveBeenCalled();
    expectNoSteeringPr(steering);
  });
});

describe("readWorkspaceNames", () => {
  /** The organization read, then the workspace read, each through `.limit(1)`. */
  function slugReads(...results: Array<Array<{ slug: string }>>): void {
    mocks.withTenantDb.mockImplementationOnce(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          select: () => ({
            from: () => ({
              where: () => ({ limit: async () => results.shift() ?? [] }),
            }),
          }),
        }),
    );
  }

  it("answers the organization and workspace slugs", async () => {
    slugReads([{ slug: "a-intel" }], [{ slug: "core-platform" }]);
    await expect(readWorkspaceNames(SCOPE)).resolves.toEqual(NAMES);
  });

  it("answers null when the workspace no longer exists", async () => {
    slugReads([{ slug: "a-intel" }], []);
    await expect(readWorkspaceNames(SCOPE)).resolves.toBeNull();
  });
});

describe("link_repository: the proposal row (#5122)", () => {
  it("writes the PR's workspace proposal row, authored by the person who linked", async () => {
    const proposals = new ProposalStore();
    const { deps } = handler(workspaceToml("github.com/acme/other"));
    const run = createRepositoryLinkHandler({ ...deps, proposals });

    await run(INPUT, makeCTX());

    expect(proposals.proposals).toHaveLength(1);
    expect(proposals.proposals[0]).toMatchObject({
      kind: "workspace",
      lineageId: BRANCH,
      status: "pr_open",
      prNumber: 12,
      prUrl: PR_URL,
      headSha: "c0ffee",
      createdById: "u_1",
      source: "user:u_1",
    });
  });

  it("records the key's creator as the author of a link made with an API key, so they cannot merge it alone", async () => {
    mocks.resolveActingUserId.mockResolvedValueOnce("u_key_owner");
    const proposals = new ProposalStore();
    const { deps } = handler(workspaceToml("github.com/acme/other"));
    const run = createRepositoryLinkHandler({ ...deps, proposals });

    await run(INPUT, makeCTX({ userId: null, apiKeyId: "key_1" }));

    expect(proposals.proposals[0]).toMatchObject({
      createdById: "u_key_owner",
      source: "api_key:key_1",
    });
  });
});
