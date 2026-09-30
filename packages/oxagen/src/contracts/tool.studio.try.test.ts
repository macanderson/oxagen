/**
 * Contract test for try_studio_tool (mcp-studio-spec, lane M9).
 */
import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { TRY_ARGUMENTS_MAX, TRY_REQUEST_MAX, TRY_RESULT_MAX, toolStudioTry } from "./tool.studio.try";

describe("try_studio_tool is registered as declared", () => {
  it("is scoped, mutates, keeps the billing gate, and grants the Studio roles", () => {
    const cap = getCapability("try_studio_tool");
    expect(cap).toBeDefined();
    expect(cap?.scoped).toBe(true);
    expect(cap?.mutates).toBe(true);
    // Each call is one governed action, so the billing gate stays on.
    expect(cap?.noBillingGate).toBeUndefined();
    expect(cap?.surfaces).toEqual(["api", "mcp"]);
    expect(cap?.sensitivity).toBe("high");
    expect(cap?.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: { Owner: "allow" },
    });
    expect(cap?.audit).toEqual({ targetKind: "tool_server_folder", targetIdField: "server" });
  });
});

describe("try_studio_tool input", () => {
  const input = {
    server: "billing",
    tool: "list_charges",
    environment: "staging",
    arguments: { customer: "cus_1", limit: 10 },
  };

  it("takes a server, a tool, an environment, arguments, and an optional agent", () => {
    expect(toolStudioTry.input.parse(input)).toEqual(input);
    expect(toolStudioTry.input.parse({ ...input, agent: "billing-bot" })).toEqual({ ...input, agent: "billing-bot" });
    expect(toolStudioTry.input.parse({ ...input, arguments: {} })).toEqual({ ...input, arguments: {} });
  });

  it("refuses a missing field, a bad name, and anything extra", () => {
    for (const bad of [
      { server: "billing", tool: "list_charges", environment: "staging" },
      { ...input, environment: "" },
      { ...input, environment: "e".repeat(65) },
      { ...input, server: "builtin" },
      { ...input, tool: "" },
      { ...input, arguments: [] },
      { ...input, agent: "" },
      { ...input, token: "secret" },
    ]) {
      expect(toolStudioTry.input.safeParse(bad).success).toBe(false);
    }
  });

  it("refuses arguments longer than the limit as JSON", () => {
    const fits = { note: "x".repeat(TRY_ARGUMENTS_MAX - 20) };
    expect(toolStudioTry.input.safeParse({ ...input, arguments: fits }).success).toBe(true);
    const tooLong = { note: "x".repeat(TRY_ARGUMENTS_MAX) };
    expect(toolStudioTry.input.safeParse({ ...input, arguments: tooLong }).success).toBe(false);
  });
});

describe("try_studio_tool output", () => {
  const ok = {
    ok: true as const,
    server: "billing",
    tool: "list_charges",
    environment: "staging",
    agent: "billing-bot",
    request: '{"method":"GET","path":"/charges"}',
    raw: '{"status":200,"body":[]}',
    shaped: "[]",
    exchanges: 1,
    cut: [],
  };

  it("carries a success with the request, the raw answer, and the shaped result", () => {
    expect(toolStudioTry.output.parse(ok)).toEqual(ok);
    expect(toolStudioTry.output.parse({ ...ok, cut: ["raw", "shaped"] })).toEqual({ ...ok, cut: ["raw", "shaped"] });
  });

  it("holds each part to its limit", () => {
    expect(toolStudioTry.output.safeParse({ ...ok, request: "x".repeat(TRY_REQUEST_MAX) }).success).toBe(true);
    expect(toolStudioTry.output.safeParse({ ...ok, request: "x".repeat(TRY_REQUEST_MAX + 1) }).success).toBe(false);
    expect(toolStudioTry.output.safeParse({ ...ok, raw: "x".repeat(TRY_RESULT_MAX + 1) }).success).toBe(false);
    expect(toolStudioTry.output.safeParse({ ...ok, shaped: "x".repeat(TRY_RESULT_MAX + 1) }).success).toBe(false);
    expect(toolStudioTry.output.safeParse({ ...ok, cut: ["message"] }).success).toBe(false);
  });

  it("carries a denial or a failure with a message", () => {
    const denied = { ok: false as const, reason: "denied" as const, message: "No policy lets billing-bot call it." };
    expect(toolStudioTry.output.parse(denied)).toEqual(denied);
    const failed = {
      ok: false as const,
      reason: "failed" as const,
      message: "The upstream answered 500.",
      request: '{"method":"GET","path":"/charges"}',
      raw: '{"status":500}',
    };
    expect(toolStudioTry.output.parse(failed)).toEqual(failed);
    for (const bad of [
      { ...denied, message: "" },
      { ...denied, reason: "parked" },
      { ok: false, message: "No reason." },
    ]) {
      expect(toolStudioTry.output.safeParse(bad).success).toBe(false);
    }
  });
});
