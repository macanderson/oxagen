import { describe, expect, it, vi } from "vitest";
import {
  STEERING_IMPORT_STEP_NAMES,
  STEERING_REPO_STEP_NAMES,
  steeringRepoGet,
} from "@oxagen/oxagen/contracts/steering_repo.get";
import type { SettingsDifference } from "@oxagen/oxagen/steering-repo/health";
import {
  createGetSteeringRepoHandler,
  NO_STEERING_REPO,
  PROVISIONED_VERSION,
  type SteeringRepoReadDeps,
  steeringRepoPublicationKey,
  steeringRepoUrl,
} from "./steering_repo.read";
import {
  initialSteeringRepoState,
  STEERING_REPO_STEPS,
  type SteeringRepoState,
} from "./steering_repo.provision";
import type { RepoHealthDetail } from "./steering-repo/health";
import {
  IMPORT_STEPS,
  initialImportState,
  type SteeringImportState,
} from "./steering-repo/import-run";
import type { LegacySteeringSource } from "./steering-repo/legacy-source";
import type { SteeringConnection } from "./steering_repo.provision";
import { steeringRepositoryKey } from "./steering-repo/publisher";
import { makeCTX, TEST_CTX } from "./test-utils/fixtures";

const READY: SteeringRepoState = {
  ...initialSteeringRepoState(new Date("2026-09-27T10:00:00Z")),
  status: "ready",
  step: "bind_repository",
  provider: "github",
  repository: {
    id: 42,
    owner: "acme",
    name: "oxagen-platform",
    full_name: "acme/oxagen-platform",
    initial_branch: "main",
  },
  commit_sha: "a1b2c3d",
  deployment_id: 7,
  binding_id: "rpb_0a1b",
};

const DRIFT: SettingsDifference = {
  setting: "rulesets.oxagen_merges",
  expected: { enforcement: "active" },
  actual: undefined,
  changed_by: "octocat",
  changed_at: "2026-09-27T09:00:00.000Z",
};

function detail(over: Partial<RepoHealthDetail> = {}): RepoHealthDetail {
  return {
    health: "drifted",
    differences: [DRIFT],
    reason: null,
    repository: "acme/oxagen-platform",
    revertPrNumber: null,
    checkedAt: "2026-09-27T10:00:00.000Z",
    changedAt: "2026-09-27T09:00:00.000Z",
    ...over,
  };
}

function deps(over: Partial<SteeringRepoReadDeps> = {}) {
  return {
    readState: vi.fn(async () => READY as SteeringRepoState | null),
    readPublishedVersion: vi.fn(async () => 3 as number | null),
    readHealth: vi.fn(async () => detail() as RepoHealthDetail | null),
    readLegacySource: vi.fn(async () => null as LegacySteeringSource | null),
    readConnection: vi.fn(async () => null as SteeringConnection | null),
    readImport: vi.fn(async () => null as SteeringImportState | null),
    ...over,
  };
}

const read = (d: SteeringRepoReadDeps, ctx = TEST_CTX) =>
  createGetSteeringRepoHandler(d)(steeringRepoGet.input.parse({}), ctx);

describe("get_steering_repo contract", () => {
  it("lists the provisioning steps the job runs, in order", () => {
    expect([...STEERING_REPO_STEP_NAMES]).toEqual([...STEERING_REPO_STEPS]);
  });

  it("lists the import run's steps, in order", () => {
    expect([...STEERING_IMPORT_STEP_NAMES]).toEqual([...IMPORT_STEPS]);
  });

  it("is a workspace read on api, mcp and agent that takes nothing", () => {
    expect(steeringRepoGet.scoped).toBe(true);
    expect(steeringRepoGet.mutates).toBe(false);
    expect(steeringRepoGet.surfaces).toEqual(["api", "mcp", "agent"]);
    expect(steeringRepoGet.input.safeParse({ workspaceId: "ws_1" }).success).toBe(
      false,
    );
  });
});

describe("get_steering_repo", () => {
  it("answers a ready repo with its link, version, health, and differences", async () => {
    const d = deps();
    const out = await read(d);
    expect(out).toEqual({
      status: "ready",
      step: "bind_repository",
      failedStep: null,
      error: null,
      provider: "github",
      repository: {
        fullName: "acme/oxagen-platform",
        url: "https://github.com/acme/oxagen-platform",
      },
      publishedVersion: 3,
      health: "drifted",
      differences: [
        {
          setting: "rulesets.oxagen_merges",
          expected: '{"enforcement":"active"}',
          actual: "unset",
          changedBy: "octocat",
          changedAt: "2026-09-27T09:00:00.000Z",
        },
      ],
      legacySource: null,
      connection: null,
      connectionChoices: [],
      importRun: null,
    });
    expect(steeringRepoGet.output.parse(out)).toEqual(out);
    expect(d.readState).toHaveBeenCalledWith({ orgId: "org_1", workspaceId: "ws_1" });
    expect(d.readImport).toHaveBeenCalledWith({ orgId: "org_1", workspaceId: "ws_1" });
    expect(d.readPublishedVersion).toHaveBeenCalledWith(
      { orgId: "org_1", workspaceId: "ws_1" },
      "github.com/acme/oxagen-platform",
    );
  });

  it("answers not_started with nulls when the workspace holds no state", async () => {
    const d = deps({ readState: vi.fn(async () => null) });
    const out = await read(d);
    expect(out).toEqual(NO_STEERING_REPO);
    expect(out.status).toBe("not_started");
    expect(steeringRepoGet.output.parse(out)).toEqual(out);
    expect(d.readHealth).not.toHaveBeenCalled();
  });

  it("names the code repository that still steers a workspace with no state", async () => {
    const out = await read(
      deps({
        readState: vi.fn(async () => null),
        readLegacySource: vi.fn(async () => ({
          provider: "github",
          full_name: "acme/agent-harness",
        })),
      }),
    );
    expect(out).toEqual({
      ...NO_STEERING_REPO,
      legacySource: {
        fullName: "acme/agent-harness",
        url: "https://github.com/acme/agent-harness",
        provider: "github",
      },
    });
    expect(steeringRepoGet.output.parse(out)).toEqual(out);
  });

  it("lists the connections a blocked setup chooses between", async () => {
    const out = await read(
      deps({
        readState: vi.fn(async () => ({
          ...initialSteeringRepoState(new Date(0)),
          status: "blocked" as const,
          failed_step: "pick_connection" as const,
          error: { code: "choose_connection", message: "Choose one." },
          connection_choices: [
            {
              provider: "github" as const,
              installation_id: 11,
              account_login: "acme",
            },
            {
              provider: "gitlab" as const,
              group_id: 22,
              group_path: "acme/platform",
            },
          ],
        })),
        readHealth: vi.fn(async () => null),
      }),
    );
    expect(out.connectionChoices).toEqual([
      { provider: "github", id: 11, name: "acme", kind: "organization" },
      { provider: "gitlab", id: 22, name: "acme/platform", kind: "organization" },
    ]);
    expect(steeringRepoGet.output.parse(out)).toEqual(out);
  });

  it("names the stored connection, and a personal account as a user", async () => {
    const out = await read(
      deps({
        readState: vi.fn(async () => null),
        readConnection: vi.fn(async () => ({
          provider: "github" as const,
          installation_id: 78,
          account_login: "octocat",
          account_type: "User" as const,
        })),
      }),
    );
    expect(out.connection).toEqual({
      provider: "github",
      id: 78,
      name: "octocat",
      kind: "user",
    });
    expect(steeringRepoGet.output.parse(out)).toEqual(out);
  });

  it("answers health null and no differences before the first health read", async () => {
    const out = await read(deps({ readHealth: vi.fn(async () => null) }));
    expect(out.health).toBeNull();
    expect(out.differences).toEqual([]);
  });

  it("answers version 1 once provisioning recorded it and no publish has run", async () => {
    const out = await read(deps({ readPublishedVersion: vi.fn(async () => null) }));
    expect(out.publishedVersion).toBe(PROVISIONED_VERSION);
  });

  it("answers no version and reads no publication before the repository exists", async () => {
    const d = deps({
      readState: vi.fn(async () => ({
        ...initialSteeringRepoState(new Date(0)),
        step: "pick_connection" as const,
        provider: "gitlab" as const,
      })),
      readHealth: vi.fn(async () => null),
    });
    const out = await read(d);
    expect(out).toMatchObject({
      status: "provisioning",
      step: "pick_connection",
      provider: "gitlab",
      repository: null,
      publishedVersion: null,
    });
    expect(d.readPublishedVersion).not.toHaveBeenCalled();
  });

  it("carries a failed step and its error", async () => {
    const out = await read(
      deps({
        readState: vi.fn(async () => ({
          ...READY,
          status: "blocked" as const,
          step: "write_first_commit" as const,
          failed_step: "apply_settings" as const,
          error: { code: "steering_reauthorize", message: "Authorize again." },
          deployment_id: null,
        })),
        readPublishedVersion: vi.fn(async () => null),
        readHealth: vi.fn(async () => null),
      }),
    );
    expect(out).toMatchObject({
      status: "blocked",
      failedStep: "apply_settings",
      error: { code: "steering_reauthorize", message: "Authorize again." },
      publishedVersion: null,
    });
  });

  it("links a GitLab repository in a nested group", async () => {
    const d = deps({
      readState: vi.fn(async () => ({
        ...READY,
        provider: "gitlab" as const,
        repository: {
          id: 43,
          owner: "acme/platform",
          name: "oxagen-web",
          full_name: "acme/platform/oxagen-web",
          initial_branch: "main",
        },
      })),
    });
    const out = await read(d);
    expect(out.repository).toEqual({
      fullName: "acme/platform/oxagen-web",
      url: "https://gitlab.com/acme/platform/oxagen-web",
    });
    expect(d.readPublishedVersion).toHaveBeenCalledWith(
      expect.anything(),
      "gitlab.com/acme/platform/oxagen-web",
    );
  });

  it("refuses a call without a workspace", async () => {
    // Empty string, not null: `CapabilityContext.workspaceId` is typed
    // non-nullable, and "" is what the kernel's unscoped path actually carries.
    await expect(read(deps(), makeCTX({ workspaceId: "" }))).rejects.toThrow(
      /workspaceId is required/,
    );
  });
});

describe("steeringRepoPublicationKey", () => {
  it("matches the key the publisher files publications under", () => {
    for (const [provider, owner, repo] of [
      ["github", "Acme", "Oxagen-Platform"],
      ["gitlab", "acme/platform", "oxagen-web"],
    ] as const) {
      const fullName = `${owner}/${repo}`;
      const base = { owner, repo, fullName, defaultBranch: "main" };
      const binding =
        provider === "gitlab"
          ? { ...base, provider, projectId: "99" }
          : { ...base, provider };
      expect(steeringRepoPublicationKey(provider, fullName)).toBe(
        steeringRepositoryKey(
          binding as unknown as Parameters<typeof steeringRepositoryKey>[0],
        ),
      );
    }
  });

  it("builds the host page from the full name", () => {
    expect(steeringRepoUrl("github", "acme/oxagen")).toBe("https://github.com/acme/oxagen");
    expect(steeringRepoUrl("gitlab", "acme/sub/oxagen")).toBe(
      "https://gitlab.com/acme/sub/oxagen",
    );
  });
});

describe("get_steering_repo import run (#5082)", () => {
  const SOURCE = {
    head_id: "rbh_1",
    connection_id: "conn_1",
    owner: "acme",
    name: "platform",
    full_name: "acme/platform",
    default_branch: "main",
    commit: "0123abc",
    relinked: "github.com/acme/platform",
  };

  it("answers a run that stopped after demote while the steering repo is ready", async () => {
    const stopped: SteeringImportState = {
      ...initialImportState(new Date("2026-10-01T17:46:00Z")),
      status: "failed",
      step: "demote",
      source: SOURCE,
      error: { code: "steering_repo_provision_failed", message: "The bind failed." },
    };
    const out = await read(deps({ readImport: vi.fn(async () => stopped) }));
    expect(out.status).toBe("ready");
    expect(out.importRun).toEqual({
      status: "failed",
      step: "demote",
      source: { fullName: "acme/platform", url: "https://github.com/acme/platform" },
      pullRequests: [],
      cleanup: null,
      error: { code: "steering_repo_provision_failed", message: "The bind failed." },
    });
    expect(steeringRepoGet.output.parse(out)).toEqual(out);
  });

  it("answers a finished run with its steering PRs and the cleanup PR", async () => {
    const done: SteeringImportState = {
      ...initialImportState(new Date("2026-10-01T17:46:00Z")),
      status: "done",
      step: "cleanup",
      outcome: "imported",
      source: SOURCE,
      steering_repository: "acme/oxagen-platform",
      pull_requests: [
        {
          branch: "workspace/import-oxagen",
          number: 4,
          url: "https://github.com/acme/oxagen-platform/pull/4",
        },
      ],
      cleanup: { number: 9, url: "https://github.com/acme/platform/pull/9" },
    };
    const out = await read(deps({ readImport: vi.fn(async () => done) }));
    expect(out.importRun).toEqual({
      status: "done",
      step: "cleanup",
      source: { fullName: "acme/platform", url: "https://github.com/acme/platform" },
      pullRequests: [
        {
          number: 4,
          url: "https://github.com/acme/oxagen-platform/pull/4",
          branch: "workspace/import-oxagen",
        },
      ],
      cleanup: { number: 9, url: "https://github.com/acme/platform/pull/9" },
      error: null,
    });
    expect(steeringRepoGet.output.parse(out)).toEqual(out);
  });

  it("answers the run on a workspace with no provisioning state", async () => {
    const waiting: SteeringImportState = {
      ...initialImportState(new Date("2026-10-01T17:46:00Z")),
      status: "waiting",
      outcome: "needs_choices",
    };
    const out = await read(
      deps({
        readState: vi.fn(async () => null),
        readImport: vi.fn(async () => waiting),
      }),
    );
    expect(out.status).toBe("not_started");
    expect(out.importRun).toMatchObject({ status: "waiting", step: null, source: null });
    expect(steeringRepoGet.output.parse(out)).toEqual(out);
  });
});
