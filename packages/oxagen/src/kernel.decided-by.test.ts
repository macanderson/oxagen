// The kernel names the IAM rule that refused a call (#3841). The IAM gate's
// deny and pending-approval throws carry `decidedBy`, the resolver's rule id,
// so a page can print "Decided by 7:role_grant". The fail-closed throws carry
// none, because no rule decided them: the check errored, or an agent run's
// decision could not be recorded.
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { CapabilityContext } from "./types";
import { clearRegistryForTests, registerCapability } from "./registry";
import {
  CapabilityError,
  clearHandlersForTests,
  clearKernelAccessRequestCreator,
  clearKernelIAMRuntime,
  invoke,
  type KernelIAMCheckFn,
  registerHandler,
  setKernelAccessRequestCreator,
  setKernelIAMRuntime,
} from "./kernel";

const ctx: CapabilityContext = {
  orgId: "00000000-0000-0000-0000-000000000001",
  workspaceId: "00000000-0000-0000-0000-000000000002",
  userId: "u",
  apiKeyId: null,
  requestId: "r",
  surface: "app",
  messageId: null,
};

function echo() {
  registerCapability({
    name: "test.decided_by",
    domain: "test",
    description: "echo",
    mode: "sync" as const,
    surfaces: ["api", "mcp"] as const,
    layers: ["unit"] as const,
    sensitivity: "low" as const,
    defaultEffect: "deny" as const,
    defaultRoles: { org: {}, workspace: {} },
    input: z.object({ value: z.string() }),
    output: z.object({ value: z.string() }),
  });
  const handler = vi.fn(async (input: unknown) => input);
  registerHandler("test.decided_by", async () => handler);
  return handler;
}

async function refusal(): Promise<CapabilityError> {
  try {
    await invoke("test.decided_by", { value: "x" }, ctx);
  } catch (err) {
    expect(err).toBeInstanceOf(CapabilityError);
    return err as CapabilityError;
  }
  throw new Error("the call was not refused");
}

afterEach(() => {
  clearRegistryForTests();
  clearHandlersForTests();
  clearKernelIAMRuntime();
  clearKernelAccessRequestCreator();
});

describe("the IAM gate names the rule that decided", () => {
  it("carries the rule on a hard deny", async () => {
    const handler = echo();
    const deny: KernelIAMCheckFn = async () => ({
      outcome: "deny",
      reason: "no_grant",
      principal: null,
      decidedBy: "8:default",
    });
    setKernelIAMRuntime(deny, true);

    const err = await refusal();
    expect(err.code).toBe("authz_denied");
    expect(err.decidedBy).toBe("8:default");
    expect(handler).not.toHaveBeenCalled();
  });

  it("carries the rule on a pending approval, beside the access request", async () => {
    echo();
    const pending: KernelIAMCheckFn = async () => ({
      outcome: "pending_approval",
      principal: null,
      decidedBy: "5:workspace_require_approval",
    });
    setKernelIAMRuntime(pending, true);
    setKernelAccessRequestCreator(async () => "arq_1");

    const err = await refusal();
    expect(err.code).toBe("pending_approval");
    expect(err.accessRequestId).toBe("arq_1");
    expect(err.decidedBy).toBe("5:workspace_require_approval");
  });

  it("carries a machine-key denial's rule", async () => {
    echo();
    setKernelIAMRuntime(
      async () => ({
        outcome: "deny",
        reason: "Forbidden: outside the mandate",
        principal: null,
        decidedBy: "machine_key_scope",
      }),
      true,
    );
    expect((await refusal()).decidedBy).toBe("machine_key_scope");
  });

  it("carries no rule when the runtime reports none", async () => {
    echo();
    setKernelIAMRuntime(
      async () => ({ outcome: "deny", principal: null, decidedBy: null }),
      true,
    );
    expect((await refusal()).decidedBy).toBeUndefined();
  });

  it("carries no rule when the check itself failed, since no rule decided", async () => {
    echo();
    setKernelIAMRuntime(async () => {
      throw new Error("resolver down");
    }, true);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const err = await refusal();
    expect(err.code).toBe("authz_denied");
    expect(err.decidedBy).toBeUndefined();
  });
});
