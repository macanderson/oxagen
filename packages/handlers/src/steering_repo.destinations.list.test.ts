// steering_repo.destinations.list.test.ts: list_steering_repo_destinations
// lists the places the provisioning job would accept, over the in-memory
// GitHub fake and a scripted GitLab group list.
import { HandlerError } from "@oxagen/oxagen";
import { steeringRepoDestinationsList } from "@oxagen/oxagen/contracts/steering_repo.destinations.list";
import { OXAGEN_STEERING_APP } from "@oxagen/oxagen/steering-repo";
import {
  FAKE_USER_LOGIN,
  FakeGithub,
  type FakeGithubInstallation,
} from "@oxagen/github/provision/testing";
import type { SteeringApp } from "@oxagen/github/provision";
import {
  SteeringGitlabReauthorizeError,
  type SteeringGroup,
} from "@oxagen/gitlab/provision";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  role: vi.fn(async () => "Owner"),
  warn: vi.fn(),
}));

vi.mock("./lib/capability-role-guard", () => ({ assertContractRole: mocks.role }));
vi.mock("@oxagen/iam/org-role", () => ({
  resolveActingUserId: vi.fn(async (ctx: { userId: string | null }) => ctx.userId),
}));
vi.mock("./logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: mocks.warn, error: vi.fn() },
}));

import {
  createListSteeringRepoDestinationsHandler,
  type SteeringRepoDestinationsDeps,
} from "./steering_repo.destinations.list";
import type {
  GitlabSteeringClients,
  SteeringConnection,
} from "./steering_repo.provision";
import { TEST_CTX } from "./test-utils/fixtures";

const APP: SteeringApp = {
  symbol: OXAGEN_STEERING_APP,
  id: 9001,
  slug: "oxagen-steering-test",
};

const ORG_INSTALL: FakeGithubInstallation = {
  id: 77,
  account_login: "acme",
  account_type: "Organization",
  repository_selection: "selected",
};
const OWN_ACCOUNT: FakeGithubInstallation = {
  id: 78,
  account_login: FAKE_USER_LOGIN,
  account_type: "User",
  repository_selection: "selected",
};
const SOMEONE_ELSE: FakeGithubInstallation = {
  id: 79,
  account_login: "someone-else",
  account_type: "User",
  repository_selection: "selected",
};
const GROUP: SteeringGroup = { id: 42, full_path: "acme/platform" };

const STORED: SteeringConnection = {
  provider: "github",
  installation_id: 77,
  account_login: "acme",
  account_type: "Organization",
};

interface World {
  hub: FakeGithub | null;
  groups: () => Promise<SteeringGroup[]>;
  stored: SteeringConnection | null;
}

function world(over: Partial<World> = {}): World {
  return {
    hub: new FakeGithub({
      org: "acme",
      app: APP,
      user_installations: [ORG_INSTALL, OWN_ACCOUNT, SOMEONE_ELSE],
    }),
    groups: async () => [GROUP],
    stored: STORED,
    ...over,
  };
}

function depsOf(w: World): SteeringRepoDestinationsDeps {
  const gitlab: GitlabSteeringClients = {
    groups: w.groups,
    group: async () => null,
  };
  return {
    github: vi.fn((_orgId: string, _actor: string) => {
      const hub = w.hub;
      if (hub === null) return null;
      return {
        app: APP,
        installation: async () => hub.appRest(),
        user: async () => hub.userRest(),
      };
    }),
    gitlab: vi.fn((_orgId: string, _actor: string) => gitlab),
    readDefault: vi.fn(async (_orgId: string) => w.stored),
  };
}

const list = (deps: SteeringRepoDestinationsDeps, input: unknown = {}) =>
  createListSteeringRepoDestinationsHandler(deps)(
    steeringRepoDestinationsList.input.parse(input),
    TEST_CTX,
  );

beforeEach(() => {
  mocks.role.mockReset();
  mocks.role.mockImplementation(async () => "Owner");
  mocks.warn.mockReset();
});

describe("list_steering_repo_destinations", () => {
  it("lists every place the stored tokens reach, GitHub first, with the default", async () => {
    const deps = depsOf(world());
    const out = await list(deps, { slug: "support" });
    expect(out).toEqual({
      destinations: [
        { provider: "github", id: 77, name: "acme", kind: "organization" },
        { provider: "github", id: 78, name: FAKE_USER_LOGIN, kind: "user" },
        { provider: "gitlab", id: 42, name: "acme/platform", kind: "organization" },
      ],
      default: { provider: "github", id: 77, name: "acme", kind: "organization" },
      defaultName: "oxagen-support",
      reauthorize: [],
    });
    expect(steeringRepoDestinationsList.output.parse(out)).toEqual(out);
    // A personal account that is not the owner's own is left out, as the job
    // leaves it out.
    expect(out.destinations.map((d) => d.name)).not.toContain("someone-else");
    expect(deps.github).toHaveBeenCalledWith("org_1", "u_1");
    expect(deps.gitlab).toHaveBeenCalledWith("org_1", "u_1");
    expect(deps.readDefault).toHaveBeenCalledWith("org_1");
  });

  it("names the config workspace's default past the organization's own repository", async () => {
    const out = await list(depsOf(world()), { slug: "config" });
    expect(out.defaultName).toBe("oxagen-config-2");
  });

  it("names no default repository without a slug, and no default place before one is stored", async () => {
    const out = await list(depsOf(world({ stored: null })));
    expect(out.defaultName).toBeNull();
    expect(out.default).toBeNull();
    expect(out.destinations).toHaveLength(3);
  });

  it("still lists GitLab when GitHub refuses the stored owner token, and says GitHub needs an owner", async () => {
    const w = world();
    w.hub?.failNext({ method: "GET", path: "/user/installations", status: 401 });
    const out = await list(depsOf(w));
    expect(out.destinations).toEqual([
      { provider: "gitlab", id: 42, name: "acme/platform", kind: "organization" },
    ]);
    expect(out.reauthorize).toEqual(["github"]);
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org_1", host: "github" }),
      "list_steering_repo_destinations: the host refused the stored steering token",
    );
  });

  it("still lists GitHub when GitLab refuses the stored group token, and says GitLab needs an owner", async () => {
    const out = await list(
      depsOf(
        world({
          groups: async () => {
            throw new SteeringGitlabReauthorizeError("401 Unauthorized");
          },
        }),
      ),
    );
    expect(out.destinations.map((d) => d.provider)).toEqual(["github", "github"]);
    expect(out.reauthorize).toEqual(["gitlab"]);
  });

  it("fails the read on any other host failure (negative)", async () => {
    const failure = new Error("GitLab is down");
    await expect(
      list(
        depsOf(
          world({
            groups: async () => {
              throw failure;
            },
          }),
        ),
      ),
    ).rejects.toBe(failure);
  });

  it("lists no GitHub places, and asks for nothing, when the Oxagen GitHub App is not configured", async () => {
    const out = await list(depsOf(world({ hub: null })));
    expect(out.destinations).toEqual([
      { provider: "gitlab", id: 42, name: "acme/platform", kind: "organization" },
    ]);
    expect(out.reauthorize).toEqual([]);
  });

  it("lists nothing when nothing is connected", async () => {
    const out = await list(
      depsOf(world({ hub: null, groups: async () => [], stored: null })),
    );
    expect(out).toEqual({
      destinations: [],
      default: null,
      defaultName: null,
      reauthorize: [],
    });
  });

  it("refuses a caller the contract's roles do not admit, and calls no host", async () => {
    mocks.role.mockImplementation(async () => {
      throw new HandlerError({
        code: "forbidden",
        reason: "org_role_required",
        message: "Only an organization owner or admin can list these.",
      });
    });
    const deps = depsOf(world());
    await expect(list(deps)).rejects.toMatchObject({ code: "forbidden" });
    expect(deps.github).not.toHaveBeenCalled();
    expect(deps.gitlab).not.toHaveBeenCalled();
    expect(deps.readDefault).not.toHaveBeenCalled();
  });
});
