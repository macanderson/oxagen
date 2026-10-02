import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyBundle } from "../host/bundle";
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
const scratch: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/**
 * The refusal `create_github_token` gives for the workspace's steering
 * repository, in the envelope the API's error middleware sends: the message
 * of `steeringRepoProposeOnly` in
 * `packages/handlers/src/tacho.github_token.issue.ts` (#4575).
 */
const STEERING_MESSAGE =
  "The steering repository takes changes through a steering PR. Call steering_propose, or push a branch from a clone with a credential that can write to it.";
function steeringRefusal(): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: "conflict",
        reason: "steering_repo_propose_only",
        message: STEERING_MESSAGE,
      },
      requestId: "req_steering",
    }),
    { status: 409, headers: { "content-type": "application/json" } },
  );
}

const execFileAsync = promisify(execFile);

/**
 * Run a real git that must fail, and return what it printed to stderr. Git
 * runs with no global or system configuration and no proxy, so neither the
 * machine's settings nor an HTTP proxy in the environment reach the loopback
 * listener. Async, because the proxy answers from this same process.
 */
async function gitStderr(args: string[]): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "tacho-git-proxy-"));
  scratch.push(dir);
  const config = join(dir, "gitconfig");
  writeFileSync(config, "");
  try {
    await execFileAsync("git", args, {
      cwd: dir,
      timeout: 20_000,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: config,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        http_proxy: "",
        HTTP_PROXY: "",
        https_proxy: "",
        HTTPS_PROXY: "",
        all_proxy: "",
        ALL_PROXY: "",
        no_proxy: "*",
        NO_PROXY: "*",
      },
    });
  } catch (error) {
    return String((error as { stderr?: unknown }).stderr ?? "");
  }
  throw new Error(`git ${args[0] ?? ""} succeeded against a refusing proxy`);
}

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
      github_repositories: [
        {
          cwd: "/repo",
          repository: "acme/repo",
          harness: "claude-code",
          url: "http://127.0.0.1:47001/github/acme/repo.git",
          helper: "helper",
          remotes: [],
        },
      ],
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
  let confirmedAt = NOW;
  const refreshBundle = vi.fn(async () => {
    confirmedAt = now;
    return true;
  });
  const proxy = createGithubProxy({
    policy: () => ({
      bundle: host.bundle,
      verified: verifyBundle(host.bundle, host.bundle_public_key_pem).ok,
      hostStatus: host.host_status,
      denyGeneration: host.deny_generation,
      controlReachable: true,
      mandateConfirmedAt: confirmedAt,
    }),
    refreshBundle,
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
    refreshBundle,
    setConfirmedAt: (at: number) => {
      confirmedAt = at;
    },
    token,
    request,
    advance: () => {
      now += 16 * 60_000;
    },
  };
}

describe("GitHub daemon custody", () => {
  it("binds leases to the configured repository and harness receipt", async () => {
    const t = await setup();
    expect(
      t.proxy.issue({
        repository: "Acme/Other",
        cwd: "/repo",
        harness: "claude-code",
      }).status,
    ).toBe(403);
    expect(
      t.proxy.issue({ repository: "Acme/Repo", cwd: "/repo", harness: "codex" })
        .status,
    ).toBe(403);
    t.host.github_repositories = [];
    expect((await t.request()).status).toBe(403);
    expect(t.controlFetch).not.toHaveBeenCalled();
  });

  it("uses the daemon confirmation and refreshes a deferred mandate", async () => {
    const t = await setup();
    t.host.bundle_fetched_at = "2020-01-01T00:00:00.000Z";
    expect((await t.request()).status).toBe(200);
    expect(t.refreshBundle).not.toHaveBeenCalled();
    t.host.bundle_fetched_at = new Date(NOW).toISOString();
    t.setConfirmedAt(NOW - 366 * 86400_000);
    expect((await t.request()).status).toBe(200);
    expect(t.refreshBundle).toHaveBeenCalledOnce();
  });

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
    ).toBe(403);
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

  it("passes the API's steering refusal to git as plain text", async () => {
    const t = await setup();
    t.controlFetch.mockImplementation(async () => steeringRefusal());
    const response = await t.request();
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toBe("text/plain");
    const body = await response.text();
    // The message and nothing else from the JSON envelope.
    expect(body).toBe(
      `Oxagen refused access to this repository. ${STEERING_MESSAGE}`,
    );
    expect(body).not.toContain("steering_repo_propose_only");
    expect(body).not.toContain("req_steering");
    expect(t.upstream).not.toHaveBeenCalled();
  });

  it("shows the steering refusal to a real git client", async () => {
    const t = await setup();
    t.controlFetch.mockImplementation(async () => steeringRefusal());
    const { port } = new URL(t.base);
    const stderr = await gitStderr([
      "ls-remote",
      `http://oxagen:${t.token}@127.0.0.1:${port}/github/acme/repo.git`,
    ]);
    // Git prints a text/plain error body line by line after `remote:`.
    expect(stderr).toContain(
      `remote: Oxagen refused access to this repository. ${STEERING_MESSAGE}`,
    );
    expect(stderr).not.toContain("steering_repo_propose_only");
    expect(t.upstream).not.toHaveBeenCalled();
  });

  it("keeps a 404 a 404 and says only the refusal when the body has no message", async () => {
    const t = await setup();
    t.controlFetch.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "not_found",
              reason: "repository_not_governed",
              message: "No repository in this workspace is bound to acme/repo",
            },
          }),
          { status: 404 },
        ),
    );
    let response = await t.request();
    expect(response.status).toBe(404);
    expect(await response.text()).toBe(
      "Oxagen refused access to this repository. No repository in this workspace is bound to acme/repo",
    );

    t.controlFetch.mockImplementation(
      async () => new Response("<html>denied</html>", { status: 403 }),
    );
    response = await t.request();
    expect(response.status).toBe(403);
    expect(await response.text()).toBe(
      "Oxagen refused access to this repository",
    );
    expect(t.upstream).not.toHaveBeenCalled();
  });

  it("puts a refusal on one line with no control characters", async () => {
    const t = await setup();
    t.controlFetch.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "forbidden",
              message: "\u001b[31mHost\u001b[0m is not active.\nEnroll it again.",
            },
          }),
          { status: 403 },
        ),
    );
    const response = await t.request();
    expect(response.status).toBe(403);
    const body = await response.text();
    expect(body).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(body).toBe(
      "Oxagen refused access to this repository. [31mHost [0m is not active. Enroll it again.",
    );
  });

  it("never passes on a 5xx body", async () => {
    const t = await setup();
    t.controlFetch.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "internal_error",
              message: "connect ECONNREFUSED 10.0.4.17:5432",
            },
          }),
          { status: 500 },
        ),
    );
    const response = await t.request();
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).toBe(
      "Oxagen could not issue a credential for this repository. Try again.",
    );
    expect(body).not.toContain("10.0.4.17");
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

  it("leases the contained launcher's own session without a receipt, until released", async () => {
    const t = await setup();
    // A CI runner never ran `tacho github configure`.
    t.host.github_broker_enabled = false;
    t.host.github_repositories = [];
    const lease = t.proxy.issueForSession({
      session: t.session.recorder.sessionUuid,
      repository: "Acme/Repo",
    });
    expect(lease.status).toBe(200);
    const token = (lease.body as { token: string }).token;
    expect(token).toMatch(/^oxgit_/);
    const fetchRefs = () =>
      fetch(
        `${t.base}/github/acme/repo.git/info/refs?service=git-upload-pack`,
        {
          headers: {
            Authorization: `Basic ${Buffer.from(`oxagen:${token}`).toString("base64")}`,
          },
        },
      );
    expect((await fetchRefs()).status).toBe(200);
    expect(JSON.stringify(t.recorded)).toContain('"gateway_brokered"');
    // A configured checkout's lease still needs its receipt.
    expect((await t.request()).status).toBe(403);
    t.proxy.release(token);
    expect((await fetchRefs()).status).toBe(401);
  });

  it("refuses a contained lease for a malformed repository, an unknown or stopped session, or an inactive host", async () => {
    const t = await setup();
    const session = t.session.recorder.sessionUuid;
    expect(
      t.proxy.issueForSession({ session, repository: "acme" }).status,
    ).toBe(400);
    expect(
      t.proxy.issueForSession({ session, repository: "acme/.." }).status,
    ).toBe(400);
    expect(
      t.proxy.issueForSession({
        session: "0192f000-0000-7000-8000-00000000dead",
        repository: "acme/repo",
      }).status,
    ).toBe(403);
    t.session.control.cancelled = "operator cancel";
    expect(
      t.proxy.issueForSession({ session, repository: "acme/repo" }).status,
    ).toBe(403);
    t.session.control.cancelled = null;
    t.host.host_status = "paused";
    expect(
      t.proxy.issueForSession({ session, repository: "acme/repo" }).status,
    ).toBe(403);
    expect(t.controlFetch).not.toHaveBeenCalled();
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
