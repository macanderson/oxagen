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
    {
      name: "search",
      inputSchema: { type: "object" },
      description: "search remote",
    },
    {
      name: "fetch",
      inputSchema: { type: "object" },
      description: "fetch remote",
    },
  ],
}));
mocks.fakeCallTool.mockImplementation(async () => ({
  content: [{ type: "text", text: "ok" }],
}));
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

// stdio transport: each construction records an instance with a spy-able close()
// so cleanup/dispose can be asserted; getDefaultEnvironment is mocked to a known
// baseline so the env-merge behaviour is verifiable.
interface FakeStdioTransport {
  params: unknown;
  close: ReturnType<typeof vi.fn>;
  onclose?: (() => void) | undefined;
}
const stdioMocks = vi.hoisted(() => {
  const instances: unknown[] = [];
  const StdioTransportMock = vi.fn((params: unknown) => {
    const inst = {
      params,
      close: vi.fn(async () => undefined),
      onclose: undefined as (() => void) | undefined,
    };
    instances.push(inst);
    return inst;
  });
  const getDefaultEnvironment = vi.fn(() => ({
    PATH: "/usr/bin",
    HOME: "/home/x",
  }));
  return { instances, StdioTransportMock, getDefaultEnvironment };
});

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: stdioMocks.StdioTransportMock,
  getDefaultEnvironment: stdioMocks.getDefaultEnvironment,
}));

import {
  connectMcp,
  connectMcpStdio,
  closeStdioMcpTransports,
  listMcpTools,
  materializeMcpTools,
  healthcheck,
} from "./mcp-client";

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
    const opts = args[1] as {
      requestInit: { headers: Record<string, string> };
    };
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
    const t = tools["ext.search"] as {
      description?: string;
      execute?: (i: unknown) => Promise<unknown>;
    };
    expect(t.description).toBe("search remote");
    const res = await t.execute!({ q: "hello" });
    expect(mocks.fakeCallTool).toHaveBeenCalledWith({
      name: "search",
      arguments: { q: "hello" },
    });
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

describe("mcp-client stdio transport", () => {
  beforeEach(async () => {
    // Reap any transports leaked from a prior test so the module-level tracking
    // set is clean, then reset the recorded instances + spies.
    await closeStdioMcpTransports();
    stdioMocks.instances.length = 0;
    stdioMocks.StdioTransportMock.mockClear();
    stdioMocks.getDefaultEnvironment.mockClear();
    mocks.ClientMock.mockClear();
    mocks.fakeConnect.mockClear();
    mocks.fakeConnect.mockImplementation(async () => undefined);
  });

  it("connectMcpStdio spawns the command with args, cwd, inherited stderr, and merged env", async () => {
    await connectMcpStdio({
      command: "node",
      args: ["server.js", "--port", "9000"],
      env: { API_KEY: "sekret" },
      cwd: "/work/dir",
    });
    expect(stdioMocks.StdioTransportMock).toHaveBeenCalledTimes(1);
    const params = stdioMocks.StdioTransportMock.mock.calls[0]![0] as {
      command: string;
      args: string[];
      env: Record<string, string>;
      cwd?: string;
      stderr?: string;
    };
    expect(params.command).toBe("node");
    expect(params.args).toEqual(["server.js", "--port", "9000"]);
    expect(params.cwd).toBe("/work/dir");
    expect(params.stderr).toBe("inherit");
    // Config env is merged OVER the SDK default environment (PATH survives).
    expect(params.env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/x",
      API_KEY: "sekret",
    });
    expect(mocks.fakeConnect).toHaveBeenCalledTimes(1);
  });

  it("defaults args to [] when omitted", async () => {
    await connectMcpStdio({ command: "python" });
    const params = stdioMocks.StdioTransportMock.mock.calls[0]![0] as {
      args: string[];
    };
    expect(params.args).toEqual([]);
  });

  it("closeStdioMcpTransports reaps every spawned child (dispose cleanup)", async () => {
    await connectMcpStdio({ command: "node", args: ["a.js"] });
    await connectMcpStdio({ command: "node", args: ["b.js"] });
    const [first, second] = stdioMocks.instances as FakeStdioTransport[];
    expect(first!.close).not.toHaveBeenCalled();
    expect(second!.close).not.toHaveBeenCalled();

    await closeStdioMcpTransports();
    expect(first!.close).toHaveBeenCalledTimes(1);
    expect(second!.close).toHaveBeenCalledTimes(1);

    // Idempotent: a second dispose is a no-op (transports already cleared).
    await closeStdioMcpTransports();
    expect(first!.close).toHaveBeenCalledTimes(1);
  });

  it("drops a transport from tracking when it closes on its own (onclose)", async () => {
    await connectMcpStdio({ command: "node", args: ["a.js"] });
    const inst = stdioMocks.instances[0] as FakeStdioTransport;
    // Simulate the child exiting / pipe breaking — the SDK fires onclose.
    inst.onclose?.();
    // Now dispose: the self-closed transport must NOT be closed again.
    await closeStdioMcpTransports();
    expect(inst.close).not.toHaveBeenCalled();
  });
});
