// The kernel tells the role checks which capability a call is for (#5228).
//
// A workspace's Owner and Admin pass every role check for a capability that
// acts inside their workspace. Two seams need to know which capability that
// is: the IAM check, which reads `actsInWorkspace`, and the handler's own gate
// (`assertOrgRole`), which reads `invokedCapability` off the checked context.
// The kernel sets both from the contract, and a caller cannot set either.
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { CapabilityContext } from "./types";
import { clearRegistryForTests, registerCapability } from "./registry";
import {
  clearHandlersForTests,
  clearKernelIAMRuntime,
  invoke,
  registerHandler,
  setKernelIAMRuntime,
  type KernelIAMCheckFn,
} from "./kernel";

const ctx: CapabilityContext = {
  orgId: "00000000-0000-0000-0000-000000000001",
  workspaceId: "00000000-0000-0000-0000-000000000002",
  userId: "00000000-0000-0000-0000-000000000003",
  apiKeyId: null,
  requestId: "r",
  surface: "app",
  messageId: null,
};

function capability(name: string, extra: { orgLevel?: boolean } = {}) {
  registerCapability({
    name,
    domain: "test",
    description: name,
    mode: "sync" as const,
    surfaces: ["api", "mcp"] as const,
    layers: ["unit"] as const,
    sensitivity: "low" as const,
    defaultEffect: "allow" as const,
    defaultRoles: { org: {}, workspace: {} },
    ...extra,
    input: z.object({}),
    output: z.object({ seen: z.string().nullable() }),
  });
}

afterEach(() => {
  clearRegistryForTests();
  clearHandlersForTests();
  clearKernelIAMRuntime();
});

function allowAll() {
  const check = vi.fn<KernelIAMCheckFn>(async () => ({
    outcome: "allow",
    principal: null,
  }));
  setKernelIAMRuntime(check, true);
  return check;
}

describe("the kernel names the capability to the role checks", () => {
  it("tells the IAM check a workspace capability acts inside the workspace", async () => {
    capability("test.workspace_thing");
    registerHandler("test.workspace_thing", async () => async () => ({
      seen: null,
    }));
    const check = allowAll();

    await invoke("test.workspace_thing", {}, ctx);

    expect(check).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "test.workspace_thing",
        actsInWorkspace: true,
      }),
    );
  });

  it("tells the IAM check an org-level capability does not (negative)", async () => {
    capability("test.org_thing", { orgLevel: true });
    registerHandler("test.org_thing", async () => async () => ({ seen: null }));
    const check = allowAll();

    await invoke("test.org_thing", {}, ctx);

    expect(check).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "test.org_thing",
        actsInWorkspace: false,
      }),
    );
  });

  it("stamps the checked context with the invoked capability, over a value the caller passed", async () => {
    capability("test.stamped");
    let seen: string | undefined;
    registerHandler("test.stamped", async () => async (_input, checked) => {
      seen = checked.invokedCapability;
      return { seen: seen ?? null };
    });
    allowAll();

    // A caller that hands in a checked context from another call, as a
    // handler does for a nested invoke, does not choose the name.
    const forged = {
      ...ctx,
      invokedCapability: "test.something_else",
    } as CapabilityContext;
    await invoke("test.stamped", {}, forged);

    expect(seen).toBe("test.stamped");
  });

  it("gives a nested invoke its own name, not its caller's", async () => {
    capability("test.outer");
    capability("test.inner", { orgLevel: true });
    const names: (string | undefined)[] = [];
    registerHandler("test.inner", async () => async (_input, checked) => {
      names.push(checked.invokedCapability);
      return { seen: null };
    });
    registerHandler("test.outer", async () => async (_input, checked) => {
      names.push(checked.invokedCapability);
      await invoke("test.inner", {}, checked);
      return { seen: null };
    });
    allowAll();

    await invoke("test.outer", {}, ctx);

    expect(names).toEqual(["test.outer", "test.inner"]);
  });
});
