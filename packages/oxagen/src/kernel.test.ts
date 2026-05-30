import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { CapabilityContext } from "./types.js";
import { clearRegistryForTests, registerCapability } from "./registry.js";
import {
  CapabilityError,
  assertHandlersComplete,
  capabilitiesForSurface,
  clearHandlersForTests,
  hasHandler,
  invoke,
  registerHandler,
} from "./kernel.js";

const ctx: CapabilityContext = {
  orgId: "t",
  workspaceId: "w",
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
    input: z.object({ value: z.string() }),
    output: z.object({ value: z.string() }),
  });

describe("capability kernel", () => {
  afterEach(() => {
    clearRegistryForTests();
    clearHandlersForTests();
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
