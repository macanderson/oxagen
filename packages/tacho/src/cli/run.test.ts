import { mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeHostFile } from "../host/host-file";
import {
  bundleSigner,
  scratchPaths,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import { runContained, type ContainedRunDeps } from "./run";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

function enrolled(env: Record<string, string> = {}) {
  const paths = scratchPaths("linux");
  const signer = bundleSigner();
  mkdirSync(dirname(paths.hostFile), { recursive: true });
  writeHostFile(
    paths.hostFile,
    testHostFile(signer, signer.sign(unsignedBundle())),
  );
  const err = vi.fn();
  const write = vi.fn();
  const deps: ContainedRunDeps = {
    paths,
    env,
    platform: "linux",
    err,
    write,
    cwd: "/work/repo",
  };
  return { deps, err, write, paths };
}

/** The daemon's `/contained/run` over its real Unix socket. */
async function daemon(
  socketPath: string,
  lines: unknown[],
  seen: { body?: unknown; authorization?: string } = {},
) {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    seen.body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    seen.authorization = req.headers.authorization;
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    for (const line of lines) res.write(`${JSON.stringify(line)}\n`);
    res.end();
  });
  servers.push(server);
  mkdirSync(dirname(socketPath), { recursive: true });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return seen;
}

describe("oxagen agent run --contained", () => {
  it("streams the agent's output and exits with its code", async () => {
    const { deps, write, paths } = enrolled({
      OXAGEN_CONTAINED_IMAGE: "oxagen/contained-claude:1",
    });
    const seen = await daemon(paths.socket, [
      { stream: "stdout", text: "working\n" },
      { stream: "stderr", text: "warn\n" },
      { result: { sessionId: "contained-x", exitCode: 3 } },
    ]);
    const code = await runContained(
      { agent: "claude", args: ["-p", "fix the test"] },
      deps,
    );
    expect(code).toBe(3);
    expect(write.mock.calls).toEqual([
      ["stdout", "working\n"],
      ["stderr", "warn\n"],
    ]);
    expect(seen.authorization).toBe("Bearer local-token-0123456789abcdef");
    expect(seen.body).toEqual({
      workspace: "/work/repo",
      harness: "claude-code",
      args: ["-p", "fix the test"],
      image: "oxagen/contained-claude:1",
    });
  });

  it("sends a relative --workspace resolved against this directory, not tachod's", async () => {
    const { deps, paths } = enrolled();
    const seen = await daemon(paths.socket, [
      { result: { sessionId: "contained-x", exitCode: 0 } },
    ]);
    expect(
      await runContained(
        { agent: "claude", args: [], image: "img", workspace: "../other" },
        deps,
      ),
    ).toBe(0);
    expect(seen.body).toMatchObject({ workspace: "/work/other" });
  });

  it("sends an absolute --workspace as given", async () => {
    const { deps, paths } = enrolled();
    const seen = await daemon(paths.socket, [
      { result: { sessionId: "contained-x", exitCode: 0 } },
    ]);
    expect(
      await runContained(
        { agent: "claude", args: [], image: "img", workspace: "/src/app" },
        deps,
      ),
    ).toBe(0);
    expect(seen.body).toMatchObject({ workspace: "/src/app" });
  });

  it("names the run's one repository and hands over no GitHub token", async () => {
    const { deps, paths } = enrolled({ GITHUB_REPOSITORY: "acme/other" });
    const seen = await daemon(paths.socket, [
      { result: { sessionId: "contained-x", exitCode: 0 } },
    ]);
    expect(
      await runContained(
        {
          agent: "codex",
          args: ["exec", "t"],
          image: "img",
          githubRepository: "acme/app",
        },
        deps,
      ),
    ).toBe(0);
    // Only the flag names the repository. The runner's own GITHUB_REPOSITORY
    // does not widen a run that named none, or replace one that did.
    expect(seen.body).toMatchObject({
      harness: "codex",
      github: { repository: "acme/app" },
    });
    expect(JSON.stringify(seen.body)).not.toContain("token");
  });

  it("names no repository when the flag is absent", async () => {
    const { deps, paths } = enrolled({ GITHUB_REPOSITORY: "acme/app" });
    const seen = await daemon(paths.socket, [
      { result: { sessionId: "contained-x", exitCode: 0 } },
    ]);
    expect(
      await runContained({ agent: "claude", args: [], image: "img" }, deps),
    ).toBe(0);
    expect(seen.body).not.toHaveProperty("github");
  });

  it("prints the launcher's refusal and exits 1", async () => {
    const { deps, err, paths } = enrolled();
    await daemon(paths.socket, [
      {
        error:
          "Contained execution requires an unprivileged Linux runner with Docker",
      },
    ]);
    expect(
      await runContained({ agent: "claude", args: [], image: "img" }, deps),
    ).toBe(1);
    expect(err).toHaveBeenCalledWith(
      "The contained run did not complete: Contained execution requires an unprivileged Linux runner with Docker",
    );
  });

  it.each([
    [{ agent: "cursor", args: [], image: "img" }, {}, /Name the agent/],
    [{ agent: undefined, args: [], image: "img" }, {}, /Name the agent/],
    [{ agent: "claude", args: [] }, {}, /Name the contained image/],
    [
      { agent: "claude", args: [], image: "img" },
      { OXAGEN_CONTAINED_GITHUB_TOKEN: `ghs_${"c".repeat(36)}` },
      /OXAGEN_CONTAINED_GITHUB_TOKEN is no longer read/,
    ],
    [
      {
        agent: "claude",
        args: [],
        image: "img",
        githubRepository: "acme/app",
      },
      { OXAGEN_CONTAINED_GITHUB_TOKEN: `ghs_${"c".repeat(36)}` },
      /bind the repository to the workspace/,
    ],
  ])("refuses before asking the daemon: %j", async (command, env, message) => {
    const { deps, err } = enrolled(env as Record<string, string>);
    const stream = vi.fn();
    expect(await runContained(command, { ...deps, stream })).toBe(2);
    expect(stream).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledWith(expect.stringMatching(message));
  });

  it("says so when the daemon is not running", async () => {
    const { deps, err } = enrolled();
    expect(
      await runContained({ agent: "claude", args: [], image: "img" }, deps),
    ).toBe(1);
    expect(err).toHaveBeenCalledWith(
      expect.stringMatching(/could not reach tachod/),
    );
  });

  it("refuses on a machine that is not enrolled", async () => {
    const deps: ContainedRunDeps = {
      paths: scratchPaths("linux"),
      env: {},
      platform: "linux",
      err: vi.fn(),
      write: vi.fn(),
      cwd: "/work/repo",
    };
    expect(
      await runContained({ agent: "claude", args: [], image: "img" }, deps),
    ).toBe(1);
    expect(deps.err).toHaveBeenCalledWith(
      "This machine is not enrolled. Run `oxagen agent enroll` first.",
    );
  });
});
