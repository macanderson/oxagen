import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { containedBridgeHandler, type ContainedBridgeOptions } from "./bridge";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
});
async function setup(overrides: Partial<ContainedBridgeOptions> = {}) {
  const options: ContainedBridgeOptions = {
    socketPath: "/unused",
    sessionId: "owned-session",
    workspace: "/owned/repository",
    harness: "claude-code",
    modelPort: 4102,
    issueCredential: vi.fn(() => "private-run-token"),
    model: vi.fn((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ path: request.url, headers: request.headers }),
      );
    }),
    hook: vi.fn(async () => ({ accepted: true })),
    mcp: vi.fn(async () => ({ status: 200, body: { result: {} } })),
    refused: vi.fn(),
    ...overrides,
  };
  const server = createServer(containedBridgeHandler(options));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("No test listener");
  return {
    options,
    post: (
      path: string,
      body: unknown = {},
      headers: Record<string, string> = {},
    ) =>
      fetch(`http://127.0.0.1:${address.port}${path}`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json", ...headers },
      }),
  };
}

describe("contained gateway boundary", () => {
  it("replaces caller identity and credentials on a model request", async () => {
    const { options, post } = await setup();
    const response = await post(
      "/model/v1/messages",
      { model: "example" },
      {
        authorization: "Bearer stolen",
        "x-api-key": "foreign",
        "x-oxagen-session": "victim",
        origin: "https://foreign.example",
      },
    );
    expect(await response.json()).toMatchObject({
      path: "/anthropic/v1/messages",
      headers: {
        "x-api-key": "private-run-token",
        "x-oxagen-session": "owned-session",
        host: "127.0.0.1:4102",
      },
    });
    expect(options.issueCredential).toHaveBeenCalledOnce();
    const request = vi.mocked(options.model).mock.calls[0]?.[0];
    expect(request?.headers.authorization).toBeUndefined();
    expect(request?.headers.origin).toBeUndefined();
  });

  it("selects the OpenAI route for Codex and refuses Anthropic routes", async () => {
    const { post } = await setup({ harness: "codex" });
    expect(await (await post("/model/v1/responses")).json()).toMatchObject({
      path: "/openai/v1/responses",
      headers: { authorization: "Bearer private-run-token" },
    });
    expect((await post("/model/v1/messages")).status).toBe(403);
  });

  it.each([
    "/credential/issue",
    "/contained/run",
    "/status",
    "/model/v1/files",
    "/model/v1/messages?target=elsewhere",
    "/github-lease",
  ])("refuses unapproved route %s", async (path) => {
    const { options, post } = await setup();
    expect((await post(path)).status).toBe(403);
    expect(options.refused).toHaveBeenCalledWith(path);
    expect(options.model).not.toHaveBeenCalled();
    expect(options.issueCredential).not.toHaveBeenCalled();
  });

  it("pins hook session and workspace and discards host file paths", async () => {
    const { options, post } = await setup();
    expect(
      (
        await post("/hook", {
          hook_event_name: "PreToolUse",
          session_id: "victim",
          cwd: "/etc",
          transcript_path: "/etc/passwd",
          pid: 1,
        })
      ).status,
    ).toBe(200);
    expect(options.hook).toHaveBeenCalledWith({
      harness: "claude-code",
      payload: {
        hook_event_name: "PreToolUse",
        session_id: "owned-session",
        cwd: "/owned/repository",
      },
    });
  });

  it("does not forward when credential custody fails", async () => {
    const { options, post } = await setup({
      issueCredential: () => {
        throw new Error("credential unavailable");
      },
    });
    expect((await post("/model/v1/messages")).status).toBe(502);
    expect(options.model).not.toHaveBeenCalled();
  });
});
