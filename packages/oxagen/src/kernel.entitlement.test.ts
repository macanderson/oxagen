import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { CapabilityContext } from "./types";
import { clearRegistryForTests, registerCapability } from "./registry";
import {
  CapabilityError,
  capabilityNotInstalledError,
  clearBillingAdmissionGate,
  clearCapabilityEntitlementGate,
  clearHandlersForTests,
  clearSecurityEventEmitter,
  invoke,
  registerHandler,
  setCapabilityEntitlementGate,
} from "./kernel";
import { clearPluginRegistryForTests } from "./plugins/registry";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ctx: CapabilityContext = {
  orgId: "00000000-0000-0000-0000-000000000001",
  workspaceId: "00000000-0000-0000-0000-000000000002",
  userId: "u",
  apiKeyId: null,
  requestId: "r",
  surface: "api",
  messageId: null,
};

const ctxNoOrg: CapabilityContext = {
  ...ctx,
  orgId: "",
};

// A builtin capability — NOT claimed by any plugin.
const builtinCap = () =>
  registerCapability({
    name: "test.builtin",
    domain: "test",
    description: "A builtin capability not claimed by any plugin.",
    mode: "sync" as const,
    surfaces: ["api"] as const,
    layers: ["unit"] as const,
    sensitivity: "low" as const,
    defaultEffect: "allow" as const,
    defaultRoles: { org: {}, workspace: {} },
    input: z.object({ v: z.string() }),
    output: z.object({ v: z.string() }),
  });

// A plugin-claimed capability. We register it with a name that the plugin
// registry actually claims (image.generate from oxagen/media-image).
// Because the plugin registry is seeded from catalog manifests we can't
// inject a fake — so we use the real contract name.
const pluginClaimedCap = () =>
  registerCapability({
    name: "generate_image",
    domain: "image",
    description: "Generate an image (claimed by oxagen/media-image in tests).",
    mode: "sync" as const,
    surfaces: ["api"] as const,
    layers: ["unit"] as const,
    sensitivity: "low" as const,
    defaultEffect: "allow" as const,
    defaultRoles: { org: {}, workspace: {} },
    input: z.object({ v: z.string() }),
    output: z.object({ v: z.string() }),
  });

// An unscoped plugin-claimed capability (scoped:false bypasses runInTenantScope).
// We need this for the "empty orgId skips gate" test: a scoped capability with
// orgId:"" throws TenantScopeError before we reach the entitlement gate, which
// is the correct kernel behaviour — the test verifies the gate is not called
// when orgId is absent, so we need a surface where the scope check is bypassed.
const pluginClaimedUnscopedCap = () =>
  registerCapability({
    name: "generate_svg",
    domain: "svg",
    description:
      "Generate SVG (claimed by oxagen/media-svg, unscoped in test).",
    mode: "sync" as const,
    surfaces: ["api"] as const,
    layers: ["unit"] as const,
    sensitivity: "low" as const,
    defaultEffect: "allow" as const,
    defaultRoles: { org: {}, workspace: {} },
    // scoped:false so runInTenantScope is NOT called — lets us reach the
    // entitlement gate with an empty orgId to verify it is skipped.
    scoped: false,
    input: z.object({ v: z.string() }),
    output: z.object({ v: z.string() }),
  });

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("kernel capability entitlement gate", () => {
  afterEach(() => {
    clearRegistryForTests();
    clearHandlersForTests();
    clearSecurityEventEmitter();
    clearCapabilityEntitlementGate();
    clearBillingAdmissionGate();
    clearPluginRegistryForTests();
  });

  it("does NOT call the gate for a builtin (unclaimed) contract", async () => {
    const gate = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    setCapabilityEntitlementGate(gate);
    builtinCap();
    registerHandler("test.builtin", async () => async (input) => input);

    await invoke("test.builtin", { v: "hi" }, ctx);

    expect(gate).not.toHaveBeenCalled();
  });

  it("calls the gate for a plugin-claimed contract with (capabilityName, orgId)", async () => {
    const gate = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    setCapabilityEntitlementGate(gate);
    pluginClaimedCap();
    registerHandler("generate_image", async () => async (input) => input);

    await invoke("generate_image", { v: "hi" }, ctx);

    expect(gate).toHaveBeenCalledOnce();
    // Entitlement is workspace-scoped — the gate receives (name, orgId, workspaceId).
    expect(gate).toHaveBeenCalledWith(
      "generate_image",
      ctx.orgId,
      ctx.workspaceId,
    );
  });

  it("propagates the gate throw with code capability_not_installed", async () => {
    const error = capabilityNotInstalledError(
      "generate_image",
      "oxagen/media-image",
      "Image Generation",
    );
    const gate = vi.fn<() => Promise<void>>().mockRejectedValue(error);
    setCapabilityEntitlementGate(gate);
    pluginClaimedCap();
    registerHandler("generate_image", async () => async (input) => input);

    await expect(
      invoke("generate_image", { v: "hi" }, ctx),
    ).rejects.toMatchObject({
      code: "capability_not_installed",
    });
  });

  it("allows when no gate is registered (default-open)", async () => {
    // clearCapabilityEntitlementGate() already called in afterEach; no gate here.
    pluginClaimedCap();
    registerHandler("generate_image", async () => async (input) => input);

    await expect(invoke("generate_image", { v: "hi" }, ctx)).resolves.toEqual({
      v: "hi",
    });
  });

  it("skips the gate when orgId is empty (system/internal invocation)", async () => {
    const gate = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error("should not be called"));
    setCapabilityEntitlementGate(gate);
    // Use the unscoped variant so runInTenantScope doesn't reject the empty orgId
    // before we reach the entitlement gate — we want to assert the gate itself
    // is bypassed when orgId is absent, not that TenantScope rejects first.
    pluginClaimedUnscopedCap();
    registerHandler("generate_svg", async () => async (input) => input);

    // ctxNoOrg has orgId: "" — entitlement gate must be bypassed.
    await expect(
      invoke("generate_svg", { v: "hi" }, ctxNoOrg),
    ).resolves.toEqual({
      v: "hi",
    });
    expect(gate).not.toHaveBeenCalled();
  });
});

describe("capabilityNotInstalledError", () => {
  it("produces a CapabilityError with the expected code and message", () => {
    const err = capabilityNotInstalledError(
      "generate_video",
      "oxagen/media-video",
      "Video Generation",
    );
    expect(err).toBeInstanceOf(CapabilityError);
    expect(err.code).toBe("capability_not_installed");
    expect(err.capability).toBe("generate_video");
    expect(err.message).toContain("generate_video");
    expect(err.message).toContain("Video Generation");
    expect(err.message).toContain("oxagen/media-video");
    expect(err.message).toContain("marketplace");
  });

  it("carries the name CapabilityError", () => {
    const err = capabilityNotInstalledError(
      "generate_svg",
      "oxagen/media-svg",
      "SVG Generation",
    );
    expect(err.name).toBe("CapabilityError");
  });
});
