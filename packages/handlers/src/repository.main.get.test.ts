import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { repositoryMainGet } from "@oxagen/oxagen/contracts/repository.main.get";
import { makeCTX } from "./test-utils/fixtures";

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

import {
  createMainRepositoryGetHandler,
  envGithubUrls,
} from "./repository.main.get";

const BOUND_AT = new Date("2026-09-15T12:06:00.000Z");

const BINDING_ROW = {
  bindingId: "rpb_0123456789abcdef",
  provider: "github",
  owner: "acme",
  name: "widgets",
  fullName: "acme/widgets",
  defaultRef: "main",
  boundAt: BOUND_AT,
  // The connection the head names, left-joined: its status and deleted_at are
  // what `connectionLive` is judged from, and both are null when the purge has
  // already taken the row away.
  connectionStatus: "connected" as string | null,
  connectionDeletedAt: null as Date | null,
};

const URLS = {
  // Three doors, and they are three. Connect is the IDENTITY leg; install is
  // `installations/new` SIGNED with the same state; manage is that page bare.
  // See `envGithubUrls` and the env-set suite at the bottom of this file.
  connectUrl:
    "https://github.com/login/oauth/authorize?client_id=Iv1.x&state=abc.def",
  installUrl: "https://github.com/apps/oxagen/installations/new?state=abc.def",
  manageUrl: "https://github.com/apps/oxagen/installations/new",
};

/**
 * The handler makes two reads through `withTenantDb`, in this order: the
 * binding head joined to its binding and LEFT-joined to the connection that
 * head names, then the workspace's GitHub connection. Each gets its own chain
 * shape; the left join is the one that lets a retired connection be reported
 * rather than drop the repository off the answer.
 */
function wire(opts: {
  binding?: Partial<typeof BINDING_ROW> | null;
  connections?: unknown[];
}): void {
  const bindingRows = opts.binding ? [{ ...BINDING_ROW, ...opts.binding }] : [];
  mocks.withTenantDb
    .mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: () => ({
          from: () => ({
            innerJoin: () => ({
              leftJoin: () => ({
                where: () => ({ limit: async () => bindingRows }),
              }),
            }),
          }),
        }),
      }),
    )
    .mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        // The resolver orders newest-first (`.orderBy(desc(created_at))`) so
        // that it and the install callback's attach agree on which connection
        // is authoritative; the chain mocked here carries that step.
        select: () => ({
          from: () => ({
            where: () => ({ orderBy: async () => opts.connections ?? [] }),
          }),
        }),
      }),
    );
}

function handler(urls: typeof URLS | null = URLS) {
  return createMainRepositoryGetHandler({ githubUrls: () => urls });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertOrgRole.mockResolvedValue("Owner");
  mocks.resolveActingUserId.mockImplementation(
    async (c: { userId: string | null }) => c.userId,
  );
});

describe("get_main_repository", () => {
  it("refuses a caller who is not an org Owner or Admin, before reading anything", async () => {
    mocks.assertOrgRole.mockRejectedValueOnce(new Error("org_role_required"));
    await expect(handler()({}, makeCTX())).rejects.toThrow("org_role_required");
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it("checks the role against the acting user the context resolves (INV-29)", async () => {
    mocks.resolveActingUserId.mockResolvedValueOnce("u_acting");
    wire({ binding: null });
    await handler()({}, makeCTX({ userId: "u_session" }));
    expect(mocks.assertOrgRole).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u_acting" }),
      { org: ["Owner", "Admin"] },
    );
  });

  it("answers the bound repository, connected, with both signed doors", async () => {
    wire({
      binding: BINDING_ROW,
      connections: [
        {
          id: "conn-uuid",
          publicId: "con_ABC",
          status: "connected",
          deliveryConfig: { installationId: "555" },
        },
      ],
    });

    const out = await handler()({}, makeCTX());

    expect(out).toEqual({
      repository: {
        bindingId: "rpb_0123456789abcdef",
        provider: "github",
        owner: "acme",
        name: "widgets",
        fullName: "acme/widgets",
        defaultRef: "main",
        // Derived from the full name: the bind persists no html url.
        htmlUrl: "https://github.com/acme/widgets",
        boundAt: "2026-09-15T12:06:00.000Z",
        connectionLive: true,
      },
      github: { connected: true, ...URLS },
    });
    expect(() => repositoryMainGet.output.parse(out)).not.toThrow();
  });

  it("answers a GitLab main project with its host and a gitlab.com link (#3762)", async () => {
    wire({
      binding: {
        ...BINDING_ROW,
        provider: "gitlab",
        owner: "acme/platform",
        name: "rules",
        fullName: "acme/platform/rules",
      },
      connections: [],
    });

    const out = await handler()({}, makeCTX());

    expect(out.repository).toMatchObject({
      provider: "gitlab",
      owner: "acme/platform",
      fullName: "acme/platform/rules",
      htmlUrl: "https://gitlab.com/acme/platform/rules",
    });
    expect(() => repositoryMainGet.output.parse(out)).not.toThrow();
  });

  it("never ships the installation id, by any name", async () => {
    wire({
      binding: BINDING_ROW,
      connections: [
        {
          id: "conn-uuid",
          publicId: "con_ABC",
          status: "connected",
          deliveryConfig: { installationId: "555" },
        },
      ],
    });
    const out = await handler()({}, makeCTX());
    expect(JSON.stringify(out)).not.toContain("555");
    expect(JSON.stringify(out)).not.toContain("conn-uuid");
  });

  it("answers a provisional workspace: nothing bound, nothing connected, but a door", async () => {
    wire({ binding: null, connections: [] });

    const out = await handler()({}, makeCTX());

    expect(out).toEqual({
      repository: null,
      github: { connected: false, ...URLS },
    });
    expect(() => repositoryMainGet.output.parse(out)).not.toThrow();
  });

  // §10.1 / ADR-099: a workspace may hold `linked` heads beside its one
  // `main`. This read answers THE main repository, so the head it selects is
  // pinned by role — without that predicate a linked head could be reported
  // as the repository steering resolves through. repository.pg.test.ts proves
  // the same against Postgres with both heads present; this pins the SQL.
  it("selects only the head whose role is main", async () => {
    let captured: SQL | undefined;
    mocks.withTenantDb
      .mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          select: () => ({
            from: () => ({
              innerJoin: () => ({
                leftJoin: () => ({
                  where: (cond: SQL) => {
                    captured = cond;
                    return { limit: async () => [] };
                  },
                }),
              }),
            }),
          }),
        }),
      )
      .mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          select: () => ({
            from: () => ({ where: () => ({ orderBy: async () => [] }) }),
          }),
        }),
      );
    await handler()({}, makeCTX());
    if (!captured) throw new Error("the head read issued no WHERE");
    const query = new PgDialect().sqlToQuery(captured);
    expect(query.sql).toMatch(/"role" = \$\d+/);
    expect(query.params).toContain("main");
  });

  it("reports not-connected when the only GitHub connection carries no installation", async () => {
    wire({
      binding: null,
      connections: [
        {
          id: "conn-uuid",
          publicId: "con_ABC",
          status: "pending_setup",
          deliveryConfig: { owner: "acme" },
        },
      ],
    });
    const out = await handler()({}, makeCTX());
    // Exactly the state bind_main_repository refuses as github_not_connected.
    expect(out.github.connected).toBe(false);
  });

  it("takes the first connection that carries an installation, past ones that do not", async () => {
    wire({
      binding: null,
      connections: [
        { id: "a", publicId: "con_A", status: "error", deliveryConfig: null },
        {
          id: "b",
          publicId: "con_B",
          status: "connected",
          deliveryConfig: { installationId: 777 },
        },
      ],
    });
    const out = await handler()({}, makeCTX());
    expect(out.github.connected).toBe(true);
  });

  it("answers null URLs, not an error, when the deployment has no GitHub App", async () => {
    wire({ binding: BINDING_ROW, connections: [] });

    const out = await handler(null)({}, makeCTX());

    // The dialog must still render: the repository already bound is worth
    // showing even where nobody can install anything.
    expect(out.github).toEqual({
      connected: false,
      connectUrl: null,
      installUrl: null,
      manageUrl: null,
    });
    expect(out.repository?.fullName).toBe("acme/widgets");
    expect(() => repositoryMainGet.output.parse(out)).not.toThrow();
  });

  it("builds the URLs for the calling org and workspace", async () => {
    wire({ binding: null, connections: [] });
    const githubUrls = vi.fn(() => URLS);
    await createMainRepositoryGetHandler({ githubUrls })(
      {},
      makeCTX({ orgId: "org-9", workspaceId: "ws-9" }),
    );
    expect(githubUrls).toHaveBeenCalledWith({
      orgId: "org-9",
      workspaceId: "ws-9",
    });
  });

  /**
   * The state a delete-then-reconnect leaves, and the only thing on any surface
   * that says so (#3233).
   *
   * `delete_connection` sets `status = 'deleting'` and leaves `deleted_at` for
   * a later purge, so the install callback's attach — which reads live rows
   * only — inserts a NEW connection while the binding head still names the
   * retired one. `readGitHubConnection` filters exactly these statuses, so
   * steering resolves nothing from that moment. This read used to join only the
   * head to its binding, so it reported the repository as usable and the
   * workspace looked fine with its steering silently off.
   */
  describe("connectionLive", () => {
    const LIVE_CONNECTIONS = [
      {
        id: "conn-uuid",
        publicId: "con_ABC",
        status: "connected",
        deliveryConfig: { installationId: "555" },
      },
    ];

    it("is false when the head still names a connection marked deleting", async () => {
      wire({
        binding: { connectionStatus: "deleting" },
        connections: LIVE_CONNECTIONS,
      });
      const out = await handler()({}, makeCTX());
      expect(out.repository?.connectionLive).toBe(false);
      // Still reported: the person has to be told WHICH repository is bound,
      // and re-binding that same one is the repair.
      expect(out.repository?.fullName).toBe("acme/widgets");
      // And a live replacement connection is attached, so the repair can run.
      expect(out.github.connected).toBe(true);
      expect(() => repositoryMainGet.output.parse(out)).not.toThrow();
    });

    it("is false when the head names a connection marked deleted", async () => {
      wire({ binding: { connectionStatus: "deleted" }, connections: [] });
      const out = await handler()({}, makeCTX());
      expect(out.repository?.connectionLive).toBe(false);
      expect(out.repository?.fullName).toBe("acme/widgets");
    });

    it("is false when the connection is soft-deleted though its status reads live", async () => {
      wire({
        binding: {
          connectionStatus: "connected",
          connectionDeletedAt: new Date("2026-09-17T00:00:00.000Z"),
        },
        connections: [],
      });
      const out = await handler()({}, makeCTX());
      expect(out.repository?.connectionLive).toBe(false);
      expect(out.repository?.fullName).toBe("acme/widgets");
    });

    it("is false when the purge has taken the connection row away entirely", async () => {
      // The left join found nothing, which is as retired as a row can get.
      wire({
        binding: { connectionStatus: null, connectionDeletedAt: null },
        connections: [],
      });
      const out = await handler()({}, makeCTX());
      expect(out.repository?.connectionLive).toBe(false);
      expect(out.repository?.fullName).toBe("acme/widgets");
    });

    it("is true for a connection that is neither retired nor soft-deleted", async () => {
      // `pending_setup`, not just `connected`: the attach writes that status
      // and the steering seam admits it, so the repository is usable through it.
      wire({
        binding: { connectionStatus: "pending_setup" },
        connections: LIVE_CONNECTIONS,
      });
      const out = await handler()({}, makeCTX());
      expect(out.repository?.connectionLive).toBe(true);
      expect(() => repositoryMainGet.output.parse(out)).not.toThrow();
    });
  });

  it("makes no GitHub API call — a settings read renders while GitHub is down", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    wire({ binding: BINDING_ROW, connections: [] });
    await handler()({}, makeCTX());
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

/**
 * The env-derived doors — the production `githubUrls`.
 *
 * Two behaviours are pinned here. WHICH GitHub URL the Connect action opens:
 * `installations/new` completes through GitHub's stateless setup/update
 * redirect when the App is already installed on the target account, returning
 * neither our signed state nor a fresh `code`, so the callback takes its
 * no-state branch and attaches nothing — reconnecting, and connecting a second
 * workspace to an account that already has the App, were both impossible from
 * the dialog. And WHEN a door is offered at all: only where the complete set
 * needed to finish the round trip is configured, since a Connect the callback
 * answers with 503 strands the operator on GitHub with nothing to explain why.
 */
describe("envGithubUrls", () => {
  const ENV = {
    GITHUB_APP_CLIENT_ID: "Iv1.client",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_SLUG: "oxagen-test",
    GITHUB_APP_INSTALL_STATE_SECRET: "state-secret-32-bytes-long!!!!!!",
    // Not needed to start the flow, and needed for everything the flow is for:
    // `getInstallationToken` signs its JWT with these, so a deployment without
    // them can complete a connect and then throw on every list and every bind.
    GITHUB_APP_ID: "123456",
    GITHUB_APP_PRIVATE_KEY:
      "-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----",
  } as const;

  const SCOPE = { orgId: "org-1", workspaceId: "ws-1" };

  function withEnv(vars: Record<string, string | undefined>) {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) vi.stubEnv(k, "");
      else vi.stubEnv(k, v);
    }
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("offers the IDENTITY URL as the Connect action, not installations/new", () => {
    withEnv(ENV);
    const urls = envGithubUrls.githubUrls(SCOPE);
    expect(urls).not.toBeNull();
    const connectUrl = urls!.connectUrl;
    expect(connectUrl).toContain("https://github.com/login/oauth/authorize");
    // The URL that dead-ends when the App is already installed.
    expect(connectUrl).not.toContain("installations/new");
    const parsed = new URL(connectUrl);
    expect(parsed.searchParams.get("client_id")).toBe(ENV.GITHUB_APP_CLIENT_ID);
    // Still signed, and still naming this org+workspace: the callback attaches
    // the installation to the workspace that asked and to no other.
    const state = parsed.searchParams.get("state") ?? "";
    const payload = JSON.parse(
      Buffer.from(state.slice(0, state.lastIndexOf(".")), "base64url").toString(
        "utf8",
      ),
    ) as { orgId: string; workspaceId: string; returnTo: string };
    expect(payload).toMatchObject({
      orgId: "org-1",
      workspaceId: "ws-1",
      returnTo: "settings",
    });
  });

  it("keeps installations/new as the manage door", () => {
    withEnv(ENV);
    expect(envGithubUrls.githubUrls(SCOPE)?.manageUrl).toBe(
      `https://github.com/apps/${ENV.GITHUB_APP_SLUG}/installations/new`,
    );
  });

  /**
   * The first-run door, and the defect it fixes (#3254).
   *
   * The install action was wired to the MANAGE url, which carries no state at
   * all. So an account with the App installed nowhere clicked Install, GitHub
   * installed it and redirected to the callback with nothing to attribute —
   * the callback took its no-state branch, attached nothing and dropped them on
   * the app root at `/?github_installed=1`, workspace still unconnected. That
   * is the primary first-run path for every new customer.
   */
  it("signs the install door with the same state the connect door carries", () => {
    withEnv(ENV);
    const urls = envGithubUrls.githubUrls(SCOPE);
    const parsed = new URL(urls!.installUrl);
    expect(parsed.origin + parsed.pathname).toBe(
      `https://github.com/apps/${ENV.GITHUB_APP_SLUG}/installations/new`,
    );
    const state = parsed.searchParams.get("state") ?? "";
    expect(state).not.toBe("");
    const payload = JSON.parse(
      Buffer.from(state.slice(0, state.lastIndexOf(".")), "base64url").toString(
        "utf8",
      ),
    ) as { orgId: string; workspaceId: string; returnTo: string };
    // Naming this workspace is the whole point: the callback attaches to the
    // workspace that asked and lands the person back on its dialog.
    expect(payload).toMatchObject({
      orgId: "org-1",
      workspaceId: "ws-1",
      returnTo: "settings",
    });
  });

  it("leaves the manage door unsigned, and keeps the three doors distinct", () => {
    withEnv(ENV);
    const urls = envGithubUrls.githubUrls(SCOPE);
    // Manage starts no flow and carries nothing back, so it has no state — and
    // that is exactly why it must never be offered as the install door.
    expect(new URL(urls!.manageUrl).searchParams.get("state")).toBeNull();
    expect(urls!.manageUrl).not.toBe(urls!.installUrl);
    expect(urls!.connectUrl).not.toBe(urls!.installUrl);
    expect(urls!.connectUrl).not.toBe(urls!.manageUrl);
  });

  // One case per var: each is independently optional in the env registry, so a
  // deployment really can hold three of the four.
  for (const missing of [
    "GITHUB_APP_CLIENT_ID",
    "GITHUB_APP_CLIENT_SECRET",
    "GITHUB_APP_SLUG",
    "GITHUB_APP_INSTALL_STATE_SECRET",
    // The signing half. Without either, the connect completes and then every
    // `list_installation_repositories` and `bind_main_repository` throws
    // "GitHub App is not configured" — the operator stranded PAST the point of
    // no return, which is worse than being refused at the door.
    "GITHUB_APP_ID",
    "GITHUB_APP_PRIVATE_KEY",
  ] as const) {
    it(`offers no door when ${missing} is unset`, () => {
      withEnv({ ...ENV, [missing]: undefined });
      // Null is the contract's honest "unconfigured", which the dialog renders
      // as "not configured for this deployment" — better than a Connect the
      // callback refuses with 503 after the operator has left for GitHub.
      expect(envGithubUrls.githubUrls(SCOPE)).toBeNull();
    });
  }
});
