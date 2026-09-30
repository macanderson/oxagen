import { afterEach, describe, expect, it, vi } from "vitest";
import { TACHO_VERSION } from "../../version";
import { deadlinePassed, LocalServerError, serverFailed, type LocalServerRefusal } from "./errors";
import {
  callTool,
  DEFAULT_MAX_LINE_CHARS,
  listTools,
  MAX_TOOL_PAGES,
  MCP_PROTOCOL_VERSION,
  type StdioSessionOptions,
  type StdioSpawn,
} from "./stdio-client";
import { fakeSpawn, mcpServer, type FakeChild, type FakeSpawn, type McpServerBehaviour, type RpcAnswer } from "./test-support";

const LAUNCH = {
  server: "files",
  command: "npx",
  args: ["--yes", "@modelcontextprotocol/server-filesystem@2026.8.1", "/work"],
  env: { PATH: "/usr/bin", WORK_DIR: "/work" },
};

const TOOL = { name: "read_file", inputSchema: { type: "object" } };
const WRITE_TOOL = { name: "write_file", inputSchema: { type: "object" } };
const TEXT_RESULT = { content: [{ type: "text", text: "hello" }] };
const STOPPED = "the local gateway stopped before it answered";

function behaviour(overrides?: Partial<McpServerBehaviour>): McpServerBehaviour {
  return {
    serverInfo: { name: "files", version: "2026.8.1" },
    tools: [TOOL],
    call: () => TEXT_RESULT,
    ...overrides,
  };
}

function options(spawn: StdioSpawn, overrides?: Partial<StdioSessionOptions>): StdioSessionOptions {
  return { spawn, launch: LAUNCH, deadlineMs: 5_000, ...overrides };
}

/** A server that runs `before` on each message it receives, then answers the way an MCP server does. */
function answering(before: RpcAnswer): RpcAnswer {
  const answer = mcpServer(behaviour());
  return (message, child) => {
    before(message, child);
    // The client's own answers to a ping or a request carry no method.
    if (message.method !== undefined) answer(message, child);
  };
}

/** A server that answers tools/list with `result` and every other method the usual way. */
function listing(result: (cursor: unknown) => unknown): RpcAnswer {
  const answer = mcpServer(behaviour());
  return (message, child) => {
    if (message.method === "tools/list") child.send({ id: message.id, result: result(message.params?.cursor) });
    else answer(message, child);
  };
}

function onlyChild(fake: FakeSpawn): FakeChild {
  expect(fake.started).toHaveLength(1);
  const [started] = fake.started;
  if (started === undefined) throw new Error("the spawn started no server");
  return started.child;
}

async function refusalOf(promise: Promise<unknown>): Promise<LocalServerRefusal> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(LocalServerError);
  return (error as LocalServerError).refusal();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("callTool", () => {
  it("runs the handshake, calls the tool by its upstream name, and stops the server", async () => {
    const fake = fakeSpawn(
      mcpServer(behaviour({ call: (params) => ({ content: [{ type: "text", text: JSON.stringify(params) }] }) })),
    );
    const result = await callTool(options(fake.spawn), "read_file", { path: "notes.md" });
    expect(result).toEqual({
      content: [{ type: "text", text: JSON.stringify({ name: "read_file", arguments: { path: "notes.md" } }) }],
    });

    const [started] = fake.started;
    expect(started?.command).toBe("npx");
    expect(started?.args).toEqual(LAUNCH.args);
    expect(started?.args).not.toBe(LAUNCH.args);
    expect(started?.options).toEqual({ env: LAUNCH.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    expect(started?.options.env).not.toBe(LAUNCH.env);

    const child = onlyChild(fake);
    expect(child.received).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "oxagen-local-gateway", version: TACHO_VERSION },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_file", arguments: { path: "notes.md" } } },
    ]);
    expect(child.stdin.ended).toBe(true);
    expect(child.killed).toBe(true);
  });

  it("speaks the MCP revision this client was written against", () => {
    expect(MCP_PROTOCOL_VERSION).toBe("2025-06-18");
    expect(DEFAULT_MAX_LINE_CHARS).toBe(16 * 1024 * 1024);
  });

  it("refuses to start a server once the local gateway has stopped", async () => {
    const controller = new AbortController();
    controller.abort();
    const spawn = vi.fn<StdioSpawn>();
    const refusal = await refusalOf(callTool(options(spawn, { signal: controller.signal }), "read_file", {}));
    expect(refusal).toEqual(serverFailed("files", STOPPED));
    expect(spawn).not.toHaveBeenCalled();
  });

  const unstartable: [string, unknown, string][] = [
    ["an Error", new Error("spawn npx ENOENT"), "spawn npx ENOENT"],
    ["a string", "EACCES", "EACCES"],
  ];
  it.each(unstartable)("names why a server could not start when spawn throws %s", async (_name, thrown, text) => {
    const spawn: StdioSpawn = () => {
      throw thrown;
    };
    expect(await refusalOf(callTool(options(spawn), "read_file", {}))).toEqual(
      serverFailed("files", `it could not start (${text})`),
    );
  });

  it("answers a ping, refuses other requests, and ignores notifications from the server", async () => {
    const fake = fakeSpawn(
      answering((message, child) => {
        if (message.method !== "initialize") return;
        child.send({ method: "notifications/message", params: { level: "info" } });
        child.send({ id: 70, method: "ping" });
        child.send({ id: 71, method: "sampling/createMessage", params: {} });
      }),
    );
    await callTool(options(fake.spawn), "read_file", {});
    expect(onlyChild(fake).received.map((message) => ({ ...message, params: undefined }))).toEqual([
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      { jsonrpc: "2.0", id: 70, result: {} },
      {
        jsonrpc: "2.0",
        id: 71,
        error: { code: -32601, message: "The client does not offer sampling/createMessage." },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call" },
    ]);
  });

  it("reports notifications/tools/list_changed to the caller (#4772)", async () => {
    const fake = fakeSpawn(
      answering((message, child) => {
        if (message.method !== "initialize") return;
        child.send({ method: "notifications/tools/list_changed" });
      }),
    );
    const onToolsChanged = vi.fn();
    expect(await callTool(options(fake.spawn, { onToolsChanged }), "read_file", {})).toEqual(TEXT_RESULT);
    expect(onToolsChanged).toHaveBeenCalledTimes(1);
  });

  it("reports nothing for other notifications", async () => {
    const fake = fakeSpawn(
      answering((message, child) => {
        if (message.method !== "initialize") return;
        child.send({ method: "notifications/message", params: { level: "info" } });
      }),
    );
    const onToolsChanged = vi.fn();
    await callTool(options(fake.spawn, { onToolsChanged }), "read_file", {});
    expect(onToolsChanged).not.toHaveBeenCalled();
  });

  it("skips lines that are not JSON-RPC messages and answers the client did not ask for", async () => {
    const fake = fakeSpawn(
      answering((message, child) => {
        if (message.method !== "initialize") return;
        child.stdout.emit("data", "npm notice starting\n[1]\n   \n");
        child.send({ id: 99, result: { stray: true } });
        child.send({ id: "1", result: { stray: true } });
      }),
    );
    expect(await callTool(options(fake.spawn), "read_file", {})).toEqual(TEXT_RESULT);
  });

  it("reports a JSON-RPC error with its credentials redacted and its message clipped", async () => {
    const message = `Bad path AKIAABCDEFGHIJKLMNOP ${"x".repeat(600)}`;
    const answer = mcpServer(behaviour());
    const fake = fakeSpawn((rpc, child) => {
      if (rpc.method === "tools/call") child.send({ id: rpc.id, error: { code: -32602, message } });
      else answer(rpc, child);
    });
    const text = `Bad path [redacted:aws_access_key] ${"x".repeat(600)}`.slice(0, 512);
    expect(await refusalOf(callTool(options(fake.spawn), "read_file", {}))).toEqual(
      serverFailed("files", `it answered tools/call with error -32602: ${text}`),
    );
  });

  it("refuses a result that is not an MCP CallToolResult", async () => {
    const fake = fakeSpawn(mcpServer(behaviour({ call: () => ({ content: "nope" }) })));
    expect(await refusalOf(callTool(options(fake.spawn), "read_file", {}))).toEqual(
      serverFailed("files", "it answered tools/call with a result that is not an MCP CallToolResult"),
    );
    expect(onlyChild(fake).killed).toBe(true);
  });

  it("fails a server that writes a line longer than the limit", async () => {
    const fake = fakeSpawn((message, child) => {
      if (message.method === "initialize") child.stdout.emit("data", "x".repeat(65));
    });
    expect(await refusalOf(callTool(options(fake.spawn, { maxLineChars: 64 }), "read_file", {}))).toEqual(
      serverFailed("files", "it wrote a line longer than 64 characters"),
    );
  });

  it("quotes the redacted tail of stderr when the server exits before it answers", async () => {
    const fake = fakeSpawn((message, child) => {
      if (message.method !== "initialize") return;
      child.stderr.emit("data", "a".repeat(2_000));
      child.stderr.emit("data", Buffer.from("\nnpm ERR! token AKIAABCDEFGHIJKLMNOP\n"));
      child.emit("close", 1, null);
    });
    const kept = "\nnpm ERR! token AKIAABCDEFGHIJKLMNOP\n";
    const tail = `${"a".repeat(1_024 - kept.length)}\nnpm ERR! token [redacted:aws_access_key]`;
    expect(await refusalOf(callTool(options(fake.spawn), "read_file", {}))).toEqual(
      serverFailed("files", `it exited with code 1 before it answered. Its stderr ends with: ${tail}`),
    );
  });

  it("names the signal that stopped the server", async () => {
    const fake = fakeSpawn((message, child) => {
      if (message.method === "initialize") child.emit("close", null, "SIGTERM");
    });
    expect(await refusalOf(callTool(options(fake.spawn), "read_file", {}))).toEqual(
      serverFailed("files", "it stopped on signal SIGTERM before it answered"),
    );
  });

  it("reports a child that fails to start after spawn returns", async () => {
    const fake = fakeSpawn((message, child) => {
      if (message.method === "initialize") child.emit("error", new Error("spawn npx EACCES"));
    });
    expect(await refusalOf(callTool(options(fake.spawn), "read_file", {}))).toEqual(
      serverFailed("files", "it could not start (spawn npx EACCES)"),
    );
  });

  it("keeps the first failure when stdin closes and the server then exits", async () => {
    const fake = fakeSpawn((message, child) => {
      if (message.method !== "initialize") return;
      child.stdin.emit("error", new Error("write EPIPE"));
      child.emit("close", 1, null);
    });
    expect(await refusalOf(callTool(options(fake.spawn), "read_file", {}))).toEqual(
      serverFailed("files", "its stdin closed (write EPIPE)"),
    );
  });

  it("stops a server that does not answer within the deadline", async () => {
    vi.useFakeTimers();
    const fake = fakeSpawn(() => undefined);
    const refused = refusalOf(callTool(options(fake.spawn, { deadlineMs: 250 }), "read_file", {}));
    await vi.advanceTimersByTimeAsync(250);
    expect(await refused).toEqual(deadlinePassed("files", 250));
    expect(onlyChild(fake).killed).toBe(true);
  });

  it("stops the session when the local gateway stops mid-call", async () => {
    const controller = new AbortController();
    const fake = fakeSpawn((message) => {
      if (message.method === "initialize") controller.abort();
    });
    expect(await refusalOf(callTool(options(fake.spawn, { signal: controller.signal }), "read_file", {}))).toEqual(
      serverFailed("files", STOPPED),
    );
    expect(onlyChild(fake).killed).toBe(true);
  });

  it("finishes a call made with a signal that never aborts", async () => {
    const controller = new AbortController();
    const fake = fakeSpawn(mcpServer(behaviour()));
    expect(await callTool(options(fake.spawn, { signal: controller.signal }), "read_file", {})).toEqual(TEXT_RESULT);
  });

  it("refuses a request made after the server already failed", async () => {
    const fake = fakeSpawn(
      answering((message, child) => {
        if (message.method === "notifications/initialized") child.emit("close", 0, null);
      }),
    );
    expect(await refusalOf(callTool(options(fake.spawn), "read_file", {}))).toEqual(
      serverFailed("files", "it exited with code 0 before it answered"),
    );
    expect(onlyChild(fake).received.map((message) => message.method)).toEqual([
      "initialize",
      "notifications/initialized",
    ]);
  });
});

describe("listTools", () => {
  it("follows each page's cursor and reports the server's version", async () => {
    const pages: Record<string, unknown> = {
      first: { tools: [TOOL], nextCursor: "page-2" },
      "page-2": { tools: [WRITE_TOOL], nextCursor: "" },
    };
    const fake = fakeSpawn(listing((cursor) => pages[typeof cursor === "string" ? cursor : "first"]));
    expect(await listTools(options(fake.spawn))).toEqual({ tools: [TOOL, WRITE_TOOL], serverVersion: "2026.8.1" });
    const lists = onlyChild(fake).received.filter((message) => message.method === "tools/list");
    expect(lists.map((message) => message.params)).toEqual([{}, { cursor: "page-2" }]);
  });

  it("reads a page that arrives in byte chunks split inside a character", async () => {
    const answer = mcpServer(behaviour());
    const fake = fakeSpawn((message, child) => {
      if (message.method !== "initialize") {
        answer(message, child);
        return;
      }
      const line = `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { serverInfo: { version: "1.0.0-β" } } })}\n`;
      const bytes = Buffer.from(line);
      const cut = bytes.indexOf(Buffer.from("β")) + 1;
      child.stdout.emit("data", bytes.subarray(0, cut));
      child.stdout.emit("data", bytes.subarray(cut));
    });
    expect(await listTools(options(fake.spawn))).toEqual({ tools: [TOOL], serverVersion: "1.0.0-β" });
  });

  const invalid: [string, unknown][] = [
    ["a tool without a name", { tools: [{ name: "", inputSchema: {} }] }],
    ["tools that are not a list", { tools: "none" }],
    ["a result that is not an object", null],
  ];
  it.each(invalid)("refuses a tools/list result with %s", async (_name, result) => {
    const fake = fakeSpawn(listing(() => result));
    expect(await refusalOf(listTools(options(fake.spawn)))).toEqual(
      serverFailed("files", "it answered tools/list with a result that is not an MCP tool list"),
    );
  });

  it("gives up on a server whose tools/list never ends", async () => {
    const fake = fakeSpawn(listing(() => ({ tools: [], nextCursor: "again" })));
    expect(await refusalOf(listTools(options(fake.spawn)))).toEqual(
      serverFailed("files", `its tools/list ran past ${MAX_TOOL_PAGES} pages`),
    );
    const lists = onlyChild(fake).received.filter((message) => message.method === "tools/list");
    expect(lists).toHaveLength(MAX_TOOL_PAGES);
  });

  const versions: [string, unknown, string | undefined][] = [
    ["reports a 64-character version", { serverInfo: { version: "v".repeat(64) } }, "v".repeat(64)],
    ["reports a version longer than 64 characters", { serverInfo: { version: "v".repeat(65) } }, undefined],
    ["reports an empty version", { serverInfo: { version: "" } }, undefined],
    ["reports a version that is not a string", { serverInfo: { version: 3 } }, undefined],
    ["reports no serverInfo", { protocolVersion: MCP_PROTOCOL_VERSION }, undefined],
    ["answers initialize with null", null, undefined],
  ];
  it.each(versions)("keeps only a version that fits the reply when a server %s", async (_name, initialized, expected) => {
    const answer = mcpServer(behaviour());
    const fake = fakeSpawn((message, child) => {
      if (message.method === "initialize") child.send({ id: message.id, result: initialized });
      else answer(message, child);
    });
    const listed = await listTools(options(fake.spawn));
    expect(listed.tools).toEqual([TOOL]);
    expect(listed.serverVersion).toBe(expected);
  });
});
