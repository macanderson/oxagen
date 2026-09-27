// Every module stub throws NotBuiltError naming its module. When a lane
// builds a module, it deletes that module's row here.
import { describe, expect, it } from "vitest";
import { CompileError } from "./compile";
import {
  execute,
  graphqlSender,
  grpcSender,
  httpSender,
  mcpSender,
  type CallEnvironment,
  type CredentialSource,
  type SendContext,
  type Transport,
} from "./execute";
import { importGraphql } from "./graphql";
import { importGrpc } from "./grpc";
import { lint, type LintContext, type ServerFolder } from "./lint";
import { NotBuiltError } from "./not-built";
import { importOpenApi } from "./openapi";
import type { ManifestTool } from "./contract/manifest";

// The stubs never read their arguments, so an empty object stands in for each.
const stub = <T>(): T => ({}) as T;

const syncStubs: Array<[string, () => unknown]> = [
  ["lint", () => lint(stub<ServerFolder>(), stub<LintContext>())],
];

const asyncStubs: Array<[string, () => Promise<unknown>]> = [
  ["openapi", () => importOpenApi(stub())],
  ["graphql", () => importGraphql(stub())],
  ["grpc", () => importGrpc(stub())],
  [
    "execute",
    () =>
      execute(stub<ManifestTool>(), {}, stub<CallEnvironment>(), stub<CredentialSource>(), stub<Transport>()),
  ],
  ["execute/mcp", () => mcpSender.send(stub(), {}, stub<SendContext>())],
  ["execute/graphql", () => graphqlSender.send(stub(), {}, stub<SendContext>())],
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

  it.each(asyncStubs)("%s rejects with NotBuiltError", async (module, call) => {
    const error = await call().then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(NotBuiltError);
    expect((error as NotBuiltError).module).toBe(module);
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
