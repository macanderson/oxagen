import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { CapabilityContext } from "./types";
import { clearRegistryForTests, registerCapability } from "./registry";
import {
  CapabilityError,
  assertHandlersComplete,
  authorizeExternalCapability,
  capabilitiesForSurface,
  clearHandlersForTests,
  clearKernelIAMRuntime,
  clearSecurityEventEmitter,
  hasHandler,
  invoke,
  registerHandler,
  setKernelIAMRuntime,
  setSecurityEventEmitter,
  type KernelIAMCheckFn,
  type KernelSecurityEvent,
} from "./kernel";

const ctx: CapabilityContext = {
  orgId: "00000000-0000-0000-0000-000000000001",
  workspaceId: "00000000-0000-0000-0000-000000000002",
  userId: "u",
  apiKeyId: null,
  requestId: "r",
  surface: "api",
  messageId: null,
};

const echoCap = () =>
  registerCapability({
    name: "test.echo",
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

describe("capability kernel", () => {
  afterEach(() => {
    clearRegistryForTests();
    clearHandlersForTests();
    clearSecurityEventEmitter();
  });

  it("validates input, runs the handler, and validates output", async () => {
    echoCap();
    registerHandler("test.echo", async () => async (input) => input);
    const out = await invoke("test.echo", { value: "hi" }, ctx);
    expect(out).toEqual({ value: "hi" });
  });

  it("rejects unknown capabilities", async () => {
    await expect(invoke("test.missing", {}, ctx)).rejects.toMatchObject({
      code: "unknown_capability",
    });
  });

  it("rejects a capability with no registered handler", async () => {
    echoCap();
    await expect(invoke("test.echo", { value: "x" }, ctx)).rejects.toMatchObject({
      code: "no_handler",
    });
  });

  it("rejects input that fails the contract schema", async () => {
    echoCap();
    registerHandler("test.echo", async () => async (input) => input);
    await expect(invoke("test.echo", { value: 42 }, ctx)).rejects.toBeInstanceOf(
      CapabilityError,
    );
    await expect(invoke("test.echo", { value: 42 }, ctx)).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("rejects handler output that violates the contract schema", async () => {
    echoCap();
    registerHandler("test.echo", async () => async () => ({ wrong: true }));
    await expect(invoke("test.echo", { value: "x" }, ctx)).rejects.toMatchObject({
      code: "invalid_output",
    });
  });

  it("enforces the contract surface allowlist", async () => {
    echoCap();
    registerHandler("test.echo", async () => async (input) => input);
    await expect(
      invoke("test.echo", { value: "x" }, ctx, { surface: "agent" }),
    ).rejects.toMatchObject({ code: "surface_denied" });
  });

  it("throws on duplicate handler registration", () => {
    registerHandler("test.dup", async () => async (i) => i);
    expect(() => registerHandler("test.dup", async () => async (i) => i)).toThrow(
      /already registered/,
    );
  });

  it("assertHandlersComplete flags a capability with no handler", () => {
    echoCap();
    expect(() => assertHandlersComplete()).toThrow(/test\.echo/);
    registerHandler("test.echo", async () => async (i) => i);
    expect(() => assertHandlersComplete()).not.toThrow();
  });

  it("capabilitiesForSurface filters by the contract surface list", () => {
    echoCap();
    expect(capabilitiesForSurface("mcp").map((c) => c.name)).toContain("test.echo");
    expect(capabilitiesForSurface("agent").map((c) => c.name)).not.toContain("test.echo");
  });

  it("tracks handler registration", () => {
    expect(hasHandler("test.echo")).toBe(false);
    registerHandler("test.echo", async () => async (i) => i);
    expect(hasHandler("test.echo")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Security event emitter — kernel integration
// ---------------------------------------------------------------------------

describe("kernel security event emitter", () => {
  afterEach(() => {
    clearRegistryForTests();
    clearHandlersForTests();
    clearSecurityEventEmitter();
  });

  it("emits an 'allow' event on successful invocation", async () => {
    const emitter = vi.fn();
    setSecurityEventEmitter(emitter);
    echoCap();
    registerHandler("test.echo", async () => async (input) => input);

    await invoke("test.echo", { value: "hi" }, ctx);

    expect(emitter).toHaveBeenCalledOnce();
    expect(emitter).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "test.echo",
        outcome: "allow",
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        actorUserId: ctx.userId,
        requestId: ctx.requestId,
        errorCode: null,
      }),
    );
  });

  it("emits a 'deny' event when the capability is unknown", async () => {
    const emitter = vi.fn();
    setSecurityEventEmitter(emitter);

    await expect(invoke("test.missing", {}, ctx)).rejects.toMatchObject({
      code: "unknown_capability",
    });

    expect(emitter).toHaveBeenCalledOnce();
    expect(emitter).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "test.missing",
        outcome: "deny",
        errorCode: "unknown_capability",
      }),
    );
  });

  it("emits a 'deny' event when the surface is not allowed", async () => {
    const emitter = vi.fn();
    setSecurityEventEmitter(emitter);
    echoCap();
    registerHandler("test.echo", async () => async (input) => input);

    await expect(
      invoke("test.echo", { value: "x" }, ctx, { surface: "agent" }),
    ).rejects.toMatchObject({ code: "surface_denied" });

    expect(emitter).toHaveBeenCalledOnce();
    expect(emitter).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "test.echo",
        outcome: "deny",
        errorCode: "surface_denied",
      }),
    );
  });

  it("emits an 'error' event when input validation fails", async () => {
    const emitter = vi.fn();
    setSecurityEventEmitter(emitter);
    echoCap();
    registerHandler("test.echo", async () => async (input) => input);

    await expect(invoke("test.echo", { value: 42 }, ctx)).rejects.toMatchObject({
      code: "invalid_input",
    });

    expect(emitter).toHaveBeenCalledOnce();
    expect(emitter).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "error",
        errorCode: "invalid_input",
      }),
    );
  });

  it("emits a 'deny' event when no handler is registered", async () => {
    const emitter = vi.fn();
    setSecurityEventEmitter(emitter);
    echoCap();

    await expect(invoke("test.echo", { value: "x" }, ctx)).rejects.toMatchObject({
      code: "no_handler",
    });

    expect(emitter).toHaveBeenCalledOnce();
    expect(emitter).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "deny",
        errorCode: "no_handler",
      }),
    );
  });

  it("does not call the emitter when no emitter is registered", async () => {
    // No setSecurityEventEmitter call — should not throw.
    echoCap();
    registerHandler("test.echo", async () => async (input) => input);
    await expect(invoke("test.echo", { value: "hi" }, ctx)).resolves.toEqual({ value: "hi" });
  });

  it("does not crash when the emitter throws synchronously", async () => {
    setSecurityEventEmitter(() => {
      throw new Error("emitter exploded");
    });
    echoCap();
    registerHandler("test.echo", async () => async (input) => input);

    // The capability should still succeed even though the emitter threw.
    await expect(invoke("test.echo", { value: "hi" }, ctx)).resolves.toEqual({ value: "hi" });
  });
});

// ── authorizeExternalCapability ───────────────────────────────────────────────
// The non-contract authz seam used for MCP-passthrough / external tools. It
// resolves authz via the registered IAM runtime, emits a security event, and
// honours the enforcement flag (fail-open when off, fail-closed when on).
describe("authorizeExternalCapability", () => {
  const extCtx: CapabilityContext = { ...ctx, surface: "mcp" };

  afterEach(() => {
    clearKernelIAMRuntime();
    clearSecurityEventEmitter();
  });

  const allowFn: KernelIAMCheckFn = async () => ({ outcome: "allow", principal: null });
  const denyFn: KernelIAMCheckFn = async () => ({
    outcome: "deny",
    reason: "policy_block",
    principal: null,
  });
  const throwFn: KernelIAMCheckFn = async () => {
    throw new Error("resolver exploded");
  };

  it("allows unconditionally when no IAM runtime is registered (and emits nothing)", async () => {
    const events: KernelSecurityEvent[] = [];
    setSecurityEventEmitter((e) => events.push(e));

    const res = await authorizeExternalCapability("mcp.github.list", extCtx, "deny");

    expect(res).toEqual({ allowed: true, outcome: "allow", reason: null });
    expect(events).toHaveLength(0);
  });

  it("allows and emits an allow event when the resolver returns allow", async () => {
    const events: KernelSecurityEvent[] = [];
    setSecurityEventEmitter((e) => events.push(e));
    setKernelIAMRuntime(allowFn, true);

    const res = await authorizeExternalCapability("mcp.github.list", extCtx, "deny");

    expect(res).toEqual({ allowed: true, outcome: "allow", reason: null });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: "allow", errorCode: null, capability: "mcp.github.list" });
  });

  it("blocks (fail-closed) and emits a deny event when the resolver denies AND enforcement is on", async () => {
    const events: KernelSecurityEvent[] = [];
    setSecurityEventEmitter((e) => events.push(e));
    setKernelIAMRuntime(denyFn, true);

    const res = await authorizeExternalCapability("mcp.github.delete", extCtx, "deny");

    expect(res).toEqual({ allowed: false, outcome: "deny", reason: "policy_block" });
    expect(events[0]).toMatchObject({ outcome: "deny", errorCode: "authz_denied" });
  });

  it("allows (fail-open) but still emits a deny event when the resolver denies AND enforcement is off", async () => {
    const events: KernelSecurityEvent[] = [];
    setSecurityEventEmitter((e) => events.push(e));
    setKernelIAMRuntime(denyFn, false);

    const res = await authorizeExternalCapability("mcp.github.delete", extCtx, "deny");

    // Would-deny is logged-and-allowed when the enforcement flag is off.
    expect(res.allowed).toBe(true);
    expect(res.outcome).toBe("deny");
    expect(events[0]).toMatchObject({ outcome: "deny" });
  });

  it("fails closed (deny + emit) when the resolver throws AND enforcement is on", async () => {
    const events: KernelSecurityEvent[] = [];
    setSecurityEventEmitter((e) => events.push(e));
    setKernelIAMRuntime(throwFn, true);

    const res = await authorizeExternalCapability("mcp.github.delete", extCtx, "deny");

    expect(res).toEqual({ allowed: false, outcome: "deny", reason: "iam_check_error" });
    expect(events[0]).toMatchObject({ outcome: "deny", errorCode: "authz_denied" });
  });

  it("fails closed (deny + emit) when the resolver throws AND enforcement is off (OXA-2056)", async () => {
    // Regression: a checkFn throw is an evaluation failure, not a policy
    // decision. It must ALWAYS deny, even when IAM_ENFORCEMENT_ENABLED=false —
    // the enforcement flag is only allowed to soften an actual "deny" outcome,
    // never an unevaluated (throw) result. The prior implementation fell
    // through to an unconditional allow here, silently disabling
    // authorization for every external-tool call while the resolver errored.
    const events: KernelSecurityEvent[] = [];
    setSecurityEventEmitter((e) => events.push(e));
    setKernelIAMRuntime(throwFn, false);

    const res = await authorizeExternalCapability("mcp.github.delete", extCtx, "deny");

    expect(res).toEqual({ allowed: false, outcome: "deny", reason: "iam_check_error" });
    expect(events[0]).toMatchObject({ outcome: "deny", errorCode: "authz_denied" });
  });
});

// ── invoke() — checkFn throw fails closed regardless of enforcement (OXA-2056) ──
// The kernel's main dispatch path (invoke()) runs its own copy of the same
// "checkFn threw" handling as authorizeExternalCapability. Both must fail
// closed on a throw unconditionally — this exercises the invoke() copy.
describe("invoke() IAM check throw — fail closed regardless of enforcement", () => {
  afterEach(() => {
    clearRegistryForTests();
    clearHandlersForTests();
    clearKernelIAMRuntime();
    clearSecurityEventEmitter();
  });

  const throwFn: KernelIAMCheckFn = async () => {
    throw new Error("resolver exploded");
  };

  it("denies (CapabilityError authz_denied) when checkFn throws AND enforcement is ON", async () => {
    setKernelIAMRuntime(throwFn, true);
    echoCap();
    registerHandler("test.echo", async () => async (input) => input);

    await expect(invoke("test.echo", { value: "hi" }, ctx)).rejects.toMatchObject({
      code: "authz_denied",
    });
  });

  it("denies (CapabilityError authz_denied) when checkFn throws AND enforcement is OFF (OXA-2056)", async () => {
    // Regression: previously `iamCheckThrew && _iamEnforced` gated the deny,
    // so a checkFn throw with enforcement OFF silently fell through and ran
    // the handler — granting access despite IAM being unable to evaluate the
    // request at all (e.g. IAM tables missing, DB down, resolver bug). A
    // throw must deny unconditionally, independent of the enforcement flag.
    const events: KernelSecurityEvent[] = [];
    setSecurityEventEmitter((e) => events.push(e));
    setKernelIAMRuntime(throwFn, false);
    echoCap();
    registerHandler("test.echo", async () => async (input) => input);

    await expect(invoke("test.echo", { value: "hi" }, ctx)).rejects.toMatchObject({
      code: "authz_denied",
    });
    expect(events.some((e) => e.outcome === "deny" && e.errorCode === "authz_denied")).toBe(
      true,
    );
  });
});
