import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  // The Connect action is the IDENTITY leg, not installations/new — see
  // `envGithubUrls` and the env-set suite at the bottom of this file.
  installUrl:
    "https://github.com/login/oauth/authorize?client_id=Iv1.x&state=abc.def",
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
    const installUrl = urls!.installUrl;
    expect(installUrl).toContain("https://github.com/login/oauth/authorize");
    // The URL that dead-ends when the App is already installed.
    expect(installUrl).not.toContain("installations/new");
    const parsed = new URL(installUrl);
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

  // One case per var: each is independently optional in the env registry, so a
  // deployment really can hold three of the four.
  for (const missing of [
    "GITHUB_APP_CLIENT_ID",
    "GITHUB_APP_CLIENT_SECRET",
    "GITHUB_APP_SLUG",
    "GITHUB_APP_INSTALL_STATE_SECRET",
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
