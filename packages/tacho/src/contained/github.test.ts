import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { containedBridgeHandler, type ContainedBridgeOptions } from "./bridge";
import {
  containedGitHubSchema,
  gitHubTarget,
  revokeRunGitHubToken,
  verifyRunGitHubToken,
} from "./github";

const TOKEN = `ghs_${"a".repeat(36)}`;
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
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("No test listener");
  return `http://127.0.0.1:${address.port}`;
}

function answer(status: number, body: unknown) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  }));
}

describe("the run's GitHub grant", () => {
  it("accepts only an installation token for one named repository", () => {
    expect(
      containedGitHubSchema.safeParse({ repository: "acme/app", token: TOKEN })
        .success,
    ).toBe(true);
    for (const bad of [
      { repository: "acme/app", token: "ghp_personal0000000000000000000" },
      { repository: "acme", token: TOKEN },
      { repository: "acme/..", token: TOKEN },
      { repository: "acme/app", token: TOKEN, scope: "all" },
    ])
      expect(containedGitHubSchema.safeParse(bad).success).toBe(false);
  });

  it("refuses a token that reaches more than the run's repository", async () => {
    const wide = answer(200, {
      total_count: 2,
      repositories: [{ full_name: "acme/app" }, { full_name: "acme/infra" }],
    });
    await expect(
      verifyRunGitHubToken({ repository: "acme/app", token: TOKEN }, wide),
    ).rejects.toThrow(/acme\/app and no other repository/);
    const narrow = answer(200, {
      total_count: 1,
      repositories: [{ full_name: "Acme/App" }],
    });
    await expect(
      verifyRunGitHubToken({ repository: "acme/app", token: TOKEN }, narrow),
    ).resolves.toBeUndefined();
    expect(narrow).toHaveBeenCalledWith(
      "https://api.github.com/installation/repositories?per_page=2",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ authorization: `Bearer ${TOKEN}` }),
      }),
    );
  });

  it("revokes at seal and treats an already invalid token as revoked", async () => {
    await expect(revokeRunGitHubToken(TOKEN, answer(204, {}))).resolves.toBe(
      "revoked",
    );
    await expect(revokeRunGitHubToken(TOKEN, answer(401, {}))).resolves.toBe(
      "already_invalid",
    );
    await expect(revokeRunGitHubToken(TOKEN, answer(500, {}))).rejects.toThrow(
      /did not revoke/,
    );
  });

  it.each([
    ["/github/git/acme/app.git/info/refs?service=git-upload-pack", "git"],
    ["/github/git/acme/app/git-receive-pack", "git"],
    ["/github/api/repos/acme/app/pulls?state=open", "api"],
    ["/github/api/repos/ACME/app", "api"],
  ])("routes %s for the run's repository", (path, kind) => {
    expect(gitHubTarget(path, "acme/app")?.kind).toBe(kind);
  });

  it.each([
    "/github/git/acme/infra.git/info/refs?service=git-upload-pack",
    "/github/git/acme/app.git/objects/info/packs",
    "/github/api/repos/acme/infra/pulls",
    "/github/api/repos/acme/app/../infra",
    "/github/api/repos/acme/app/%2e%2e/infra",
    "/github/api/user",
    "/github/api/installation/token",
    "/github/api/graphql",
  ])("refuses %s", (path) => {
    expect(gitHubTarget(path, "acme/app")).toBeUndefined();
  });
});

describe("the bridge's GitHub route", () => {
  async function bridge(overrides: Partial<ContainedBridgeOptions>) {
    const seen: IncomingMessage[] = [];
    const upstream = await listen((request, response) => {
      seen.push(request);
      response.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": "session=upstream",
      });
      response.end(JSON.stringify({ url: request.url }));
    });
    const options: ContainedBridgeOptions = {
      socketPath: "/unused",
      sessionId: "owned-session",
      workspace: "/owned/repository",
      harness: "claude-code",
      modelPort: 4102,
      issueCredential: vi.fn(() => "private-run-token"),
      model: vi.fn(),
      hook: vi.fn(async () => ({})),
      mcp: vi.fn(async () => ({ status: 200, body: {} })),
      refused: vi.fn(),
      forwarded: vi.fn(),
      github: { repository: "acme/app", token: TOKEN },
      githubUpstreams: { api: upstream, git: upstream },
      ...overrides,
    };
    const base = await listen(containedBridgeHandler(options));
    return { base, options, seen };
  }

  it("adds the token outside the sandbox and drops the sandbox's credential", async () => {
    const { base, options, seen } = await bridge({});
    const response = await fetch(
      `${base}/github/git/acme/app.git/info/refs?service=git-upload-pack`,
      { headers: { authorization: "Basic c3RvbGVuOnN0b2xlbg==" } },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toEqual({
      url: "/acme/app.git/info/refs?service=git-upload-pack",
    });
    expect(seen[0]?.headers.authorization).toBe(
      `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`,
    );
    expect(options.forwarded).toHaveBeenCalledWith(
      "GET",
      "/github/git/acme/app.git/info/refs?service=git-upload-pack",
    );
  });

  it("refuses another repository and records the refusal", async () => {
    const { base, options, seen } = await bridge({});
    const response = await fetch(`${base}/github/api/repos/acme/infra/pulls`);
    expect(response.status).toBe(403);
    expect(seen).toHaveLength(0);
    expect(options.refused).toHaveBeenCalledWith(
      "/github/api/repos/acme/infra/pulls",
    );
  });

  it("refuses every GitHub route when the run has no grant", async () => {
    const { base, options, seen } = await bridge({ github: undefined });
    const response = await fetch(`${base}/github/api/repos/acme/app`);
    expect(response.status).toBe(403);
    expect(seen).toHaveLength(0);
    expect(options.forwarded).not.toHaveBeenCalled();
  });
});
