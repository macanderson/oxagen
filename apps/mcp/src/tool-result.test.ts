// tool-result.test.ts — toolResult() and one real tool answering through it
// (#5463). xmcp refuses a plain object from a tool with no outputSchema, so
// every tool's answer must carry `content`, and `structuredContent` when the
// output is an object.
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  buildContext: vi.fn(),
  headers: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("./context", () => ({ buildContext: mocks.buildContext }));
vi.mock("xmcp/headers", () => ({ headers: mocks.headers }));

import { toolResult } from "./tool-result";
import listRecentRunsTool from "./tools/run.recent.list";

describe("toolResult", () => {
  it("answers an object as JSON text and as structuredContent", () => {
    const output = { runs: [{ id: "arun_1" }], nextCursor: null };
    expect(toolResult(output)).toEqual({
      content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      structuredContent: output,
    });
  });

  it("answers an array as JSON text alone, since structuredContent must be an object", () => {
    const output = [{ id: "arun_1" }, { id: "arun_2" }];
    const result = toolResult(output);
    expect(result).toEqual({
      content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
    });
    expect(result).not.toHaveProperty("structuredContent");
  });

  it("answers a string as JSON text alone", () => {
    const result = toolResult("done");
    expect(result).toEqual({ content: [{ type: "text", text: '"done"' }] });
    expect(result).not.toHaveProperty("structuredContent");
  });

  it("answers null as the text null alone", () => {
    const result = toolResult(null);
    expect(result).toEqual({ content: [{ type: "text", text: "null" }] });
    expect(result).not.toHaveProperty("structuredContent");
  });

  it("answers undefined as the text null, so the text item is always a string", () => {
    const result = toolResult(undefined);
    expect(result).toEqual({ content: [{ type: "text", text: "null" }] });
    expect(result).not.toHaveProperty("structuredContent");
  });
});

describe("list_recent_runs answers with a CallToolResult", () => {
  const fakeCtx = {
    orgId: "org_test",
    workspaceId: "ws_test",
    userId: null,
    apiKeyId: "key_test",
    requestId: "req_test",
    surface: "mcp",
    messageId: null,
    clientIp: null,
  };
  const output = {
    runs: [
      {
        id: "arun_5f0c2e9a1b7d4c3e8f6a02",
        agentKey: "acme.core.release-bot",
        status: "sealed",
        startedAt: "2026-10-03T10:06:03.000Z",
      },
    ],
  };

  beforeEach(() => {
    mocks.buildContext.mockResolvedValue(fakeCtx);
    mocks.headers.mockReturnValue({ authorization: "Bearer test" });
    mocks.invoke.mockResolvedValue(output);
  });

  it("returns the runs as JSON text in content and as structuredContent", async () => {
    const result = await listRecentRunsTool({ limit: 8 });

    expect(mocks.invoke).toHaveBeenCalledWith(
      "list_recent_runs",
      { limit: 8 },
      fakeCtx,
      { surface: "mcp" },
    );
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(output, null, 2) },
    ]);
    expect(result.structuredContent).toEqual(output);
  });

  it("refuses an output the contract refuses (negative)", async () => {
    mocks.invoke.mockResolvedValue({ runs: [{ id: "not-a-run-id" }] });
    await expect(listRecentRunsTool({ limit: 8 })).rejects.toThrow();
  });
});
