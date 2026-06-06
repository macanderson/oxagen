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
