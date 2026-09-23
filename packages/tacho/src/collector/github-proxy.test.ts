import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TachoEvent } from "../envelope";
import {
  bundleSigner,
  testHostFile,
  unsignedBundle,
  TEST_ENROLLMENT,
} from "../host/test-support";
import { createRequestHandler, type CollectorApi } from "./server";
import { SessionRegistry } from "./registry";
import { createGithubProxy } from "./github-proxy";

const NOW = Date.parse("2026-09-22T12:00:00Z");
const SECRET = "ghs_FAKE_DAEMON_ONLY";
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function setup() {
  const signer = bundleSigner();
  const host = testHostFile(
    signer,
    signer.sign(
      unsignedBundle({
        permissions: { allow: ["Bash(git *)"], deny: [], ask: [] },
      }),
    ),
    {
      github_broker_enabled: true,
      bundle_fetched_at: new Date(NOW).toISOString(),
    },
  );
  let now = NOW;
  const registry = new SessionRegistry({
    scope: TEST_ENROLLMENT,
    now: () => now,
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
  const session = registry.ensure("run-1", {
    cwd: "/repo",
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
  const forwarded: Array<{ url: string; auth: string | null; body: string }> =
    [];
  const upstream = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      forwarded.push({
        url: String(url),
        auth: new Headers(init?.headers).get("authorization"),
        body: init?.body ? await new Response(init.body).text() : "",
      });
      return new Response(init?.method === "DELETE" ? null : "0000", {
        status: init?.method === "DELETE" ? 204 : 200,
        headers: { "content-type": "application/x-git-receive-pack-result" },
      });
    },
  );
  const proxy = createGithubProxy({
    host: () => host,
    registry,
    now: () => now,
    record: (events) => recorded.push(...events),
    log,
    controlFetch,
    fetch: upstream,
  });
  const api: CollectorApi = {
    localToken: host.local_token,
    enrollmentId: TEST_ENROLLMENT,
    githubProxy: proxy.handle,
    githubLease: proxy.issue,
    handleHook: async () => ({}),
    handleOtlp: async () => {},
    health: () => ({}),
    status: () => ({}),
    sessions: () => [],
    exportSession: () => undefined,
  };
  const server = createServer((req, res) =>
    createRequestHandler(api, log, {
      guardPort: (server.address() as AddressInfo).port,
    })(req, res),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const lease = proxy.issue({
    repository: "Acme/Repo",
    cwd: "/repo",
    harness: "claude-code",
  });
  const token = (lease.body as { token: string }).token;
  expect(lease.status).toBe(200);
  const request = (
    path = "/github/acme/repo.git/info/refs?service=git-receive-pack",
    init: RequestInit = {},
  ) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: `Basic ${Buffer.from(`oxagen:${token}`).toString("base64")}`,
        ...init.headers,
      },
    });
  return {
    base,
    host,
    signer,
    registry,
    session,
    recorded,
    log,
    controlFetch,
    forwarded,
    upstream,
    proxy,
    token,
    request,
    advance: () => {
      now += 16 * 60_000;
    },
  };
}

describe("GitHub daemon custody", () => {
  it("streams git bytes with a repository token held only by the daemon, then revokes it", async () => {
    const t = await setup();
    const response = await t.request("/github/acme/repo.git/git-receive-pack", {
      method: "POST",
      headers: { "content-type": "application/x-git-receive-pack-request" },
      body: "pack-payload",
    });
    expect(await response.text()).toBe("0000");
    await vi.waitFor(() => expect(t.forwarded).toHaveLength(2));
    expect(t.controlFetch).toHaveBeenCalledWith(
      "https://api.example.test/v1/tacho/github-token",
      expect.objectContaining({
        body: expect.stringContaining('"owner":"acme"'),
      }),
    );
    expect(t.forwarded).toEqual([
      {
        url: "https://github.com/acme/repo.git/git-receive-pack",
        auth: `Basic ${Buffer.from(`x-access-token:${SECRET}`).toString("base64")}`,
        body: "pack-payload",
      },
      {
        url: "https://api.github.com/installation/token",
        auth: `Bearer ${SECRET}`,
        body: "",
      },
    ]);
    expect(t.token).toMatch(/^oxgit_/);
    expect(JSON.stringify(t.recorded)).toContain('"gateway_brokered"');
    expect(JSON.stringify(t.recorded)).toContain('"token_use"');
    expect(
      JSON.stringify(t.recorded) + JSON.stringify(t.log.mock.calls),
    ).not.toContain(SECRET);
    expect(JSON.stringify(t.recorded)).not.toContain(t.token);
  });

  it.each([
    "/github/acme/other.git/info/refs?service=git-receive-pack",
    "/github/acme/repo.git/info/refs?service=git-receive-pack&extra=1",
    "/github/acme/repo.git/info/refs?service=arbitrary",
    "/github/acme/repo.git/objects/secret",
  ])("refuses a path outside the lease and protocol: %s", async (path) => {
    const t = await setup();
    expect((await t.request(path)).status).toBe(403);
    expect(t.controlFetch).not.toHaveBeenCalled();
    expect(t.upstream).not.toHaveBeenCalled();
  });

  it.each(["expired", "sealed", "paused", "revoked"])(
    "invalidates a lease when %s",
    async (reason) => {
      const t = await setup();
      if (reason === "expired") t.advance();
      if (reason === "sealed") t.session.sealed = true;
      if (reason === "paused") t.session.control.paused = "pause";
      if (reason === "revoked") t.host.host_status = "revoked";
      expect((await t.request()).status).toBe(403);
      expect(t.controlFetch).not.toHaveBeenCalled();
    },
  );

  it("refuses ambiguous or absent sessions and malformed lease requests", async () => {
    const t = await setup();
    expect(t.proxy.issue(null as never).status).toBe(400);
    expect(
      t.proxy.issue({
        repository: "Acme/Repo",
        cwd: "/elsewhere",
        harness: "claude-code",
      }).status,
    ).toBe(409);
    t.registry.ensure("second", { cwd: "/repo", harness: "claude-code" });
    expect(
      t.proxy.issue({
        repository: "Acme/Repo",
        cwd: "/repo",
        harness: "claude-code",
      }).status,
    ).toBe(409);
    t.host.github_broker_enabled = false;
    expect(t.proxy.issue({}).status).toBe(403);
  });

  it("requires local authentication for lease issuance and protects the proxy from browser origins", async () => {
    const t = await setup();
    expect(
      (await fetch(`${t.base}/github-lease`, { method: "POST", body: "{}" }))
        .status,
    ).toBe(401);
    expect(
      (
        await t.request(undefined, {
          headers: { Origin: "https://attacker.test" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(
          `${t.base}/github/acme/repo.git/info/refs?service=git-receive-pack`,
        )
      ).status,
    ).toBe(401);
    expect(t.controlFetch).not.toHaveBeenCalled();
  });

  it.each(["bad-signature", "stale"])(
    "refuses %s before obtaining a vendor credential",
    async (reason) => {
      const t = await setup();
      if (reason === "bad-signature") t.host.bundle.mode = "observe";
      else t.host.deny_generation = { org: 99, workspace: 99 };
      expect((await t.request()).status).toBe(403);
      expect(t.controlFetch).not.toHaveBeenCalled();
    },
  );

  it("aborts an in-flight Git request when its session is paused", async () => {
    const t = await setup();
    let signal: AbortSignal | undefined;
    t.upstream.mockImplementationOnce(async (_url, init) => {
      if (init?.body) await new Response(init.body).text();
      t.session.control.paused = "operator pause";
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) =>
        signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        }),
      );
    });
    expect(
      (
        await t.request("/github/acme/repo.git/git-receive-pack", {
          method: "POST",
          headers: { "content-type": "application/x-git-receive-pack-request" },
          body: "pack-in-flight",
        })
      ).status,
    ).toBe(502);
    expect(signal?.aborted).toBe(true);
    await vi.waitFor(() => expect(t.upstream).toHaveBeenCalledTimes(2));
    expect(t.upstream.mock.calls[1]?.[0]).toBe(
      "https://api.github.com/installation/token",
    );
  });

  it("denies a signed policy refusal before minting", async () => {
    const t = await setup();
    t.host.bundle = t.signer.sign(unsignedBundle());
    expect((await t.request()).status).toBe(403);
    expect(t.controlFetch).not.toHaveBeenCalled();
  });

  it("does not forward when the control plane refuses the binding", async () => {
    const t = await setup();
    t.controlFetch.mockResolvedValue(new Response("refused", { status: 404 }));
    expect((await t.request()).status).toBe(404);
    expect(t.upstream).not.toHaveBeenCalled();
  });

  it("does not follow redirects or disclose upstream credentials in errors", async () => {
    const t = await setup();
    t.upstream.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "https://attacker.test" },
      }),
    );
    const response = await t.request();
    expect(response.status).toBe(502);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).not.toContain(SECRET);
    await vi.waitFor(() => expect(t.upstream).toHaveBeenCalledTimes(2));
    expect(t.upstream.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  it("rechecks the session after a token is minted and revokes without forwarding", async () => {
    const t = await setup();
    t.controlFetch.mockImplementationOnce(async () => {
      t.session.sealed = true;
      return new Response(
        JSON.stringify({
          token: SECRET,
          expires_at: new Date(NOW + 3600_000).toISOString(),
        }),
      );
    });
    expect((await t.request()).status).toBe(403);
    await vi.waitFor(() => expect(t.forwarded).toHaveLength(1));
    expect(t.forwarded[0]?.url).toBe(
      "https://api.github.com/installation/token",
    );
  });
});
