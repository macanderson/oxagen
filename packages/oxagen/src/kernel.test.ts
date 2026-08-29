import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { CapabilityContext } from "./types";
import type { AuthorizationDecisionRef } from "./iam/agent-run";
import { clearRegistryForTests, registerCapability } from "./registry";
import {
  CapabilityError,
  assertHandlersComplete,
  authorizeExternalCapability,
  capabilitiesForSurface,
  clearBillingAdmissionGate,
  clearHandlersForTests,
  clearKernelAccessRequestCreator,
  clearKernelIAMRuntime,
  clearSecurityEventEmitter,
  createDeployedAgentInvocationContext,
  hasHandler,
  isKernelIssuedDeployedAgentInvocation,
  invoke,
  registerHandler,
  registerHandlersOnce,
  setBillingAdmissionGate,
  setKernelAccessRequestCreator,
  setKernelIAMRuntime,
  setSecurityEventEmitter,
  type KernelAccessRequestArgs,
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
    await expect(
      invoke("test.echo", { value: "x" }, ctx),
    ).rejects.toMatchObject({
      code: "no_handler",
    });
  });

  it("rejects input that fails the contract schema", async () => {
    echoCap();
    registerHandler("test.echo", async () => async (input) => input);
    await expect(
      invoke("test.echo", { value: 42 }, ctx),
    ).rejects.toBeInstanceOf(CapabilityError);
    await expect(invoke("test.echo", { value: 42 }, ctx)).rejects.toMatchObject(
      {
        code: "invalid_input",
      },
    );
  });

  it("rejects handler output that violates the contract schema", async () => {
    echoCap();
    registerHandler("test.echo", async () => async () => ({ wrong: true }));
    await expect(
      invoke("test.echo", { value: "x" }, ctx),
    ).rejects.toMatchObject({
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
    expect(() =>
      registerHandler("test.dup", async () => async (i) => i),
    ).toThrow(/already registered/);
  });

  it("assertHandlersComplete flags a capability with no handler", () => {
    echoCap();
    expect(() => assertHandlersComplete()).toThrow(/test\.echo/);
    registerHandler("test.echo", async () => async (i) => i);
    expect(() => assertHandlersComplete()).not.toThrow();
  });

  it("capabilitiesForSurface filters by the contract surface list", () => {
    echoCap();
    expect(capabilitiesForSurface("mcp").map((c) => c.name)).toContain(
      "test.echo",
    );
    expect(capabilitiesForSurface("agent").map((c) => c.name)).not.toContain(
      "test.echo",
    );
  });

  it("tracks handler registration", () => {
    expect(hasHandler("test.echo")).toBe(false);
    registerHandler("test.echo", async () => async (i) => i);
    expect(hasHandler("test.echo")).toBe(true);
  });

  // ADR-025: every capability's canonical name is verb-first snake_case and the
  // registration modules bind their loaders under that same snake name (aliases
  // were removed). invoke() must resolve the handler by the canonical name —
  // regression for the "render_agent_ui" no-handler bug that took down prod.
  it("resolves a handler registered under the canonical snake name", async () => {
    registerCapability({
      name: "render_agent_ui",
      domain: "agent",
      description: "render",
      mode: "sync" as const,
      surfaces: ["agent"] as const,
      layers: ["unit"] as const,
      sensitivity: "low" as const,
      defaultEffect: "deny" as const,
      defaultRoles: { org: {}, workspace: {} },
      input: z.object({ componentId: z.string() }),
      output: z.object({ componentId: z.string() }),
    });
    registerHandler("render_agent_ui", async () => async (input) => input);
    const out = await invoke("render_agent_ui", { componentId: "x" }, ctx, {
      surface: "agent",
    });
    expect(out).toEqual({ componentId: "x" });
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

    await expect(invoke("test.echo", { value: 42 }, ctx)).rejects.toMatchObject(
      {
        code: "invalid_input",
      },
    );

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

    await expect(
      invoke("test.echo", { value: "x" }, ctx),
    ).rejects.toMatchObject({
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
    await expect(invoke("test.echo", { value: "hi" }, ctx)).resolves.toEqual({
      value: "hi",
    });
  });

  it("does not crash when the emitter throws synchronously", async () => {
    setSecurityEventEmitter(() => {
      throw new Error("emitter exploded");
    });
    echoCap();
    registerHandler("test.echo", async () => async (input) => input);

    // The capability should still succeed even though the emitter threw.
    await expect(invoke("test.echo", { value: "hi" }, ctx)).resolves.toEqual({
      value: "hi",
    });
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

  const allowFn: KernelIAMCheckFn = async () => ({
    outcome: "allow",
    principal: null,
  });
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

    const res = await authorizeExternalCapability(
      "mcp.github.list",
      extCtx,
      "deny",
    );

    expect(res).toEqual({
      allowed: true,
      outcome: "allow",
      reason: null,
      decision: null,
    });
    expect(events).toHaveLength(0);
  });

  it("allows and emits an allow event when the resolver returns allow", async () => {
    const events: KernelSecurityEvent[] = [];
    setSecurityEventEmitter((e) => events.push(e));
    setKernelIAMRuntime(allowFn, true);

    const res = await authorizeExternalCapability(
      "mcp.github.list",
      extCtx,
      "deny",
    );

    expect(res).toEqual({
      allowed: true,
      outcome: "allow",
      reason: null,
      decision: null,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: "allow",
      errorCode: null,
      capability: "mcp.github.list",
    });
  });

  it("blocks (fail-closed) and emits a deny event when the resolver denies AND enforcement is on", async () => {
    const events: KernelSecurityEvent[] = [];
    setSecurityEventEmitter((e) => events.push(e));
    setKernelIAMRuntime(denyFn, true);

    const res = await authorizeExternalCapability(
      "mcp.github.delete",
      extCtx,
      "deny",
    );

    expect(res).toEqual({
      allowed: false,
      outcome: "deny",
      reason: "policy_block",
      decision: null,
    });
    expect(events[0]).toMatchObject({
      outcome: "deny",
      errorCode: "authz_denied",
    });
  });

  it("allows (fail-open) but still emits a deny event when the resolver denies AND enforcement is off", async () => {
    const events: KernelSecurityEvent[] = [];
    setSecurityEventEmitter((e) => events.push(e));
    setKernelIAMRuntime(denyFn, false);

    const res = await authorizeExternalCapability(
      "mcp.github.delete",
      extCtx,
      "deny",
    );

    // Would-deny is logged-and-allowed when the enforcement flag is off.
    expect(res.allowed).toBe(true);
    expect(res.outcome).toBe("deny");
    expect(events[0]).toMatchObject({ outcome: "deny" });
  });

  it("fails closed (deny + emit) when the resolver throws AND enforcement is on", async () => {
    const events: KernelSecurityEvent[] = [];
    setSecurityEventEmitter((e) => events.push(e));
    setKernelIAMRuntime(throwFn, true);

    const res = await authorizeExternalCapability(
      "mcp.github.delete",
      extCtx,
      "deny",
    );

    expect(res).toEqual({
      allowed: false,
      outcome: "deny",
      reason: "iam_check_error",
      decision: null,
    });
    expect(events[0]).toMatchObject({
      outcome: "deny",
      errorCode: "authz_denied",
    });
  });

  it("fails closed (deny + emit) when the resolver throws AND enforcement is off", async () => {
    // Regression: a checkFn throw is an evaluation failure, not a policy
    // decision. It must ALWAYS deny, even when IAM_ENFORCEMENT_ENABLED=false —
    // the enforcement flag is only allowed to soften an actual "deny" outcome,
    // never an unevaluated (throw) result. The prior implementation fell
    // through to an unconditional allow here, silently disabling
    // authorization for every external-tool call while the resolver errored.
    const events: KernelSecurityEvent[] = [];
    setSecurityEventEmitter((e) => events.push(e));
    setKernelIAMRuntime(throwFn, false);

    const res = await authorizeExternalCapability(
      "mcp.github.delete",
      extCtx,
      "deny",
    );

    expect(res).toEqual({
      allowed: false,
      outcome: "deny",
      reason: "iam_check_error",
      decision: null,
    });
    expect(events[0]).toMatchObject({
      outcome: "deny",
      errorCode: "authz_denied",
    });
  });
});

// ── invoke() — checkFn throw fails closed regardless of enforcement ──────────
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

    await expect(
      invoke("test.echo", { value: "hi" }, ctx),
    ).rejects.toMatchObject({
      code: "authz_denied",
    });
  });

  it("denies (CapabilityError authz_denied) when checkFn throws AND enforcement is OFF", async () => {
    // A checkFn throw must deny unconditionally, independent of the
    // enforcement flag. Gating the deny on `_iamEnforced` would let a
    // checkFn throw with enforcement OFF fall through and run the handler —
    // granting access even though IAM could not evaluate the request at all
    // (e.g. IAM tables missing, DB down, resolver bug).
    const events: KernelSecurityEvent[] = [];
    setSecurityEventEmitter((e) => events.push(e));
    setKernelIAMRuntime(throwFn, false);
    echoCap();
    registerHandler("test.echo", async () => async (input) => input);

    await expect(
      invoke("test.echo", { value: "hi" }, ctx),
    ).rejects.toMatchObject({
      code: "authz_denied",
    });
    expect(
      events.some(
        (e) => e.outcome === "deny" && e.errorCode === "authz_denied",
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// invoke() IAM enforcement — deny vs. JIT pending_approval (access requests)
// ---------------------------------------------------------------------------

describe("invoke() IAM enforcement — deny + pending_approval", () => {
  const denyFn: KernelIAMCheckFn = async () => ({
    outcome: "deny",
    reason: "no_grant",
    principal: null,
  });

  const PENDING_PRINCIPAL = {
    id: "00000000-0000-0000-0000-0000000000a1",
    kind: "human" as const,
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
  };
  const pendingFn: KernelIAMCheckFn = async () => ({
    outcome: "pending_approval",
    principal: PENDING_PRINCIPAL,
  });

  afterEach(() => {
    clearRegistryForTests();
    clearHandlersForTests();
    clearKernelIAMRuntime();
    clearKernelAccessRequestCreator();
    clearSecurityEventEmitter();
  });

  it("a hard deny throws authz_denied, never runs the handler, and mints no access request", async () => {
    setKernelIAMRuntime(denyFn, true);
    const creator = vi.fn(async () => "arq_should_not_happen");
    setKernelAccessRequestCreator(creator);
    echoCap();
    let handlerRan = false;
    registerHandler("test.echo", async () => async (input) => {
      handlerRan = true;
      return input;
    });

    await expect(
      invoke("test.echo", { value: "x" }, ctx),
    ).rejects.toMatchObject({
      code: "authz_denied",
    });
    expect(handlerRan).toBe(false);
    // A hard deny is not pollable — the creator is never invoked.
    expect(creator).not.toHaveBeenCalled();
  });

  it("pending_approval mints a JIT access request, denies now, and carries the pollable id", async () => {
    setKernelIAMRuntime(pendingFn, true);
    const creator = vi.fn(
      async (_args: KernelAccessRequestArgs) => "arq_pending_1",
    );
    setKernelAccessRequestCreator(creator);
    const emitter = vi.fn();
    setSecurityEventEmitter(emitter);
    echoCap();
    let handlerRan = false;
    registerHandler("test.echo", async () => async (input) => {
      handlerRan = true;
      return input;
    });

    let thrown: unknown;
    try {
      await invoke("test.echo", { value: "x" }, ctx);
    } catch (err) {
      thrown = err;
    }

    // SECURITY INVARIANT: the action is denied now — the handler never ran.
    expect(handlerRan).toBe(false);
    expect(thrown).toBeInstanceOf(CapabilityError);
    expect(thrown).toMatchObject({
      code: "pending_approval",
      accessRequestId: "arq_pending_1",
    });

    // The creator is called with the resolved principal + canonical capability.
    expect(creator).toHaveBeenCalledTimes(1);
    expect(creator).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "test.echo",
        principal: PENDING_PRINCIPAL,
      }),
    );

    // The security stream still records a deny.
    expect(emitter).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "deny", errorCode: "authz_denied" }),
    );
  });

  it("pending_approval still denies when no access-request creator is registered (id absent)", async () => {
    setKernelIAMRuntime(pendingFn, true);
    // No setKernelAccessRequestCreator — mirrors a surface that never bootstrapped it.
    echoCap();
    let handlerRan = false;
    registerHandler("test.echo", async () => async (input) => {
      handlerRan = true;
      return input;
    });

    let thrown: unknown;
    try {
      await invoke("test.echo", { value: "x" }, ctx);
    } catch (err) {
      thrown = err;
    }

    expect(handlerRan).toBe(false);
    expect(thrown).toBeInstanceOf(CapabilityError);
    expect((thrown as CapabilityError).code).toBe("pending_approval");
    expect((thrown as CapabilityError).accessRequestId).toBeUndefined();
  });

  it("a throwing creator never turns pending_approval into an allow", async () => {
    setKernelIAMRuntime(pendingFn, true);
    const creator = vi.fn(async () => {
      throw new Error("access_requests table missing");
    });
    setKernelAccessRequestCreator(creator);
    echoCap();
    let handlerRan = false;
    registerHandler("test.echo", async () => async (input) => {
      handlerRan = true;
      return input;
    });

    let thrown: unknown;
    try {
      await invoke("test.echo", { value: "x" }, ctx);
    } catch (err) {
      thrown = err;
    }

    // The creator threw, but the decision is unchanged: denied, no pollable id.
    expect(handlerRan).toBe(false);
    expect((thrown as CapabilityError).code).toBe("pending_approval");
    expect((thrown as CapabilityError).accessRequestId).toBeUndefined();
  });

  it("with enforcement OFF, pending_approval logs would-deny and runs the handler (no request minted)", async () => {
    setKernelIAMRuntime(pendingFn, false);
    const creator = vi.fn(async () => "arq_should_not_happen");
    setKernelAccessRequestCreator(creator);
    echoCap();
    let handlerRan = false;
    registerHandler("test.echo", async () => async (input) => {
      handlerRan = true;
      return input;
    });

    const out = await invoke("test.echo", { value: "x" }, ctx);
    expect(out).toEqual({ value: "x" });
    expect(handlerRan).toBe(true);
    // Enforcement off proceeds — no access request is created.
    expect(creator).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Principal-to-data spine (accountability chain, Epic 1)
// ---------------------------------------------------------------------------

describe("invoke() principal spine", () => {
  const PRINCIPAL_ID = "00000000-0000-0000-0000-0000000000e5";
  const USER_ID = "00000000-0000-0000-0000-0000000000f6";
  const spineCtx: CapabilityContext = { ...ctx, userId: USER_ID };

  const allowWithPrincipal: KernelIAMCheckFn = async () => ({
    outcome: "allow",
    principal: {
      id: PRINCIPAL_ID,
      kind: "agent",
      orgId: spineCtx.orgId,
      workspaceId: spineCtx.workspaceId,
    },
  });

  afterEach(() => {
    clearRegistryForTests();
    clearHandlersForTests();
    clearKernelIAMRuntime();
    clearSecurityEventEmitter();
  });

  it("hands the handler a CheckedContext carrying the IAM-resolved principal", async () => {
    setKernelIAMRuntime(allowWithPrincipal, true);
    echoCap();
    let seenPrincipal: unknown = "unset";
    registerHandler("test.echo", async () => async (input, handlerCtx) => {
      seenPrincipal = handlerCtx.principal ?? null;
      return input;
    });

    await invoke("test.echo", { value: "hi" }, spineCtx);
    expect(seenPrincipal).toEqual({
      id: PRINCIPAL_ID,
      kind: "agent",
      orgId: spineCtx.orgId,
      workspaceId: spineCtx.workspaceId,
    });
  });

  it("enriches the ambient tenant scope so data-layer writes inherit attribution", async () => {
    const { getPrincipalAttribution } = await import("@oxagen/tenancy");
    setKernelIAMRuntime(allowWithPrincipal, true);
    echoCap();
    let seen: ReturnType<typeof getPrincipalAttribution> | null = null;
    registerHandler("test.echo", async () => async (input) => {
      seen = getPrincipalAttribution();
      return input;
    });

    await invoke("test.echo", { value: "hi" }, spineCtx);
    expect(seen).toEqual({
      principalId: PRINCIPAL_ID,
      principalKind: "agent",
      userId: USER_ID,
      capabilityName: "test.echo",
    });
  });

  it("carries userId + capabilityName even when no IAM runtime is registered", async () => {
    const { getPrincipalAttribution } = await import("@oxagen/tenancy");
    echoCap();
    let seen: ReturnType<typeof getPrincipalAttribution> | null = null;
    registerHandler("test.echo", async () => async (input) => {
      seen = getPrincipalAttribution();
      return input;
    });

    await invoke("test.echo", { value: "hi" }, spineCtx);
    expect(seen).toEqual({
      principalId: null,
      principalKind: null,
      userId: USER_ID,
      capabilityName: "test.echo",
    });
  });

  it("drops a non-uuid userId instead of failing the scope entry", async () => {
    const { getPrincipalAttribution } = await import("@oxagen/tenancy");
    echoCap();
    let seen: ReturnType<typeof getPrincipalAttribution> | null = null;
    registerHandler("test.echo", async () => async (input) => {
      seen = getPrincipalAttribution();
      return input;
    });

    // `ctx` (module fixture) carries userId "u" — not a uuid. The kernel must
    // treat it as unattributable rather than throwing TenantScopeError.
    const out = await invoke("test.echo", { value: "hi" }, ctx);
    expect(out).toEqual({ value: "hi" });
    expect(seen).toMatchObject({ userId: null, capabilityName: "test.echo" });
  });

  it("derives the audit target from the contract's declarative audit field", async () => {
    const targets: Array<{ kind: string; id: string } | null | undefined> = [];
    const recordingCheck: KernelIAMCheckFn = async (args) => {
      targets.push(args.target);
      return { outcome: "allow", principal: null };
    };
    setKernelIAMRuntime(recordingCheck, true);
    registerCapability({
      name: "test.target",
      domain: "test",
      description: "audit target exemplar",
      mode: "sync" as const,
      surfaces: ["api"] as const,
      layers: ["unit"] as const,
      sensitivity: "low" as const,
      defaultEffect: "deny" as const,
      defaultRoles: { org: {}, workspace: {} },
      audit: { targetKind: "graph.node", targetIdField: "nodeId" },
      input: z.object({ nodeId: z.string() }),
      output: z.object({ ok: z.boolean() }),
    });
    registerHandler("test.target", async () => async () => ({ ok: true }));

    await invoke("test.target", { nodeId: "node-123" }, spineCtx);
    expect(targets).toEqual([{ kind: "graph.node", id: "node-123" }]);
  });

  it("passes a null audit target when the declared input field is absent or empty", async () => {
    const targets: Array<{ kind: string; id: string } | null | undefined> = [];
    const recordingCheck: KernelIAMCheckFn = async (args) => {
      targets.push(args.target);
      return { outcome: "allow", principal: null };
    };
    setKernelIAMRuntime(recordingCheck, true);
    registerCapability({
      name: "test.target.optional",
      domain: "test",
      description: "audit target with optional id field",
      mode: "sync" as const,
      surfaces: ["api"] as const,
      layers: ["unit"] as const,
      sensitivity: "low" as const,
      defaultEffect: "deny" as const,
      defaultRoles: { org: {}, workspace: {} },
      audit: { targetKind: "graph.node", targetIdField: "nodeId" },
      input: z.object({ nodeId: z.string().optional() }),
      output: z.object({ ok: z.boolean() }),
    });
    registerHandler("test.target.optional", async () => async () => ({
      ok: true,
    }));

    // Field absent → the declared target must degrade to null, not throw or
    // fabricate a junk id.
    await invoke("test.target.optional", {}, spineCtx);
    // Field present but empty → same null-target degradation (length guard).
    await invoke("test.target.optional", { nodeId: "" }, spineCtx);
    expect(targets).toEqual([null, null]);
  });

  it("drops attribution for a principal whose id is not a uuid (fail-safe, not fail-request)", async () => {
    const { getPrincipalAttribution } = await import("@oxagen/tenancy");
    const bogusPrincipalCheck: KernelIAMCheckFn = async () => ({
      outcome: "allow",
      principal: {
        id: "not-a-uuid",
        kind: "agent",
        orgId: spineCtx.orgId,
        workspaceId: spineCtx.workspaceId,
      },
    });
    setKernelIAMRuntime(bogusPrincipalCheck, true);
    echoCap();
    let seen: ReturnType<typeof getPrincipalAttribution> | null = null;
    registerHandler("test.echo", async () => async (input) => {
      seen = getPrincipalAttribution();
      return input;
    });

    // The call must SUCCEED (a malformed principal id must not 500 the
    // request) while the scope stays unattributed rather than carrying garbage.
    const out = await invoke("test.echo", { value: "hi" }, spineCtx);
    expect(out).toEqual({ value: "hi" });
    expect(seen).toMatchObject({ principalId: null, principalKind: null });
  });

  it("passes a null audit target when the contract declares none", async () => {
    const targets: Array<{ kind: string; id: string } | null | undefined> = [];
    const recordingCheck: KernelIAMCheckFn = async (args) => {
      targets.push(args.target);
      return { outcome: "allow", principal: null };
    };
    setKernelIAMRuntime(recordingCheck, true);
    echoCap();
    registerHandler("test.echo", async () => async (input) => input);

    await invoke("test.echo", { value: "hi" }, spineCtx);
    expect(targets).toEqual([null]);
  });
});

describe("billing admission gate", () => {
  afterEach(() => {
    clearRegistryForTests();
    clearHandlersForTests();
    clearBillingAdmissionGate();
    clearKernelIAMRuntime();
  });

  it("skips billing for noBillingGate while still running IAM and the handler", async () => {
    registerCapability({
      name: "test.billing_bypass",
      domain: "test",
      description: "billing bypass witness",
      mode: "sync" as const,
      surfaces: ["api"] as const,
      layers: ["unit"] as const,
      scoped: true,
      noBillingGate: true,
      sensitivity: "high" as const,
      defaultEffect: "deny" as const,
      defaultRoles: { org: {}, workspace: {} },
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
    });
    const iamCheck = vi.fn<KernelIAMCheckFn>(async () => ({
      outcome: "allow",
      principal: null,
    }));
    const handler = vi.fn(async (input: unknown) => input);
    const billingGate = vi.fn(async () => {});
    setKernelIAMRuntime(iamCheck, true);
    registerHandler("test.billing_bypass", async () => handler);
    setBillingAdmissionGate(billingGate);

    const out = await invoke("test.billing_bypass", { value: "accepted" }, ctx);

    expect(out).toEqual({ value: "accepted" });
    expect(iamCheck).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(billingGate).not.toHaveBeenCalled();
  });

  it("invokes the registered gate for a scoped capability carrying an orgId", async () => {
    echoCap();
    registerHandler("test.echo", async () => async (input) => input);
    const gate = vi.fn(async () => {});
    setBillingAdmissionGate(gate);

    await invoke("test.echo", { value: "hi" }, ctx);

    expect(gate).toHaveBeenCalledWith(ctx.orgId);
  });

  it("propagates a rejection thrown by the gate", async () => {
    echoCap();
    registerHandler("test.echo", async () => async (input) => input);
    setBillingAdmissionGate(async () => {
      throw new Error("insufficient credits");
    });

    await expect(invoke("test.echo", { value: "hi" }, ctx)).rejects.toThrow(
      "insufficient credits",
    );
  });

  it("stops firing once cleared", async () => {
    echoCap();
    registerHandler("test.echo", async () => async (input) => input);
    const gate = vi.fn(async () => {
      throw new Error("should not run");
    });
    setBillingAdmissionGate(gate);
    clearBillingAdmissionGate();

    const out = await invoke("test.echo", { value: "hi" }, ctx);

    expect(out).toEqual({ value: "hi" });
    expect(gate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Agent-run unconditional enforcement (Agent RBAC Phase 2 — spec §3.4/§3.5)
//
// An invocation whose ctx carries an agent-run context (ctx.agentRun,
// principalKind='agent') blocks on a non-allow IAM outcome REGARDLESS of the
// IAM_ENFORCEMENT_ENABLED rollout flag: an unattended automation must never
// proceed on a would-deny. Human traffic (no ctx.agentRun) keeps the existing
// flag semantics — proven by the enforcement-off tests above.
// ---------------------------------------------------------------------------

describe("invoke() agent-run enforcement", () => {
  const agentRunCtx = (): CapabilityContext => ({
    ...ctx,
    userId: null,
    surface: "runner",
    agentRun: {
      principalKind: "agent",
      agentPrincipal: {
        id: "00000000-0000-0000-0000-0000000000a1",
        kind: "agent",
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
      },
      humanPrincipal: {
        id: "00000000-0000-0000-0000-0000000000a2",
        kind: "human",
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
      },
      agentId: "agt_kernel_test",
      runId: "run_kernel_test",
      parentRunId: null,
    },
  });

  /**
   * A governed agent run persists one immutable authorization_decisions row per
   * operation; the kernel fails closed when the IAM runtime returns none. These
   * stubs therefore carry a decision reference, exactly as the real
   * @oxagen/iam adapter does.
   */
  const decision: AuthorizationDecisionRef = {
    publicId: "azd_kernel_test",
    outcome: "deny",
    decisionDigest: `sha256:${"3".repeat(64)}`,
    denyGeneration: { org: 1, workspace: 2 },
    decidedAt: "2026-07-21T12:00:00.000Z",
  };
  const denyFn: KernelIAMCheckFn = async () => ({
    outcome: "deny",
    reason: "no_grant",
    principal: null,
    decision,
  });
  const pendingFn: KernelIAMCheckFn = async () => ({
    outcome: "pending_approval",
    principal: null,
    decision: { ...decision, outcome: "approval_pending" },
  });

  afterEach(() => {
    clearRegistryForTests();
    clearHandlersForTests();
    clearKernelIAMRuntime();
    clearKernelAccessRequestCreator();
    clearSecurityEventEmitter();
  });

  it("blocks a denied agent-run invocation even with enforcement OFF", async () => {
    setKernelIAMRuntime(denyFn, /* enforced */ false);
    echoCap();
    let handlerRan = false;
    registerHandler("test.echo", async () => async (input) => {
      handlerRan = true;
      return input;
    });

    await expect(
      invoke("test.echo", { value: "poisoned" }, agentRunCtx()),
    ).rejects.toMatchObject({ code: "authz_denied" });
    expect(handlerRan).toBe(false);
  });

  it("routes an agent-run pending_approval through the access-request flow even with enforcement OFF", async () => {
    setKernelIAMRuntime(pendingFn, /* enforced */ false);
    const creator = vi.fn(async () => "arq_agent_run");
    setKernelAccessRequestCreator(creator);
    echoCap();
    let handlerRan = false;
    registerHandler("test.echo", async () => async (input) => {
      handlerRan = true;
      return input;
    });

    let thrown: unknown;
    try {
      await invoke("test.echo", { value: "x" }, agentRunCtx());
    } catch (err) {
      thrown = err;
    }

    expect(handlerRan).toBe(false);
    expect(thrown).toBeInstanceOf(CapabilityError);
    expect((thrown as CapabilityError).code).toBe("pending_approval");
    expect((thrown as CapabilityError).accessRequestId).toBe("arq_agent_run");
    expect(creator).toHaveBeenCalledTimes(1);
  });

  it("still allows an allowed agent-run invocation, and hands the handler its decision reference", async () => {
    const allowDecision: AuthorizationDecisionRef = {
      ...decision,
      outcome: "allow",
    };
    setKernelIAMRuntime(
      async () => ({
        outcome: "allow",
        principal: null,
        decision: allowDecision,
      }),
      false,
    );
    echoCap();
    let seen: AuthorizationDecisionRef | undefined;
    registerHandler("test.echo", async () => async (input, checkedCtx) => {
      seen = checkedCtx.authorizationDecision;
      return input;
    });

    const out = await invoke("test.echo", { value: "ok" }, agentRunCtx());
    expect(out).toEqual({ value: "ok" });
    expect(seen).toEqual(allowDecision);
  });

  it("attaches the decision reference to the thrown CapabilityError on a deny", async () => {
    setKernelIAMRuntime(denyFn, /* enforced */ false);
    echoCap();
    registerHandler("test.echo", async () => async (input) => input);

    let thrown: unknown;
    try {
      await invoke("test.echo", { value: "x" }, agentRunCtx());
    } catch (err) {
      thrown = err;
    }
    expect((thrown as CapabilityError).decision).toEqual(decision);
  });

  it("FAILS CLOSED when the IAM runtime persisted no decision row", async () => {
    // An allow with no decision reference: the operation would be unrecorded,
    // and an unrecorded decision is not an allowed one.
    setKernelIAMRuntime(
      async () => ({ outcome: "allow", principal: null, decision: null }),
      false,
    );
    echoCap();
    let handlerRan = false;
    registerHandler("test.echo", async () => async (input) => {
      handlerRan = true;
      return input;
    });

    await expect(
      invoke("test.echo", { value: "x" }, agentRunCtx()),
    ).rejects.toMatchObject({ code: "authz_denied" });
    expect(handlerRan).toBe(false);
  });

  it("REJECTS a caller-supplied authorizationDecision — the binding is platform-created", async () => {
    setKernelIAMRuntime(
      async () => ({ outcome: "allow", principal: null, decision }),
      false,
    );
    echoCap();
    let handlerRan = false;
    registerHandler("test.echo", async () => async (input) => {
      handlerRan = true;
      return input;
    });

    const forged = {
      ...agentRunCtx(),
      authorizationDecision: decision,
    } as CapabilityContext;

    await expect(
      invoke("test.echo", { value: "forged" }, forged),
    ).rejects.toMatchObject({ code: "authz_denied" });
    expect(handlerRan).toBe(false);
  });

  it("REJECTS a hand-rolled deployedAgentInvocation, and accepts a kernel-minted one", async () => {
    setKernelIAMRuntime(
      async () => ({ outcome: "allow", principal: null, decision }),
      false,
    );
    echoCap();
    registerHandler("test.echo", async () => async (input) => input);

    const principal = {
      id: "00000000-0000-0000-0000-0000000000a2",
      kind: "human" as const,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
    };
    const agentPrincipal = {
      id: "00000000-0000-0000-0000-0000000000a1",
      kind: "agent" as const,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
    };

    // A structurally identical object that the kernel did not mint.
    const forged = {
      ...ctx,
      deployedAgentInvocation: {
        principalKind: "deployed_agent_invocation",
        initiatingPrincipal: principal,
        agentPrincipal,
        agentId: "agt_forged",
        agentVersionId: "00000000-0000-0000-0000-0000000000a3",
        agentVersionChecksum: `sha256:${"4".repeat(64)}`,
      },
    } as unknown as CapabilityContext;

    await expect(
      invoke("test.echo", { value: "forged" }, forged),
    ).rejects.toMatchObject({ code: "authz_denied" });

    const minted = createDeployedAgentInvocationContext({
      initiatingPrincipal: principal,
      agentPrincipal,
      agentId: "agt_real",
      agentVersionId: "00000000-0000-0000-0000-0000000000a3",
      agentVersionChecksum: `sha256:${"4".repeat(64)}`,
    });
    expect(isKernelIssuedDeployedAgentInvocation(minted)).toBe(true);

    const out = await invoke(
      "test.echo",
      { value: "ok" },
      { ...ctx, deployedAgentInvocation: minted },
    );
    expect(out).toEqual({ value: "ok" });
  });

  it("authorizeExternalCapability fails closed for an agent run with enforcement OFF", async () => {
    setKernelIAMRuntime(denyFn, /* enforced */ false);

    const res = await authorizeExternalCapability(
      "mcp.github.merge_pr",
      agentRunCtx(),
      "deny",
    );

    expect(res.allowed).toBe(false);
    expect(res.outcome).toBe("deny");
  });
});

describe("registerHandlersOnce", () => {
  it("runs the register callback only once per token", () => {
    const register = vi.fn();

    registerHandlersOnce("kernel-test-token-once", register);
    registerHandlersOnce("kernel-test-token-once", register);

    expect(register).toHaveBeenCalledTimes(1);
  });

  it("runs independently for a different token", () => {
    const registerA = vi.fn();
    const registerB = vi.fn();

    registerHandlersOnce("kernel-test-token-a", registerA);
    registerHandlersOnce("kernel-test-token-b", registerB);

    expect(registerA).toHaveBeenCalledTimes(1);
    expect(registerB).toHaveBeenCalledTimes(1);
  });
});
