import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  fakeListTools: vi.fn(),
  fakeCallTool: vi.fn(),
  fakeConnect: vi.fn(),
  fakeClose: vi.fn(),
  ClientMock: vi.fn(),
  TransportMock: vi.fn(),
}));

mocks.fakeListTools.mockImplementation(async () => ({
  tools: [
    { name: "search", inputSchema: { type: "object" }, description: "search remote" },
    { name: "fetch", inputSchema: { type: "object" }, description: "fetch remote" },
  ],
}));
mocks.fakeCallTool.mockImplementation(async () => ({ content: [{ type: "text", text: "ok" }] }));
mocks.fakeConnect.mockImplementation(async () => undefined);
mocks.fakeClose.mockImplementation(async () => undefined);
mocks.ClientMock.mockImplementation(() => ({
  connect: mocks.fakeConnect,
  listTools: mocks.fakeListTools,
  callTool: mocks.fakeCallTool,
  close: mocks.fakeClose,
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: mocks.ClientMock,
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: mocks.TransportMock,
}));

import {
  connectMcp,
  listMcpTools,
  materializeMcpTools,
  healthcheck,
} from "./mcp-client.js";

describe("mcp-client", () => {
  beforeEach(() => {
    mocks.ClientMock.mockClear();
    mocks.TransportMock.mockClear();
    mocks.fakeListTools.mockClear();
    mocks.fakeCallTool.mockClear();
    mocks.fakeConnect.mockClear();
    mocks.fakeClose.mockClear();
    mocks.fakeConnect.mockImplementation(async () => undefined);
  });

  it("connectMcp builds transport with URL + bearer auth and calls client.connect", async () => {
    await connectMcp({
      endpointUrl: "https://example.test/mcp",
      authStrategy: "bearer",
      authConfig: { token: "abc" },
    });
    expect(mocks.TransportMock).toHaveBeenCalledTimes(1);
    const args = mocks.TransportMock.mock.calls[0]!;
    expect(args[0]).toBeInstanceOf(URL);
    expect((args[0] as URL).toString()).toBe("https://example.test/mcp");
    const opts = args[1] as { requestInit: { headers: Record<string, string> } };
    expect(opts.requestInit.headers.authorization).toBe("Bearer abc");
    expect(mocks.fakeConnect).toHaveBeenCalledTimes(1);
  });

  it("listMcpTools returns the discovered tool names", async () => {
    const client = await connectMcp({
      endpointUrl: "https://example.test/mcp",
      authStrategy: "none",
    });
    const names = await listMcpTools(client);
    expect(names).toEqual(["search", "fetch"]);
  });

  it("materializeMcpTools wraps each remote tool as an AI SDK tool", async () => {
    const client = await connectMcp({
      endpointUrl: "https://example.test/mcp",
      authStrategy: "none",
    });
    const tools = await materializeMcpTools(client, "ext");
    expect(Object.keys(tools).sort()).toEqual(["ext.fetch", "ext.search"]);
    const t = tools["ext.search"] as { description?: string; execute?: (i: unknown) => Promise<unknown> };
    expect(t.description).toBe("search remote");
    const res = await t.execute!({ q: "hello" });
    expect(mocks.fakeCallTool).toHaveBeenCalledWith({ name: "search", arguments: { q: "hello" } });
    expect(res).toEqual([{ type: "text", text: "ok" }]);
  });

  it("healthcheck returns healthy when the client responds", async () => {
    const res = await healthcheck({
      endpointUrl: "https://example.test/mcp",
      authStrategy: "none",
    });
    expect(res.status).toBe("healthy");
    expect(res.discoveredTools).toEqual(["search", "fetch"]);
    expect(mocks.fakeClose).toHaveBeenCalledTimes(1);
  });

  it("healthcheck returns unreachable on connect error", async () => {
    mocks.fakeConnect.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    const res = await healthcheck({
      endpointUrl: "https://example.test/mcp",
      authStrategy: "none",
    });
    expect(res.status).toBe("unreachable");
    expect(res.discoveredTools).toEqual([]);
  });
});
