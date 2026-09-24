// billing.statement.test.ts — the get_billing_statement and
// export_billing_statement MCP tools: their metadata, their schema, and that
// each dispatches its capability through invoke() on the mcp surface and
// re-validates the output against the contract.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  buildContext: vi.fn(),
  headers: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../context", () => ({ buildContext: mocks.buildContext }));
vi.mock("xmcp/headers", () => ({ headers: mocks.headers }));

import exportTool, {
  metadata as exportMetadata,
  schema as exportSchema,
} from "./billing.statement.export";
import getTool, {
  metadata as getMetadata,
  schema as getSchema,
} from "./billing.statement.get";

const fakeCtx = {
  orgId: "org_test",
  workspaceId: "ws_test",
  userId: null,
  apiKeyId: "key_test",
  requestId: "req_test",
  surface: "mcp" as const,
  messageId: null,
  clientIp: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.buildContext.mockResolvedValue(fakeCtx);
  mocks.headers.mockReturnValue({ authorization: "Bearer test_key" });
});

describe("billing statement MCP tools", () => {
  it("name their capabilities and declare a read", () => {
    expect(getMetadata.name).toBe("get_billing_statement");
    expect(exportMetadata.name).toBe("export_billing_statement");
    for (const m of [getMetadata, exportMetadata])
      expect(m.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      });
  });

  it("carry the contract's period fields, described", () => {
    const get = z.object(getSchema);
    expect(
      get.safeParse({ period: "month", anchor: "2026-09-01" }).success,
    ).toBe(true);
    expect(get.safeParse({ period: "fortnight" }).success).toBe(false);
    expect(getSchema.period.description).toMatch(/custom/);
    const exp = z.object(exportSchema);
    expect(exp.parse({ period: "year", anchor: "2026-01-01" })).toMatchObject({
      format: "csv",
      limit: 10_000,
    });
  });

  it("export dispatches on the mcp surface and re-validates the output", async () => {
    const out = {
      reference: "ST-1-20260901-20260930",
      format: "html",
      filename: "ST-1-20260901-20260930.html",
      mediaType: "text/html",
      content: "<!doctype html>",
      lines: 0,
      nextCursor: null,
    };
    mocks.invoke.mockResolvedValue(out);
    const args = {
      period: "month" as const,
      anchor: "2026-09-01",
      from: undefined,
      to: undefined,
      format: "html" as const,
      limit: 10,
      cursor: undefined,
    };
    await expect(exportTool(args)).resolves.toEqual(out);
    expect(mocks.buildContext).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith(
      "export_billing_statement",
      args,
      fakeCtx,
      {
        surface: "mcp",
      },
    );

    mocks.invoke.mockResolvedValue({ ...out, mediaType: "application/pdf" });
    await expect(exportTool(args)).rejects.toThrow();
  });

  it("get dispatches on the mcp surface and refuses output that drifted from the contract", async () => {
    mocks.invoke.mockResolvedValue({ version: 2 });
    const args = {
      period: "week" as const,
      anchor: "2026-09-14",
      from: undefined,
      to: undefined,
      top: 5,
    };
    await expect(getTool(args)).rejects.toThrow();
    expect(mocks.invoke).toHaveBeenCalledWith(
      "get_billing_statement",
      args,
      fakeCtx,
      { surface: "mcp" },
    );
  });
});
