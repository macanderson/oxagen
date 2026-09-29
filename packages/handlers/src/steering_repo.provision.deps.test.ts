// steering_repo.provision.deps.test.ts: the production wiring of the steering
// repo job (lane S1, #4450). steering_repo.provision.test.ts runs the steps on
// in-memory deps. This file covers what those deps stand in for: the settings
// readers, the Oxagen GitHub App config, the stored-token reader, the
// database writes, the steering binding, the Re-authorize notice, and the
// provision event.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@oxagen/database";
import { OXAGEN_STEERING_APP } from "@oxagen/oxagen/steering-repo";
import { getScope } from "@oxagen/tenancy";
import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

type Via = "system" | "tenant";

/** One builder call on a query chain. */
interface Call {
  method: string;
  args: unknown[];
}

/** One query: which connection ran it, the tenant scope it saw, its calls. */
interface Chain {
  via: Via;
  scope: unknown;
  op: string;
  calls: Call[];
}

const mocks = vi.hoisted(() => {
  const chains: Chain[] = [];
  const results: unknown[][] = [];
  const updateResults: unknown[][] = [];
  const dbCalls: Via[] = [];
  const builderMethods = [
    "from",
    "where",
    "limit",
    "orderBy",
    "set",
    "values",
    "returning",
    "innerJoin",
  ];
  // Each select, insert, update, or execute starts a chain that records every
  // builder call. Awaiting a select or an insert resolves the next queued
  // result. An update with `returning` resolves the next queued update result,
  // or no rows. Any other update, and every execute, resolves nothing and
  // takes no result from a queue.
  const makeTx = (via: Via, scope: unknown) => {
    const start =
      (op: string) =>
      (...args: unknown[]) => {
        const chain: Chain = { via, scope, op, calls: [{ method: op, args }] };
        chains.push(chain);
        const builder: Record<string, unknown> = {};
        for (const method of builderMethods)
          builder[method] = (...rest: unknown[]) => {
            chain.calls.push({ method, args: rest });
            return builder;
          };
        builder["then"] = (
          onFulfilled?: (value: unknown) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) => {
          const returning = chain.calls.some((c) => c.method === "returning");
          const value =
            op === "execute"
              ? undefined
              : op === "update"
                ? returning
                  ? (updateResults.shift() ?? [])
                  : undefined
                : (results.shift() ?? []);
          return Promise.resolve(value).then(onFulfilled, onRejected);
        };
        return builder;
      };
    return {
      select: start("select"),
      insert: start("insert"),
      update: start("update"),
      execute: start("execute"),
    };
  };
  return {
    chains,
    results,
    updateResults,
    dbCalls,
    makeTx,
    failure: { system: null as Error | null },
    decrypt: vi.fn(
      async (ciphertext: Buffer, _keyId: string, _options: unknown) =>
        ciphertext,
    ),
    resolveAdapter: vi.fn((keyId: string) => ({ adapter: { keyId } })),
    createAppInstallationToken: vi.fn(async (_args: unknown) => ({
      token: "ghs_installation",
    })),
    createGithubRest: vi.fn((options: { token: string }) => ({
      client: "github",
      token: options.token,
    })),
    createGitlabRest: vi.fn((options: { token: string }) => ({
      client: "gitlab",
      token: options.token,
    })),
    getGroup: vi.fn(
      async (
        _rest: unknown,
        id: number,
      ): Promise<{ id: number; full_path: string } | null> => ({
        id,
        full_path: `group-${id}`,
      }),
    ),
    notifyOrgManagers: vi.fn(
      async (_input: Record<string, unknown>) => undefined,
    ),
    send: vi.fn(async (_event: unknown) => undefined),
    writeRepositoryHead: vi.fn(async (_tx: unknown, _head: unknown) => ({
      bindingPublicId: "rpb_new",
    })),
    warn: vi.fn(),
    error: vi.fn(),
  };
});

vi.mock("@oxagen/database", async (importOriginal) => {
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...(await importOriginal<typeof import("@oxagen/database")>()),
    withSystemDb: async (fn: (tx: unknown) => unknown) => {
      mocks.dbCalls.push("system");
      if (mocks.failure.system) throw mocks.failure.system;
      return fn(mocks.makeTx("system", getScope()));
    },
    withTenantDb: async (fn: (tx: unknown) => unknown) => {
      mocks.dbCalls.push("tenant");
      return fn(mocks.makeTx("tenant", getScope()));
    },
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});
vi.mock("@oxagen/crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/crypto")>()),
  decrypt: mocks.decrypt,
  resolveIngestionCryptoAdapterForKeyId: mocks.resolveAdapter,
}));
vi.mock("@oxagen/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/github")>()),
  createAppInstallationToken: mocks.createAppInstallationToken,
}));
vi.mock("@oxagen/github/provision", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/github/provision")>()),
  createGithubRest: mocks.createGithubRest,
}));
vi.mock("@oxagen/gitlab/provision", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/gitlab/provision")>()),
  createGitlabRest: mocks.createGitlabRest,
  getGroup: mocks.getGroup,
}));
vi.mock("@oxagen/notifications", () => ({
  notifyOrgManagers: mocks.notifyOrgManagers,
}));
vi.mock("./event-client", () => ({ eventClient: { send: mocks.send } }));
vi.mock("./logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: mocks.warn, error: mocks.error },
}));
vi.mock("./repository.binding-write", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./repository.binding-write")>()),
  writeRepositoryHead: mocks.writeRepositoryHead,
}));

import {
  GITHUB_STEERING_PROVIDER,
  GITLAB_STEERING_PROVIDER,
  initialSteeringRepoState,
  keepSteeringConnection,
  moveSteeringInstallation,
  readSteeringConnection,
  readSteeringRepoState,
  requestSteeringRepoProvision,
  saveSteeringRepoState,
  settingsWithSteeringRepo,
  startSteeringRepoProvision,
  STEERING_REPO_PROVISION_EVENT,
  SteeringProvisionBlockedError,
  steeringAppFromEnv,
  steeringGroupToken,
  steeringInstallationRest,
  steeringRepoProvisionDeps,
  type SteeringConnection,
  type SteeringRepoProvisionRequest,
  type SteeringRepoScope,
  type SteeringRepoState,
  type SteeringRepository,
} from "./steering_repo.provision";
import { steeringHookToken } from "./lib/steering-hook";
import { workspaceRepositoriesLock } from "./repository.binding-write";

const ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3e";
const WS = "0192d4a8-7c1e-7a00-8000-0000000c0e01";
const ACTOR = "0192d4a8-7c1e-7a00-8000-0000000a0701";
const CONN = "0192d4a8-7c1e-7a00-8000-0000000c0c01";

const ENV = {
  GITHUB_APP_ID: "123",
  GITHUB_APP_PRIVATE_KEY: "pem",
  GITHUB_APP_SLUG: "oxagen-steering",
};

const WORKSPACE: Extract<SteeringRepoScope, { kind: "workspace" }> = {
  kind: "workspace",
  orgId: ORG,
  workspaceId: WS,
};
const ORGANIZATION: SteeringRepoScope = { kind: "organization", orgId: ORG };

const STATE: SteeringRepoState = initialSteeringRepoState(
  new Date("2026-09-26T12:00:00.000Z"),
);
const EMPTY_STATE = initialSteeringRepoState(new Date(0));

const GITHUB: SteeringConnection = {
  provider: "github",
  installation_id: 55,
  account_login: "acme",
};
const GITLAB: SteeringConnection = {
  provider: "gitlab",
  group_id: 12,
  group_path: "acme/platform",
};

const REPOSITORY: SteeringRepository = {
  id: 901,
  owner: "acme",
  name: "oxagen-platform",
  full_name: "acme/oxagen-platform",
  initial_branch: "master",
};

const REQUEST: SteeringRepoProvisionRequest = {
  orgId: ORG,
  workspaceId: WS,
  actorUserId: ACTOR,
};

const GITHUB_TITLE = "Authorize the Oxagen GitHub App again";
const GITHUB_BODY =
  "Oxagen could not finish setting up a steering repo because its GitHub authorization is missing or GitHub refused it. An organization owner must authorize the Oxagen GitHub App again.";
const GITLAB_TITLE = "Connect your GitLab group again";
const GITLAB_BODY =
  "Oxagen could not finish setting up a steering repo because the GitLab group token is missing or GitLab refused it. An organization owner must connect the group again.";

const dialect = new PgDialect();

/** Render a drizzle expression to its SQL text and parameters. */
function render(value: unknown): { sql: string; params: unknown[] } {
  const query = dialect.sqlToQuery(value as SQL);
  return { sql: query.sql, params: query.params };
}

function chain(index: number): Chain {
  const found = mocks.chains[index];
  if (!found) throw new Error(`no query chain at index ${index}`);
  return found;
}

function methods(c: Chain): string[] {
  return c.calls.map((call) => call.method);
}

function argOf(c: Chain, method: string, position = 0): unknown {
  const call = c.calls.find((x) => x.method === method);
  if (!call) throw new Error(`the chain never called ${method}`);
  return call.args[position];
}

function settingsOf(c: Chain): unknown {
  return (argOf(c, "set") as { settings: unknown }).settings;
}

/** The jsonb patch an update merged into a settings column. */
function savedPatch(c: Chain): unknown {
  return JSON.parse(String(render(settingsOf(c)).params[0]));
}

/** An oauth_accounts row whose ciphertext the mocked decrypt returns as is. */
function tokenRow(providerUserId: string, token: string, keyId = "key-1") {
  return {
    providerUserId,
    accessTokenEnc: {
      ciphertext: Buffer.from(token, "utf8").toString("base64"),
      keyId,
    },
    expiresAt: null as Date | null,
  };
}

function orgRow(settings: unknown) {
  return { slug: "acme", settings };
}

function deps(env: Readonly<Record<string, string | undefined>> = ENV) {
  return steeringRepoProvisionDeps({ actorUserId: ACTOR, env });
}

function githubClients(scope: SteeringRepoScope = WORKSPACE) {
  const clients = deps().github(scope);
  if (clients === null) throw new Error("the steering app config did not load");
  return clients;
}

beforeEach(() => {
  mocks.chains.length = 0;
  mocks.results.length = 0;
  mocks.updateResults.length = 0;
  mocks.dbCalls.length = 0;
  mocks.failure.system = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("readSteeringRepoState", () => {
  it("returns null when the settings hold no state", () => {
    for (const settings of [
      undefined,
      null,
      "text",
      7,
      {},
      { steering_repo: null },
    ])
      expect(readSteeringRepoState(settings)).toBeNull();
  });

  it("returns null when the state is malformed", () => {
    for (const value of ["ready", 5, true, {}, { status: 3 }])
      expect(readSteeringRepoState({ steering_repo: value })).toBeNull();
  });

  it("fills the fields a stored state lacks from the initial state", () => {
    expect(
      readSteeringRepoState({
        steering_repo: { status: "ready", step: "publish_version" },
        other: 1,
      }),
    ).toEqual({ ...EMPTY_STATE, status: "ready", step: "publish_version" });
  });
});

describe("readSteeringConnection", () => {
  it("returns null when the settings name no connection", () => {
    for (const settings of [
      undefined,
      null,
      "github",
      {},
      { steering_connection: null },
      { steering_connection: "github" },
    ])
      expect(readSteeringConnection(settings)).toBeNull();
  });

  it("reads a GitHub installation and drops unknown keys", () => {
    expect(
      readSteeringConnection({
        steering_connection: { ...GITHUB, extra: true },
      }),
    ).toEqual(GITHUB);
  });

  it("reads a GitLab group", () => {
    expect(readSteeringConnection({ steering_connection: GITLAB })).toEqual(
      GITLAB,
    );
  });

  it("returns null for a malformed connection", () => {
    for (const value of [
      { provider: "github", installation_id: "55", account_login: "acme" },
      { provider: "github", installation_id: 55 },
      { provider: "github", installation_id: 55, account_login: 9 },
      { provider: "gitlab", group_id: "12", group_path: "acme" },
      { provider: "gitlab", group_id: 12 },
      { provider: "bitbucket", group_id: 12, group_path: "acme" },
    ])
      expect(readSteeringConnection({ steering_connection: value })).toBeNull();
  });
});

describe("steeringAppFromEnv", () => {
  it("returns null when the variables are unset", () => {
    expect(steeringAppFromEnv({})).toBeNull();
  });

  it("returns null for an app id that is not a positive integer", () => {
    for (const id of ["abc", "0", "-4", "1.5", ""])
      expect(
        steeringAppFromEnv({ ...ENV, GITHUB_APP_ID: id }),
      ).toBeNull();
  });

  it("returns null when the private key or the slug is missing", () => {
    expect(
      steeringAppFromEnv({ ...ENV, GITHUB_APP_PRIVATE_KEY: undefined }),
    ).toBeNull();
    expect(
      steeringAppFromEnv({ ...ENV, GITHUB_APP_PRIVATE_KEY: "" }),
    ).toBeNull();
    expect(
      steeringAppFromEnv({ ...ENV, GITHUB_APP_SLUG: undefined }),
    ).toBeNull();
  });

  it("reads a complete set", () => {
    expect(steeringAppFromEnv(ENV)).toEqual({
      app: { symbol: OXAGEN_STEERING_APP, id: 123, slug: "oxagen-steering" },
      privateKey: "pem",
    });
  });

  it("reads process.env when no env is given", () => {
    vi.stubEnv("GITHUB_APP_ID", "321");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "pem-from-process");
    vi.stubEnv("GITHUB_APP_SLUG", "steering-from-process");
    expect(steeringAppFromEnv()).toEqual({
      app: {
        symbol: OXAGEN_STEERING_APP,
        id: 321,
        slug: "steering-from-process",
      },
      privateKey: "pem-from-process",
    });
  });
});

describe("steeringInstallationRest", () => {
  it("mints an installation token with the app credentials", async () => {
    const client = await steeringInstallationRest(
      {
        app: { symbol: OXAGEN_STEERING_APP, id: 7, slug: "oxagen-steering" },
        privateKey: "pem-7",
      },
      99,
    );
    expect(mocks.createAppInstallationToken).toHaveBeenCalledWith({
      appId: "7",
      privateKey: "pem-7",
      installationId: 99,
    });
    expect(mocks.createGithubRest).toHaveBeenCalledWith({
      token: "ghs_installation",
    });
    expect(client).toEqual({ client: "github", token: "ghs_installation" });
  });
});

describe("settingsWithSteeringRepo", () => {
  it("merges the state into the settings column it is given", () => {
    for (const column of [
      schema.workspaces.settings,
      schema.organizations.settings,
    ]) {
      const name = render(sql`${column}`).sql;
      const merged = render(settingsWithSteeringRepo(column, STATE));
      expect(merged.sql).toContain(
        `jsonb_typeof(${name}) = 'object' THEN ${name}`,
      );
      expect(merged.sql).toContain("'{}'::jsonb");
      expect(merged.params).toEqual([JSON.stringify({ steering_repo: STATE })]);
    }
    expect(
      render(settingsWithSteeringRepo(schema.workspaces.settings, STATE)).sql,
    ).not.toBe(
      render(settingsWithSteeringRepo(schema.organizations.settings, STATE))
        .sql,
    );
  });
});

describe("saveSteeringRepoState", () => {
  it("writes a workspace state on the system connection filtered by both ids", async () => {
    await saveSteeringRepoState(WORKSPACE, STATE);
    expect(mocks.dbCalls).toEqual(["system"]);
    const write = chain(0);
    expect(write.scope).toBeNull();
    expect(methods(write)).toEqual(["update", "set", "where"]);
    expect(argOf(write, "update")).toBe(schema.workspaces);
    expect(render(settingsOf(write))).toEqual(
      render(settingsWithSteeringRepo(schema.workspaces.settings, STATE)),
    );
    expect(render(argOf(write, "where"))).toEqual(
      render(
        and(
          eq(schema.workspaces.id, WS),
          eq(schema.workspaces.orgId, ORG),
        ),
      ),
    );
  });

  it("writes an organization state on the system connection filtered by the org id", async () => {
    await saveSteeringRepoState(ORGANIZATION, STATE);
    expect(mocks.dbCalls).toEqual(["system"]);
    const write = chain(0);
    expect(write.scope).toBeNull();
    expect(methods(write)).toEqual(["update", "set", "where"]);
    expect(argOf(write, "update")).toBe(schema.organizations);
    expect(render(settingsOf(write))).toEqual(
      render(settingsWithSteeringRepo(schema.organizations.settings, STATE)),
    );
    expect(render(argOf(write, "where"))).toEqual(
      render(eq(schema.organizations.id, ORG)),
    );
  });
});

describe("keepSteeringConnection", () => {
  it("stores the connection when the organization has none", async () => {
    mocks.updateResults.push([{ id: ORG }]);
    await expect(keepSteeringConnection(ORG, GITHUB)).resolves.toBe(true);
    expect(mocks.dbCalls).toEqual(["system"]);
    const write = chain(0);
    expect(write.scope).toBeNull();
    expect(methods(write)).toEqual(["update", "set", "where", "returning"]);
    expect(argOf(write, "update")).toBe(schema.organizations);
    const settings = render(settingsOf(write));
    // The same merge as the steering_repo write. Only the patch differs.
    expect(settings.sql).toBe(
      render(settingsWithSteeringRepo(schema.organizations.settings, STATE))
        .sql,
    );
    expect(savedPatch(write)).toEqual({ steering_connection: GITHUB });
    expect(argOf(write, "returning")).toEqual({ id: schema.organizations.id });
  });

  it("writes only a row that has no connection yet (negative)", async () => {
    await expect(keepSteeringConnection(ORG, GITHUB)).resolves.toBe(false);
    const where = render(argOf(chain(0), "where"));
    expect(where.params).toEqual([ORG, "steering_connection"]);
    const column = render(sql`${schema.organizations.settings}`).sql;
    expect(where.sql).toContain(`(${column} -> $2::text) IS NULL`);
  });
});

describe("moveSteeringInstallation", () => {
  const MOVED = GITHUB as Extract<SteeringConnection, { provider: "github" }>;

  /** The organization row the move reads first. */
  function storedGithub(installationId: number, accountLogin: string) {
    return [
      {
        settings: {
          steering_connection: {
            provider: "github",
            installation_id: installationId,
            account_login: accountLogin,
          },
        },
      },
    ];
  }

  it("moves the setting and the steering source connections to the new installation on the same account", async () => {
    mocks.results.push(storedGithub(44, "ACME"));
    mocks.updateResults.push([{ id: ORG }]);

    await expect(moveSteeringInstallation(ORG, MOVED, ACTOR)).resolves.toBe(
      44,
    );

    // One transaction: read, move the setting, move the source connections.
    expect(mocks.dbCalls).toEqual(["system"]);
    expect(mocks.chains.map((c) => c.op)).toEqual([
      "select",
      "update",
      "update",
    ]);
    expect(render(argOf(chain(0), "where")).params).toEqual([ORG]);

    const setting = chain(1);
    expect(argOf(setting, "update")).toBe(schema.organizations);
    expect(savedPatch(setting)).toEqual({ steering_connection: GITHUB });
    // The write repeats the id it read, so a racing connect is left alone.
    const settingWhere = render(argOf(setting, "where"));
    expect(settingWhere.params).toEqual([ORG, "steering_connection", "44"]);
    const settingsColumn = render(sql`${schema.organizations.settings}`).sql;
    expect(settingWhere.sql).toContain(
      `(${settingsColumn} -> $2::text ->> 'installation_id') = $3`,
    );

    const sources = chain(2);
    expect(argOf(sources, "update")).toBe(schema.sourceConnections);
    const set = argOf(sources, "set") as {
      deliveryConfig: unknown;
      updatedAt: unknown;
      updatedById: unknown;
    };
    const configColumn = render(
      sql`${schema.sourceConnections.deliveryConfig}`,
    ).sql;
    const config = render(set.deliveryConfig);
    expect(config.sql).toBe(
      `jsonb_set(${configColumn}, '{installationId}', $1::jsonb)`,
    );
    expect(config.params).toEqual(["55"]);
    expect(set.updatedAt).toBeInstanceOf(Date);
    expect(set.updatedById).toBe(ACTOR);
    const sourcesWhere = render(argOf(sources, "where"));
    expect(sourcesWhere.params).toEqual([ORG, GITHUB_STEERING_PROVIDER, "44"]);
    expect(sourcesWhere.sql).toContain("is null");
    expect(sourcesWhere.sql).toContain(
      `(${configColumn} ->> 'installationId') = $3`,
    );
  });

  it.each([
    {
      name: "a stored installation on another account",
      stored: () => storedGithub(44, "globex"),
    },
    {
      name: "the same installation id",
      stored: () => storedGithub(55, "acme"),
    },
    {
      name: "a GitLab connection",
      stored: () => [{ settings: { steering_connection: GITLAB } }],
    },
    { name: "no stored connection", stored: () => [{ settings: {} }] },
    { name: "no organization row", stored: () => [] },
  ])("changes nothing for $name (negative)", async ({ stored }) => {
    mocks.results.push(stored());

    await expect(
      moveSteeringInstallation(ORG, MOVED, ACTOR),
    ).resolves.toBeNull();

    expect(mocks.chains.map((c) => c.op)).toEqual(["select"]);
  });

  it("leaves the source connections alone when a racing connect already moved the setting (negative)", async () => {
    mocks.results.push(storedGithub(44, "acme"));
    // The guarded update matches no row.

    await expect(
      moveSteeringInstallation(ORG, MOVED, ACTOR),
    ).resolves.toBeNull();

    expect(mocks.chains.map((c) => c.op)).toEqual(["select", "update"]);
    expect(argOf(chain(1), "update")).toBe(schema.organizations);
  });
});

describe("steeringRepoProvisionDeps", () => {
  it("reads the clock and saves state through saveSteeringRepoState", () => {
    const before = Date.now();
    const now = deps().now();
    expect(now).toBeInstanceOf(Date);
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
    expect(deps().saveState).toBe(saveSteeringRepoState);
  });

  describe("load", () => {
    it("loads the organization repo from the organization row", async () => {
      mocks.results.push([
        orgRow({ steering_repo: { status: "ready" }, steering_connection: GITHUB }),
      ]);
      await expect(deps().load(ORGANIZATION)).resolves.toEqual({
        target: { org_slug: "acme", workspace: null },
        state: { ...EMPTY_STATE, status: "ready" },
        connection: GITHUB,
      });
      expect(mocks.dbCalls).toEqual(["system"]);
      const read = chain(0);
      expect(read.scope).toBeNull();
      expect(methods(read)).toEqual(["select", "from", "where", "limit"]);
      expect(argOf(read, "select")).toEqual({
        slug: schema.organizations.slug,
        settings: schema.organizations.settings,
      });
      expect(argOf(read, "from")).toBe(schema.organizations);
      expect(render(argOf(read, "where"))).toEqual(
        render(eq(schema.organizations.id, ORG)),
      );
      expect(argOf(read, "limit")).toBe(1);
    });

    it("loads a workspace repo with the connection from the organization", async () => {
      mocks.results.push(
        [orgRow({ steering_connection: GITLAB })],
        [
          {
            slug: "platform",
            name: "Platform",
            settings: { steering_repo: { status: "provisioning", attempt: 2 } },
          },
        ],
      );
      await expect(deps().load(WORKSPACE)).resolves.toEqual({
        target: {
          org_slug: "acme",
          workspace: { slug: "platform", name: "Platform" },
        },
        state: { ...EMPTY_STATE, status: "provisioning", attempt: 2 },
        connection: GITLAB,
      });
      expect(mocks.dbCalls).toEqual(["system", "system"]);
      const read = chain(1);
      expect(read.scope).toBeNull();
      expect(methods(read)).toEqual(["select", "from", "where", "limit"]);
      expect(argOf(read, "select")).toEqual({
        slug: schema.workspaces.slug,
        name: schema.workspaces.name,
        settings: schema.workspaces.settings,
      });
      expect(argOf(read, "from")).toBe(schema.workspaces);
      expect(render(argOf(read, "where"))).toEqual(
        render(
          and(
            eq(schema.workspaces.id, WS),
            eq(schema.workspaces.orgId, ORG),
          ),
        ),
      );
      expect(argOf(read, "limit")).toBe(1);
    });

    it("returns no state and no connection when the settings hold none", async () => {
      mocks.results.push(
        [orgRow(null)],
        [{ slug: "platform", name: "Platform", settings: null }],
      );
      await expect(deps().load(WORKSPACE)).resolves.toMatchObject({
        state: null,
        connection: null,
      });
    });

    it("throws when the organization is gone", async () => {
      mocks.results.push([]);
      await expect(deps().load(WORKSPACE)).rejects.toThrow(
        `organization ${ORG} not found`,
      );
      expect(mocks.dbCalls).toEqual(["system"]);
    });

    it("blocks the job when the workspace is gone", async () => {
      mocks.results.push([orgRow(null)], []);
      const loading = deps().load(WORKSPACE);
      await expect(loading).rejects.toBeInstanceOf(
        SteeringProvisionBlockedError,
      );
      await expect(loading).rejects.toMatchObject({
        code: "workspace_not_found",
        message: `Workspace ${WS} no longer exists.`,
      });
    });
  });

  describe("saveConnection", () => {
    it("merges the connection into the organization settings", async () => {
      await deps().saveConnection(WORKSPACE, GITLAB);
      expect(mocks.dbCalls).toEqual(["system"]);
      const write = chain(0);
      expect(write.scope).toBeNull();
      expect(methods(write)).toEqual(["update", "set", "where"]);
      expect(argOf(write, "update")).toBe(schema.organizations);
      const settings = render(settingsOf(write));
      // The merge text matches the steering_repo merge on the same column.
      // Only the patch differs.
      expect(settings.sql).toBe(
        render(settingsWithSteeringRepo(schema.organizations.settings, STATE))
          .sql,
      );
      expect(settings.params).toEqual([
        JSON.stringify({ steering_connection: GITLAB }),
      ]);
      expect(render(argOf(write, "where"))).toEqual(
        render(eq(schema.organizations.id, ORG)),
      );
    });
  });

  describe("github", () => {
    it("returns null when the Oxagen GitHub App is not configured", () => {
      expect(deps({}).github(WORKSPACE)).toBeNull();
      expect(
        deps({ ...ENV, GITHUB_APP_SLUG: undefined }).github(
          ORGANIZATION,
        ),
      ).toBeNull();
    });

    it("reads the app from process.env when no env is given", () => {
      vi.stubEnv("GITHUB_APP_ID", "321");
      vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "pem-from-process");
      vi.stubEnv("GITHUB_APP_SLUG", "steering-from-process");
      const clients = steeringRepoProvisionDeps({ actorUserId: ACTOR }).github(
        WORKSPACE,
      );
      expect(clients?.app).toEqual({
        symbol: OXAGEN_STEERING_APP,
        id: 321,
        slug: "steering-from-process",
      });
    });

    it("builds the installation client from the steering app credentials", async () => {
      const clients = githubClients();
      expect(clients.app).toEqual({
        symbol: OXAGEN_STEERING_APP,
        id: 123,
        slug: "oxagen-steering",
      });
      await expect(clients.installation(42)).resolves.toEqual({
        client: "github",
        token: "ghs_installation",
      });
      expect(mocks.createAppInstallationToken).toHaveBeenCalledWith({
        appId: "123",
        privateKey: "pem",
        installationId: 42,
      });
      expect(mocks.createGithubRest).toHaveBeenCalledWith({
        token: "ghs_installation",
      });
      expect(mocks.dbCalls).toEqual([]);
    });
  });

  describe("stored tokens through github(scope).user()", () => {
    it("returns null when the organization stores no token", async () => {
      mocks.results.push([]);
      await expect(githubClients().user()).resolves.toBeNull();
      expect(mocks.dbCalls).toEqual(["system"]);
      const read = chain(0);
      expect(read.scope).toBeNull();
      expect(methods(read)).toEqual(["select", "from", "where", "orderBy"]);
      expect(argOf(read, "select")).toEqual({
        providerUserId: schema.oauthAccounts.providerUserId,
        accessTokenEnc: schema.oauthAccounts.accessTokenEnc,
        expiresAt: schema.oauthAccounts.expiresAt,
      });
      expect(argOf(read, "from")).toBe(schema.oauthAccounts);
      expect(render(argOf(read, "where"))).toEqual(
        render(
          and(
            eq(schema.oauthAccounts.orgId, ORG),
            eq(schema.oauthAccounts.provider, GITHUB_STEERING_PROVIDER),
          ),
        ),
      );
      expect(render(argOf(read, "orderBy"))).toEqual(
        render(desc(schema.oauthAccounts.updatedAt)),
      );
      expect(mocks.decrypt).not.toHaveBeenCalled();
      expect(mocks.createGithubRest).not.toHaveBeenCalled();
    });

    it("skips a row that holds no encrypted token", async () => {
      mocks.results.push([{ providerUserId: "1", accessTokenEnc: null }]);
      await expect(githubClients().user()).resolves.toBeNull();
      expect(mocks.resolveAdapter).not.toHaveBeenCalled();
      expect(mocks.decrypt).not.toHaveBeenCalled();
      expect(mocks.warn).not.toHaveBeenCalled();
    });

    it("leaves out a token it cannot decrypt and uses the next one", async () => {
      mocks.decrypt.mockRejectedValueOnce(new Error("unknown key"));
      mocks.results.push([
        tokenRow("1", "ghu_broken", "key-gone"),
        tokenRow("2", "ghu_older"),
      ]);
      await expect(githubClients().user()).resolves.toEqual({
        client: "github",
        token: "ghu_older",
      });
      expect(mocks.warn).toHaveBeenCalledTimes(1);
      expect(mocks.warn).toHaveBeenCalledWith(
        { orgId: ORG, provider: GITHUB_STEERING_PROVIDER, err: "Error: unknown key" },
        "steering_repo.provision: a stored token could not be decrypted",
      );
      expect(mocks.createGithubRest).toHaveBeenCalledTimes(1);
    });

    it("returns null when no stored token can be decrypted", async () => {
      mocks.resolveAdapter.mockImplementationOnce(() => {
        throw new Error("no adapter for key");
      });
      mocks.results.push([tokenRow("1", "ghu_broken")]);
      await expect(githubClients().user()).resolves.toBeNull();
      expect(mocks.decrypt).not.toHaveBeenCalled();
      expect(mocks.warn).toHaveBeenCalledWith(
        {
          orgId: ORG,
          provider: GITHUB_STEERING_PROVIDER,
          err: "Error: no adapter for key",
        },
        "steering_repo.provision: a stored token could not be decrypted",
      );
      expect(mocks.createGithubRest).not.toHaveBeenCalled();
    });

    it("skips an expired token and uses the next one that is still valid", async () => {
      mocks.results.push([
        {
          ...tokenRow("1", "ghu_expired"),
          expiresAt: new Date("2020-01-01T00:00:00.000Z"),
        },
        {
          ...tokenRow("2", "ghu_valid"),
          expiresAt: new Date("2999-01-01T00:00:00.000Z"),
        },
      ]);
      await expect(githubClients().user()).resolves.toEqual({
        client: "github",
        token: "ghu_valid",
      });
      expect(Object.keys(argOf(chain(0), "select") as object)).toEqual([
        "providerUserId",
        "accessTokenEnc",
        "expiresAt",
      ]);
    });

    it("returns no client when the only token has expired", async () => {
      mocks.results.push([
        {
          ...tokenRow("1", "ghu_expired"),
          expiresAt: new Date("2020-01-01T00:00:00.000Z"),
        },
      ]);
      await expect(githubClients().user()).resolves.toBeNull();
      expect(mocks.createGithubRest).not.toHaveBeenCalled();
    });

    it("decrypts the newest token and builds the user client from it", async () => {
      mocks.results.push([
        tokenRow("1", "ghu_newest"),
        tokenRow("2", "ghu_older", "key-2"),
      ]);
      await expect(githubClients(ORGANIZATION).user()).resolves.toEqual({
        client: "github",
        token: "ghu_newest",
      });
      expect(mocks.resolveAdapter.mock.calls).toEqual([["key-1"], ["key-2"]]);
      const first = mocks.decrypt.mock.calls[0];
      expect(first?.[0].toString("utf8")).toBe("ghu_newest");
      expect(first?.[1]).toBe("key-1");
      expect(first?.[2]).toEqual({ adapter: { keyId: "key-1" } });
      expect(mocks.createGithubRest).toHaveBeenCalledTimes(1);
      expect(mocks.createGithubRest).toHaveBeenCalledWith({
        token: "ghu_newest",
      });
      expect(mocks.warn).not.toHaveBeenCalled();
    });
  });

  describe("gitlab", () => {
    it("lists one group per stored token and keeps the newest token for a group", async () => {
      mocks.results.push([
        tokenRow("77", "glpat-newest"),
        tokenRow("77", "glpat-older"),
        tokenRow("acme", "glpat-bad-id"),
        tokenRow("88", "glpat-gone"),
      ]);
      mocks.getGroup
        .mockResolvedValueOnce({ id: 77, full_path: "acme" })
        .mockResolvedValueOnce(null);
      await expect(deps({}).gitlab(WORKSPACE).groups()).resolves.toEqual([
        { id: 77, full_path: "acme" },
      ]);
      expect(mocks.createGitlabRest.mock.calls).toEqual([
        [{ token: "glpat-newest" }],
        [{ token: "glpat-gone" }],
      ]);
      expect(mocks.getGroup.mock.calls).toEqual([
        [{ client: "gitlab", token: "glpat-newest" }, 77],
        [{ client: "gitlab", token: "glpat-gone" }, 88],
      ]);
      expect(render(argOf(chain(0), "where"))).toEqual(
        render(
          and(
            eq(schema.oauthAccounts.orgId, ORG),
            eq(schema.oauthAccounts.provider, GITLAB_STEERING_PROVIDER),
          ),
        ),
      );
    });

    it("returns the client for a group with a stored token", async () => {
      mocks.results.push(
        [tokenRow("77", "glpat-newest")],
        [tokenRow("77", "glpat-newest")],
      );
      const clients = deps().gitlab(ORGANIZATION);
      await expect(clients.group(77)).resolves.toEqual({
        client: "gitlab",
        token: "glpat-newest",
      });
      await expect(clients.group(99)).resolves.toBeNull();
      expect(mocks.dbCalls).toEqual(["system", "system"]);
    });

    it("finds no group and no client when the organization stores no token", async () => {
      mocks.results.push([], []);
      const clients = deps().gitlab(WORKSPACE);
      await expect(clients.groups()).resolves.toEqual([]);
      await expect(clients.group(77)).resolves.toBeNull();
      expect(mocks.createGitlabRest).not.toHaveBeenCalled();
      expect(mocks.getGroup).not.toHaveBeenCalled();
    });
  });

  describe("bind", () => {
    const connectionFilter = (connectorId: string) =>
      render(
        and(
          eq(schema.sourceConnections.orgId, ORG),
          eq(schema.sourceConnections.workspaceId, WS),
          eq(schema.sourceConnections.connectorId, connectorId),
          isNull(schema.sourceConnections.deletedAt),
        ),
      );

    it("creates the GitHub steering connection and binding head in the tenant scope", async () => {
      mocks.results.push([], [], [{ id: CONN }], []);
      await expect(
        deps().bind(WORKSPACE, {
          connection: GITHUB,
          repository: REPOSITORY,
          default_branch: "main",
        }),
      ).resolves.toBe("rpb_new");

      expect(mocks.dbCalls).toEqual(["tenant"]);
      expect(mocks.chains).toHaveLength(5);
      for (const c of mocks.chains) {
        expect(c.via).toBe("tenant");
        expect(c.scope).toMatchObject({ orgId: ORG, workspaceId: WS });
      }

      const lock = chain(0);
      expect(methods(lock)).toEqual(["execute"]);
      expect(render(argOf(lock, "execute"))).toEqual(
        render(workspaceRepositoriesLock(WS)),
      );

      const steering = chain(1);
      expect(methods(steering)).toEqual(["select", "from", "where"]);
      expect(argOf(steering, "select")).toEqual({
        provider: schema.repositoryBindingHeads.provider,
        providerRepositoryId: schema.repositoryBindingHeads.providerRepositoryId,
      });
      expect(argOf(steering, "from")).toBe(schema.repositoryBindingHeads);
      expect(render(argOf(steering, "where"))).toEqual(
        render(
          and(
            eq(schema.repositoryBindingHeads.orgId, ORG),
            eq(schema.repositoryBindingHeads.workspaceId, WS),
            eq(schema.repositoryBindingHeads.role, "steering"),
          ),
        ),
      );

      const find = chain(2);
      expect(methods(find)).toEqual(["select", "from", "where", "limit"]);
      expect(argOf(find, "select")).toEqual({
        id: schema.sourceConnections.id,
      });
      expect(argOf(find, "from")).toBe(schema.sourceConnections);
      expect(render(argOf(find, "where"))).toEqual(
        connectionFilter(GITHUB_STEERING_PROVIDER),
      );
      expect(argOf(find, "limit")).toBe(1);

      const insert = chain(3);
      expect(methods(insert)).toEqual(["insert", "values", "returning"]);
      expect(argOf(insert, "insert")).toBe(schema.sourceConnections);
      const values = argOf(insert, "values") as {
        createdAt: Date;
        updatedAt: Date;
      };
      expect(values).toStrictEqual({
        orgId: ORG,
        workspaceId: WS,
        connectorId: GITHUB_STEERING_PROVIDER,
        displayName: "GitHub steering",
        authScheme: "github_app_installation",
        deliveryMethod: "webhook",
        deliveryConfig: { installationId: 55, owner: "acme" },
        status: "connected",
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
        createdById: ACTOR,
        updatedById: ACTOR,
      });
      expect(values.updatedAt).toBe(values.createdAt);
      expect(argOf(insert, "returning")).toEqual({
        id: schema.sourceConnections.id,
      });

      const head = chain(4);
      expect(methods(head)).toEqual([
        "select",
        "from",
        "innerJoin",
        "where",
        "limit",
      ]);
      expect(argOf(head, "select")).toEqual({
        publicId: schema.repositoryBindings.publicId,
      });
      expect(argOf(head, "from")).toBe(schema.repositoryBindingHeads);
      expect(argOf(head, "innerJoin", 0)).toBe(schema.repositoryBindings);
      expect(render(argOf(head, "innerJoin", 1))).toEqual(
        render(
          eq(
            schema.repositoryBindings.id,
            schema.repositoryBindingHeads.currentBindingId,
          ),
        ),
      );
      expect(render(argOf(head, "where"))).toEqual(
        render(
          and(
            eq(schema.repositoryBindingHeads.connectionId, CONN),
            eq(schema.repositoryBindingHeads.providerRepositoryId, "901"),
          ),
        ),
      );
      expect(argOf(head, "limit")).toBe(1);

      expect(mocks.writeRepositoryHead).toHaveBeenCalledTimes(1);
      const written = mocks.writeRepositoryHead.mock.calls[0];
      expect(written?.[0]).toBeDefined();
      expect(written?.[1]).toStrictEqual({
        scope: { orgId: ORG, workspaceId: WS },
        connectionId: CONN,
        repo: {
          id: "901",
          owner: "acme",
          name: "oxagen-platform",
          fullName: "acme/oxagen-platform",
          defaultBranch: "main",
        },
        role: "steering",
        provider: "github",
        userId: ACTOR,
        now: values.createdAt,
      });
      expect((written?.[1] as { now: Date }).now).toBe(values.createdAt);
    });

    it("creates a GitLab steering connection with the group in its config", async () => {
      mocks.results.push([], [], [{ id: CONN }], []);
      await expect(
        deps().bind(WORKSPACE, {
          connection: GITLAB,
          repository: { ...REPOSITORY, owner: "acme/platform" },
          default_branch: "main",
        }),
      ).resolves.toBe("rpb_new");
      expect(render(argOf(chain(2), "where"))).toEqual(
        connectionFilter(GITLAB_STEERING_PROVIDER),
      );
      expect(argOf(chain(3), "values")).toMatchObject({
        connectorId: GITLAB_STEERING_PROVIDER,
        displayName: "GitLab steering",
        authScheme: "group_access_token",
        deliveryMethod: "webhook",
        deliveryConfig: { groupId: 12, groupPath: "acme/platform" },
        status: "connected",
      });
      expect(mocks.writeRepositoryHead.mock.calls[0]?.[1]).toMatchObject({
        role: "steering",
        provider: "gitlab",
        repo: { id: "901", owner: "acme/platform" },
      });
    });

    it("reuses the connection and the binding head a rerun finds", async () => {
      mocks.results.push(
        [{ provider: "gitlab", providerRepositoryId: "901" }],
        [{ id: CONN }],
        [{ publicId: "rpb_existing" }],
      );
      await expect(
        deps().bind(WORKSPACE, {
          connection: GITLAB,
          repository: REPOSITORY,
          default_branch: "main",
        }),
      ).resolves.toBe("rpb_existing");
      expect(mocks.chains.map((c) => c.op)).toEqual([
        "execute",
        "select",
        "select",
        "select",
      ]);
      expect(render(argOf(chain(3), "where"))).toEqual(
        render(
          and(
            eq(schema.repositoryBindingHeads.connectionId, CONN),
            eq(schema.repositoryBindingHeads.providerRepositoryId, "901"),
          ),
        ),
      );
      expect(mocks.writeRepositoryHead).not.toHaveBeenCalled();
    });

    it("writes a head on the connection it finds when no head exists", async () => {
      mocks.results.push([], [{ id: CONN }], []);
      await expect(
        deps().bind(WORKSPACE, {
          connection: GITHUB,
          repository: REPOSITORY,
          default_branch: "trunk",
        }),
      ).resolves.toBe("rpb_new");
      expect(mocks.chains.map((c) => c.op)).toEqual([
        "execute",
        "select",
        "select",
        "select",
      ]);
      expect(mocks.writeRepositoryHead.mock.calls[0]?.[1]).toMatchObject({
        connectionId: CONN,
        repo: { defaultBranch: "trunk" },
      });
    });

    it("throws when the connection insert returns no row", async () => {
      mocks.results.push([], [], []);
      await expect(
        deps().bind(WORKSPACE, {
          connection: GITHUB,
          repository: REPOSITORY,
          default_branch: "main",
        }),
      ).rejects.toThrow("source_connections insert returned no row");
      expect(mocks.writeRepositoryHead).not.toHaveBeenCalled();
    });

    it("stops when the workspace already has a steering head for another repository", async () => {
      mocks.results.push([
        { provider: "github", providerRepositoryId: "777" },
      ]);
      const bound = deps().bind(WORKSPACE, {
        connection: GITHUB,
        repository: REPOSITORY,
        default_branch: "main",
      });
      await expect(bound).rejects.toBeInstanceOf(SteeringProvisionBlockedError);
      await expect(bound).rejects.toMatchObject({
        code: "steering_repo_already_bound",
        message: `Workspace ${WS} already has a steering repository, so this job does not bind acme/oxagen-platform as a second one.`,
      });
      expect(mocks.chains.map((c) => c.op)).toEqual(["execute", "select"]);
      expect(mocks.writeRepositoryHead).not.toHaveBeenCalled();
    });

    it("stops when the steering head has the same id on another host", async () => {
      mocks.results.push([
        { provider: "gitlab", providerRepositoryId: "901" },
      ]);
      await expect(
        deps().bind(WORKSPACE, {
          connection: GITHUB,
          repository: REPOSITORY,
          default_branch: "main",
        }),
      ).rejects.toMatchObject({ code: "steering_repo_already_bound" });
      expect(mocks.writeRepositoryHead).not.toHaveBeenCalled();
    });

    it("binds again when the only steering head is this repository", async () => {
      mocks.results.push(
        [{ provider: "github", providerRepositoryId: "901" }],
        [{ id: CONN }],
        [],
      );
      await expect(
        deps().bind(WORKSPACE, {
          connection: GITHUB,
          repository: REPOSITORY,
          default_branch: "main",
        }),
      ).resolves.toBe("rpb_new");
      expect(mocks.writeRepositoryHead).toHaveBeenCalledTimes(1);
    });
  });

  describe("notifyReauthorize", () => {
    it("asks the workspace's organization managers to authorize the Oxagen GitHub App again", async () => {
      mocks.results.push(
        [orgRow(null)],
        [{ slug: "platform", name: "Platform", settings: null }],
      );
      const d = deps();
      await d.load(WORKSPACE);
      await d.notifyReauthorize(WORKSPACE, "github");
      expect(mocks.notifyOrgManagers).toHaveBeenCalledTimes(1);
      // The notifications package finds the recipients from orgId. No
      // recipient override reaches it.
      expect(mocks.notifyOrgManagers.mock.calls[0]?.[0]).toStrictEqual({
        orgId: ORG,
        workspaceId: WS,
        kind: "security",
        title: GITHUB_TITLE,
        body: GITHUB_BODY,
        deepLink: "/acme",
        emailHtml: `<p><strong>${GITHUB_TITLE}</strong></p><p>${GITHUB_BODY}</p>`,
      });
    });

    it("asks for the GitLab group again with no workspace and an empty slug before a load", async () => {
      await deps().notifyReauthorize(ORGANIZATION, "gitlab");
      expect(mocks.notifyOrgManagers.mock.calls[0]?.[0]).toStrictEqual({
        orgId: ORG,
        kind: "security",
        title: GITLAB_TITLE,
        body: GITLAB_BODY,
        deepLink: "/",
        emailHtml: `<p><strong>${GITLAB_TITLE}</strong></p><p>${GITLAB_BODY}</p>`,
      });
      expect(mocks.dbCalls).toEqual([]);
    });
  });

  describe("steeringHook", () => {
    const HOOK_ENV = {
      ...ENV,
      BETTER_AUTH_SECRET: "a-steering-hook-secret-of-32-chars!",
      NEXT_PUBLIC_API_URL: "https://api.example.test/",
    };

    it("names the workspace in the URL and binds the token to it and the project", () => {
      expect(deps(HOOK_ENV).steeringHook(WORKSPACE, 4242)).toEqual({
        url: `https://api.example.test/webhooks/gitlab/steering/workspace/${WS}`,
        token: steeringHookToken(HOOK_ENV.BETTER_AUTH_SECRET, {
          kind: "workspace",
          scopeId: WS,
          projectId: 4242,
        }),
      });
      expect(mocks.dbCalls).toEqual([]);
    });

    it("names the organization for <org>/oxagen", () => {
      expect(deps(HOOK_ENV).steeringHook(ORGANIZATION, 7)).toEqual({
        url: `https://api.example.test/webhooks/gitlab/steering/organization/${ORG}`,
        token: steeringHookToken(HOOK_ENV.BETTER_AUTH_SECRET, {
          kind: "organization",
          scopeId: ORG,
          projectId: 7,
        }),
      });
    });

    it("refuses without the secret, so the step fails and retries", () => {
      expect(() => deps(ENV).steeringHook(WORKSPACE, 4242)).toThrow(
        /BETTER_AUTH_SECRET/,
      );
    });
  });
});

describe("requestSteeringRepoProvision", () => {
  it("sends the provision event through the event client", async () => {
    await requestSteeringRepoProvision(REQUEST);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith({
      name: "steering-repo/provision.requested",
      data: REQUEST,
    });
    expect(STEERING_REPO_PROVISION_EVENT).toBe(
      "steering-repo/provision.requested",
    );
  });

  it("passes a send failure to the caller", async () => {
    mocks.send.mockRejectedValueOnce(new Error("inngest down"));
    await expect(requestSteeringRepoProvision(REQUEST)).rejects.toThrow(
      "inngest down",
    );
  });
});

describe("startSteeringRepoProvision", () => {
  it("returns the status the setting holds when the event goes out", async () => {
    const send = vi.fn(
      async (_data: SteeringRepoProvisionRequest) => undefined,
    );
    await expect(
      startSteeringRepoProvision(REQUEST, STATE, send),
    ).resolves.toBe("provisioning");
    expect(send).toHaveBeenCalledWith(REQUEST);
    expect(mocks.dbCalls).toEqual([]);
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("sends through the event client by default", async () => {
    await expect(
      startSteeringRepoProvision(REQUEST, { ...STATE, status: "ready" }),
    ).resolves.toBe("ready");
    expect(mocks.send).toHaveBeenCalledWith({
      name: STEERING_REPO_PROVISION_EVENT,
      data: REQUEST,
    });
  });

  it("records a failed workspace state when the send fails", async () => {
    const failure = new Error("inngest down");
    const send = vi.fn((_data: SteeringRepoProvisionRequest) =>
      Promise.reject(failure),
    );
    await expect(
      startSteeringRepoProvision(REQUEST, STATE, send),
    ).resolves.toBe("failed");
    expect(mocks.error).toHaveBeenCalledTimes(1);
    expect(mocks.error).toHaveBeenCalledWith(
      { err: failure, orgId: ORG, workspaceId: WS },
      "steering_repo.provision: could not queue the provision job",
    );
    expect(mocks.dbCalls).toEqual(["system"]);
    const write = chain(0);
    expect(argOf(write, "update")).toBe(schema.workspaces);
    expect(render(argOf(write, "where"))).toEqual(
      render(
        and(eq(schema.workspaces.id, WS), eq(schema.workspaces.orgId, ORG)),
      ),
    );
    const saved = savedPatch(write) as { steering_repo: SteeringRepoState };
    expect(saved).toEqual({
      steering_repo: {
        ...STATE,
        status: "failed",
        error: { code: "enqueue_failed", message: "inngest down" },
        updated_at: expect.any(String),
      },
    });
    expect(Number.isNaN(Date.parse(saved.steering_repo.updated_at))).toBe(
      false,
    );
  });

  it("records a failed organization state when the request names no workspace", async () => {
    const request = { ...REQUEST, workspaceId: null };
    const send = vi.fn((_data: SteeringRepoProvisionRequest) =>
      Promise.reject("queue closed"),
    );
    await expect(
      startSteeringRepoProvision(request, STATE, send),
    ).resolves.toBe("failed");
    expect(mocks.error).toHaveBeenCalledWith(
      { err: "queue closed", orgId: ORG, workspaceId: null },
      "steering_repo.provision: could not queue the provision job",
    );
    const write = chain(0);
    expect(argOf(write, "update")).toBe(schema.organizations);
    expect(render(argOf(write, "where"))).toEqual(
      render(eq(schema.organizations.id, ORG)),
    );
    expect(savedPatch(write)).toEqual({
      steering_repo: {
        ...STATE,
        status: "failed",
        error: { code: "enqueue_failed", message: "queue closed" },
        updated_at: expect.any(String),
      },
    });
  });

  it("logs and still returns failed when the failed state cannot be saved", async () => {
    const sendFailure = new Error("inngest down");
    const saveFailure = new Error("database down");
    mocks.failure.system = saveFailure;
    await expect(
      startSteeringRepoProvision(REQUEST, STATE, () =>
        Promise.reject(sendFailure),
      ),
    ).resolves.toBe("failed");
    expect(mocks.error.mock.calls).toEqual([
      [
        { err: sendFailure, orgId: ORG, workspaceId: WS },
        "steering_repo.provision: could not queue the provision job",
      ],
      [
        { err: saveFailure, orgId: ORG, workspaceId: WS },
        "steering_repo.provision: could not record the failed provision request",
      ],
    ]);
    expect(mocks.dbCalls).toEqual(["system"]);
    expect(mocks.chains).toEqual([]);
  });
});

describe("steeringGroupToken", () => {
  it("returns the newest stored token for the group", async () => {
    mocks.results.push([
      tokenRow("acme", "glpat-bad-id"),
      tokenRow("77", "glpat-newest"),
      tokenRow("77", "glpat-older"),
    ]);
    await expect(steeringGroupToken(ORG, 77)).resolves.toBe("glpat-newest");
    expect(mocks.dbCalls).toEqual(["system"]);
    expect(render(argOf(chain(0), "where"))).toEqual(
      render(
        and(
          eq(schema.oauthAccounts.orgId, ORG),
          eq(schema.oauthAccounts.provider, GITLAB_STEERING_PROVIDER),
        ),
      ),
    );
  });

  it("returns null when no token is stored for the group", async () => {
    mocks.results.push([tokenRow("88", "glpat-other")]);
    await expect(steeringGroupToken(ORG, 77)).resolves.toBeNull();
  });

  it("returns null when the stored token for the group has expired", async () => {
    mocks.results.push([
      { ...tokenRow("77", "glpat-expired"), expiresAt: new Date(0) },
    ]);
    await expect(steeringGroupToken(ORG, 77)).resolves.toBeNull();
  });
});
