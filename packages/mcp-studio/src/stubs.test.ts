// Every module stub throws NotBuiltError naming its module. When a lane
// builds a module, it deletes that module's row here.
import { describe, expect, it } from "vitest";
import { CompileError } from "./compile";
import { graphqlSender, grpcSender, httpSender, mcpSender } from "./execute";
import { lint, type LintContext, type ServerFolder } from "./lint";
import { NotBuiltError } from "./not-built";

// The stubs never read their arguments, so an empty object stands in for each.
const stub = <T>(): T => ({}) as T;

const syncStubs: Array<[string, () => unknown]> = [
  ["lint", () => lint(stub<ServerFolder>(), stub<LintContext>())],
];

describe("module stubs", () => {
  it.each(syncStubs)("%s throws NotBuiltError", (module, call) => {
    let thrown: unknown;
    try {
      call();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(NotBuiltError);
    expect((thrown as NotBuiltError).module).toBe(module);
  });

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
