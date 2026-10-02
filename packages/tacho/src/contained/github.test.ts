/**
 * A contained run's GitHub route (ADR-152, ADR-254): which sandbox paths
 * reach the daemon's Git custody, what the bridge sends it, and the whole
 * path from the bridge through the real custody proxy to a `token_use`
 * frame on the launched session's chain.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGithubProxy } from "../collector/github-proxy";
import { SessionRegistry } from "../collector/registry";
import type { TachoEvent } from "../envelope";
import { verifyBundle } from "../host/bundle";
import {
  bundleSigner,
  testHostFile,
  TEST_ENROLLMENT,
  unsignedBundle,
} from "../host/test-support";
import {
  TACHO_CREDENTIAL_BASIS_ATTR,
  TACHO_CREDENTIAL_GATEWAY_BROKERED,
} from "../wire";
import { containedBridgeHandler, type ContainedBridgeOptions } from "./bridge";
import {
  containedGitHubSchema,
  custodyGitPath,
  type ContainedGitHubCustody,
} from "./github";

const NOW = Date.parse("2026-09-22T12:00:00Z");
/** The installation token the control plane mints. It must stay in the daemon. */
const SECRET = "ghs_FAKE_DAEMON_ONLY";
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
});

async function listen(
  handler: Parameters<typeof createServer>[1],
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function bridgeOptions(
  overrides: Partial<ContainedBridgeOptions>,
): ContainedBridgeOptions {
  return {
    socketPath: "/unused",
    sessionId: "contained-0123",
    workspace: "/runner/work/app",
    harness: "claude-code",
    modelPort: 4102,
    issueCredential: vi.fn(() => "private-run-token"),
    model: vi.fn(),
    hook: vi.fn(async () => ({})),
    mcp: vi.fn(async () => ({ status: 200, body: {} })),
    refused: vi.fn(),
    githubRefused: vi.fn(),
    ...overrides,
  };
}

describe("the run's GitHub repository", () => {
  it("accepts one named repository and no token", () => {
    expect(
      containedGitHubSchema.safeParse({ repository: "acme/app" }).success,
    ).toBe(true);
    for (const bad of [
      { repository: "acme/app", token: `ghs_${"a".repeat(36)}` },
      { repository: "acme" },
      { repository: "acme/.." },
      { repository: "acme/app", scope: "all" },
    ])
      expect(containedGitHubSchema.safeParse(bad).success).toBe(false);
  });

  it.each([
    [
      "/github/git/acme/app.git/info/refs?service=git-upload-pack",
      "/github/acme/app.git/info/refs?service=git-upload-pack",
    ],
    [
      "/github/git/acme/app/git-receive-pack",
      "/github/acme/app.git/git-receive-pack",
    ],
    [
      "/github/git/ACME/App.git/git-upload-pack",
      "/github/ACME/App.git/git-upload-pack",
    ],
  ])("sends %s to the custody proxy as %s", (path, proxied) => {
    expect(custodyGitPath(path, "acme/app")).toBe(proxied);
  });

  it.each([
    "/github/git/acme/infra.git/info/refs?service=git-upload-pack",
    "/github/git/acme/app.git/objects/info/packs",
    "/github/git/acme/app.git/info/refs?service=git-upload-pack&extra=1",
    // The REST API has no route through custody (ADR-254).
    "/github/api/repos/acme/app/pulls?state=open",
    "/github/api/repos/acme/app",
    "/github/api/user",
    "/github/api/installation/token",
    "/github/api/graphql",
  ])("refuses %s", (path) => {
    expect(custodyGitPath(path, "acme/app")).toBeUndefined();
  });
});

describe("the bridge's GitHub route", () => {
  function custody(
    lease: ContainedGitHubCustody["lease"] = () => ({
      status: 200,
      body: { token: "oxgit_lease", expires_at: "2026-09-22T12:15:00.000Z" },
    }),
  ) {
    const seen: IncomingMessage[] = [];
    const github = {
      repository: "acme/app",
      lease: vi.fn(lease),
      handle: vi.fn(
        async (request: IncomingMessage, response: ServerResponse) => {
          seen.push(request);
          response.writeHead(200, { "content-type": "text/plain" });
          response.end("proxied");
        },
      ),
      release: vi.fn(),
    } satisfies ContainedGitHubCustody;
    return { github, seen };
  }

  it("forwards to the custody proxy with a lease for its own session and drops the sandbox's credential", async () => {
    const { github, seen } = custody();
    const options = bridgeOptions({ github });
    const base = await listen(containedBridgeHandler(options));
    const response = await fetch(
      `${base}/github/git/acme/app/git-receive-pack`,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-git-receive-pack-request",
          "git-protocol": "version=2",
          "user-agent": "git/2.47.0",
          authorization: "Basic c3RvbGVuOnN0b2xlbg==",
          cookie: "session=sandbox",
        },
        body: "pack-payload",
      },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("proxied");
    expect(github.lease).toHaveBeenCalledOnce();
    expect(seen[0]?.url).toBe("/github/acme/app.git/git-receive-pack");
    expect(seen[0]?.headers).toEqual({
      authorization: `Basic ${Buffer.from("oxagen:oxgit_lease").toString("base64")}`,
      "content-type": "application/x-git-receive-pack-request",
      "git-protocol": "version=2",
      "user-agent": "git/2.47.0",
    });
    await vi.waitFor(() =>
      expect(github.release).toHaveBeenCalledWith("oxgit_lease"),
    );
    expect(options.refused).not.toHaveBeenCalled();
    expect(options.githubRefused).not.toHaveBeenCalled();
  });

  it("refuses when custody cannot issue a lease, and forwards nothing", async () => {
    const { github } = custody(() => ({
      status: 403,
      body: { error: "The session or enrollment is not active" },
    }));
    const options = bridgeOptions({ github });
    const base = await listen(containedBridgeHandler(options));
    const path = "/github/git/acme/app.git/info/refs?service=git-receive-pack";
    const response = await fetch(`${base}${path}`);
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(await response.text()).toBe(
      "Oxagen issued no GitHub credential for this run. The session or enrollment is not active",
    );
    expect(github.handle).not.toHaveBeenCalled();
    expect(github.release).not.toHaveBeenCalled();
    expect(options.githubRefused).toHaveBeenCalledWith(path);
  });

  it("releases the lease when the proxy throws", async () => {
    const { github } = custody();
    github.handle.mockRejectedValueOnce(new Error("proxy failed"));
    const base = await listen(
      containedBridgeHandler(bridgeOptions({ github })),
    );
    const response = await fetch(
      `${base}/github/git/acme/app.git/info/refs?service=git-upload-pack`,
    );
    expect(response.status).toBe(502);
    expect(github.release).toHaveBeenCalledWith("oxgit_lease");
  });

  it.each([
    "/github/api/repos/acme/app/pulls",
    "/github/git/acme/infra.git/info/refs?service=git-upload-pack",
  ])("refuses %s as outside the gateway", async (path) => {
    const { github } = custody();
    const options = bridgeOptions({ github });
    const base = await listen(containedBridgeHandler(options));
    expect((await fetch(`${base}${path}`)).status).toBe(403);
    expect(github.lease).not.toHaveBeenCalled();
    expect(github.handle).not.toHaveBeenCalled();
    expect(options.refused).toHaveBeenCalledWith(path);
  });

  it("refuses every GitHub route when the run named no repository", async () => {
    const options = bridgeOptions({});
    const base = await listen(containedBridgeHandler(options));
    const path = "/github/git/acme/app.git/info/refs?service=git-upload-pack";
    expect((await fetch(`${base}${path}`)).status).toBe(403);
    expect(options.refused).toHaveBeenCalledWith(path);
  });
});

/**
 * The bridge wired to the real custody proxy, on a host that never ran
 * `tacho github configure`: no broker flag and no custody receipt, which is
 * how a CI runner starts a contained run.
 */
async function custodyRig() {
  const signer = bundleSigner();
  const host = testHostFile(
    signer,
    signer.sign(
      unsignedBundle({
        permissions: { allow: ["Bash(git *)"], deny: [], ask: [] },
      }),
    ),
    { bundle_fetched_at: new Date(NOW).toISOString() },
  );
  const registry = new SessionRegistry({
    scope: TEST_ENROLLMENT,
    now: () => NOW,
    context: {
      agent: {
        agent_key: host.agent_key,
        fleet_id: host.workspace_id,
        runtime: "claude-code",
        harness: "claude-code",
        wrapper_version: "2.1.1",
        host_enrollment_id: TEST_ENROLLMENT,
      },
    },
  });
  const session = registry.ensure("contained-0123", {
    cwd: "/runner/work/app",
    harness: "claude-code",
  }).record;
  const recorded: TachoEvent[] = [];
  const log = vi.fn();
  const controlFetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          token: SECRET,
          expires_at: new Date(NOW + 3600_000).toISOString(),
        }),
      ),
  );
  const upstream = vi.fn(
    async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.body) await new Response(init.body).text();
      return new Response(init?.method === "DELETE" ? null : "0000", {
        status: init?.method === "DELETE" ? 204 : 200,
        headers: { "content-type": "application/x-git-receive-pack-result" },
      });
    },
  );
  const proxy = createGithubProxy({
    policy: () => ({
      bundle: host.bundle,
      verified: verifyBundle(host.bundle, host.bundle_public_key_pem).ok,
      hostStatus: host.host_status,
      denyGeneration: host.deny_generation,
      controlReachable: true,
      mandateConfirmedAt: NOW,
    }),
    refreshBundle: vi.fn(async () => true),
    host: () => host,
    registry,
    now: () => NOW,
    record: (events) => recorded.push(...events),
    log,
    controlFetch,
    fetch: upstream,
  });
  const release = vi.fn(proxy.release);
  const options = bridgeOptions({
    github: {
      repository: "acme/app",
      lease: () =>
        proxy.issueForSession({
          session: session.recorder.sessionUuid,
          repository: "acme/app",
        }),
      handle: proxy.handle,
      release,
    },
  });
  const base = await listen(containedBridgeHandler(options));
  return {
    base,
    host,
    session,
    recorded,
    log,
    controlFetch,
    upstream,
    release,
    options,
  };
}

describe("a contained run's push through custody", () => {
  it("pushes with a token the daemon holds, and the chain carries a brokered token_use", async () => {
    const t = await custodyRig();
    const response = await fetch(
      `${t.base}/github/git/acme/app.git/git-receive-pack`,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-git-receive-pack-request",
          authorization: "Basic c3RvbGVuOnN0b2xlbg==",
        },
        body: "pack-payload",
      },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("0000");
    await vi.waitFor(() => expect(t.release).toHaveBeenCalledOnce());
    expect(t.release.mock.calls[0]?.[0]).toMatch(/^oxgit_/);

    // The server mints for the repository the run named.
    expect(t.controlFetch).toHaveBeenCalledOnce();
    const mint = JSON.parse(
      String(
        (t.controlFetch.mock.calls[0] as unknown as [string, RequestInit])[1]
          .body,
      ),
    ) as Record<string, unknown>;
    expect(mint).toMatchObject({ owner: "acme", name: "app" });

    // GitHub sees the minted token, then its revocation.
    expect(t.upstream.mock.calls.map((call) => String(call[0]))).toEqual([
      "https://github.com/acme/app.git/git-receive-pack",
      "https://api.github.com/installation/token",
    ]);
    expect(
      new Headers(t.upstream.mock.calls[0]?.[1]?.headers).get("authorization"),
    ).toBe(
      `Basic ${Buffer.from(`x-access-token:${SECRET}`).toString("base64")}`,
    );

    // The launched session's chain carries the brokered use.
    const use = t.recorded.find((event) => event.kind === "token_use");
    expect(use).toBeDefined();
    expect(use?.session_uuid).toBe(t.session.recorder.sessionUuid);
    expect(use?.attrs[TACHO_CREDENTIAL_BASIS_ATTR]).toBe(
      TACHO_CREDENTIAL_GATEWAY_BROKERED,
    );
    expect(use?.attrs["oxagen.github.repository"]).toBe("acme/app");

    // No GitHub token reaches the sandbox, the record, or the log.
    const everything =
      JSON.stringify(t.recorded) + JSON.stringify(t.log.mock.calls);
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain(String(t.release.mock.calls[0]?.[0]));
  });

  type Rig = Awaited<ReturnType<typeof custodyRig>>;
  it.each([
    [
      "the session has ended",
      (t: Rig) => {
        t.session.sealed = true;
      },
    ],
    [
      "the session is paused",
      (t: Rig) => {
        t.session.control.paused = "operator pause";
      },
    ],
    [
      "the enrollment is suspended",
      (t: Rig) => {
        t.host.host_status = "suspended";
      },
    ],
  ])(
    "refuses before any mint when %s",
    async (_label, change) => {
      const t = await custodyRig();
      change(t);
      const path = "/github/git/acme/app.git/info/refs?service=git-receive-pack";
      const response = await fetch(`${t.base}${path}`);
      expect(response.status).toBe(403);
      expect(await response.text()).toMatch(
        /^Oxagen issued no GitHub credential for this run\. /,
      );
      expect(t.controlFetch).not.toHaveBeenCalled();
      expect(t.upstream).not.toHaveBeenCalled();
      expect(t.options.githubRefused).toHaveBeenCalledWith(path);
    },
  );
});
