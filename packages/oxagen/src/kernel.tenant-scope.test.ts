import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { getScope } from "@oxagen/tenancy";
import {
  invoke,
  registerHandler,
  clearHandlersForTests,
  clearSecurityEventEmitter,
} from "./kernel";
import { registerCapability, clearRegistryForTests } from "./registry";
import type { CapabilityContext } from "./types";

const ORG = "00000000-0000-0000-0000-00000000a111";
const WS = "00000000-0000-0000-0000-00000000b222";

function ctx(over: Partial<CapabilityContext> = {}): CapabilityContext {
  return {
    orgId: ORG,
    workspaceId: WS,
    userId: "u1",
    apiKeyId: null,
    requestId: "r1",
    surface: "api",
    messageId: null,
    ...over,
  };
}

afterEach(() => {
  clearHandlersForTests();
  clearRegistryForTests();
  clearSecurityEventEmitter();
});

describe("kernel tenant scope", () => {
  it("runs the handler inside the request's tenant scope", async () => {
    registerCapability({
      name: "test.echo",
      domain: "test",
      description: "echo",
      mode: "sync",
      surfaces: ["api"],
      layers: ["unit"],
      sensitivity: "low",
      defaultEffect: "deny",
      defaultRoles: { org: {}, workspace: {} },
      input: z.object({}),
      output: z.object({ org: z.string() }),
    });
    registerHandler("test.echo", async () => async () => {
      const s = getScope();
      return { org: s?.orgId ?? "NONE" };
    });
    const out = await invoke("test.echo", {}, ctx());
    expect(out).toEqual({ org: ORG });
  });

  it("skips the tenant-scope wrapper for unscoped capabilities (scoped:false)", async () => {
    // Regression: user.preferences.write is scoped:false (keyed on the user, not
    // an org) and is invoked with empty org/workspace ids. The kernel must NOT
    // wrap it in runInTenantScope — doing so threw TenantScopeError on the empty
    // ids and silently broke "Save preferences". The handler must run, and see
    // no active tenant scope.
    registerCapability({
      name: "test.unscoped",
      domain: "test",
      description: "unscoped",
      mode: "sync",
      surfaces: ["api"],
      layers: ["unit"],
      sensitivity: "low",
      defaultEffect: "allow",
      defaultRoles: { org: {}, workspace: {} },
      scoped: false,
      input: z.object({}),
      output: z.object({ scope: z.string() }),
    });
    registerHandler("test.unscoped", async () => async () => {
      const s = getScope();
      return { scope: s ? "SCOPED" : "NONE" };
    });
    const out = await invoke(
      "test.unscoped",
      {},
      ctx({ orgId: "", workspaceId: "" }),
    );
    expect(out).toEqual({ scope: "NONE" });
  });

  it("enters a tenant scope for unscoped capabilities that carry real tenant ids", async () => {
    // plugin.schema.get is scoped:false but is invoked from the API with a
    // concrete org+workspace. Its IAM check (checkIAM → fetchAuthz →
    // withTenantDb) and parts of its handler read through withTenantDb,
    // which require an active tenant scope. An unscoped capability with
    // valid tenant ids must run inside the request's scope, or fetchAuthz
    // throws TenantScopeError and the kernel fails closed.
    registerCapability({
      name: "test.unscoped.scoped",
      domain: "test",
      description: "unscoped but tenant-bound",
      mode: "sync",
      surfaces: ["api"],
      layers: ["unit"],
      sensitivity: "low",
      defaultEffect: "allow",
      defaultRoles: { org: {}, workspace: {} },
      scoped: false,
      input: z.object({}),
      output: z.object({ org: z.string() }),
    });
    registerHandler("test.unscoped.scoped", async () => async () => {
      const s = getScope();
      return { org: s?.orgId ?? "NONE" };
    });
    const out = await invoke("test.unscoped.scoped", {}, ctx());
    expect(out).toEqual({ org: ORG });
  });

  it("fails closed when orgId is empty (MCP session-token path)", async () => {
    registerCapability({
      name: "test.echo2",
      domain: "test",
      description: "echo2",
      mode: "sync",
      surfaces: ["api"],
      layers: ["unit"],
      sensitivity: "low",
      defaultEffect: "deny",
      defaultRoles: { org: {}, workspace: {} },
      input: z.object({}),
      output: z.object({}),
    });
    registerHandler("test.echo2", async () => async () => ({}));
    await expect(invoke("test.echo2", {}, ctx({ orgId: "" }))).rejects.toThrow(
      /tenant scope|orgId/,
    );
  });
});
