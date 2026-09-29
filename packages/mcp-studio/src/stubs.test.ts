// The module stubs are all built, so no row here checks for NotBuiltError.
// What stays checks the shared pieces M0 fixed: each Sender's kind and
// CompileError's message.
import { describe, expect, it } from "vitest";
import { CompileError } from "./compile";
import { graphqlSender, grpcSender, httpSender, mcpSender } from "./execute";

describe("module stubs", () => {
  it("gives each Sender its own kind", () => {
    expect([mcpSender.kind, httpSender.kind, graphqlSender.kind, grpcSender.kind]).toEqual([
      "mcp",
      "http",
      "graphql",
      "grpc",
    ]);
  });
});

describe("CompileError", () => {
  it("joins every issue into its message", () => {
    const error = new CompileError([
      { tool: "create_refund", field: "operation", message: "create_refund: no operation createRefund" },
      { tool: undefined, field: "auth.scheme", message: "auth.scheme mutual_tls runs through a relay" },
    ]);
    expect(error.name).toBe("CompileError");
    expect(error.issues).toHaveLength(2);
    expect(error.message).toBe(
      "create_refund: no operation createRefund\nauth.scheme mutual_tls runs through a relay",
    );
    expect(error).toBeInstanceOf(Error);
  });
});
