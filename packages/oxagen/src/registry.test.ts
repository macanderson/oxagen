import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  clearRegistryForTests,
  getCapability,
  listCapabilities,
  registerCapability,
} from "./registry";

const makeCap = (name: string) => ({
  name,
  domain: "test",
  description: "test capability",
  mode: "sync" as const,
  layers: ["unit"] as const,
  sensitivity: "low" as const,
  defaultEffect: "deny" as const,
  defaultRoles: { org: {}, workspace: {} },
  input: z.object({}),
  output: z.object({}),
});

describe("capability registry", () => {
  afterEach(() => {
    clearRegistryForTests();
  });

  it("registers a capability and returns the declaration", () => {
    const cap = registerCapability(makeCap("test.alpha"));
    expect(cap.name).toBe("test.alpha");
    expect(getCapability("test.alpha")).toBe(cap);
  });

  it("is idempotent when an identical declaration re-registers (a bundler may evaluate a contract module twice)", () => {
    const first = registerCapability(makeCap("test.beta"));
    const second = registerCapability(makeCap("test.beta"));
    // Same name + same shape collapses to one registration and hands back the
    // original object, so both module instances share one declaration.
    expect(second).toBe(first);
    expect(
      listCapabilities().filter((c) => c.name === "test.beta"),
    ).toHaveLength(1);
  });

  it("keeps the first registration and warns (not throws) when a different descriptor re-registers a name", () => {
    // A clean module graph wouldn't do this, but Turbopack dev/HMR can evaluate
    // a contract twice with a desynced descriptor. Crashing the running app over
    // that bundler artifact is worse than the collision; genuine duplicate names
    // are caught at build time by check:manifest. So the runtime stays resilient.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = registerCapability(makeCap("test.gamma"));
    const second = registerCapability({
      ...makeCap("test.gamma"),
      description: "a conflicting redefinition",
    });
    expect(second).toBe(first); // first registration wins
    expect(second.description).toBe("test capability"); // redefinition ignored
    expect(
      listCapabilities().filter((c) => c.name === "test.gamma"),
    ).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("lists all registered capabilities", () => {
    registerCapability(makeCap("test.one"));
    registerCapability(makeCap("test.two"));
    const names = listCapabilities()
      .map((c) => c.name)
      .sort();
    expect(names).toEqual(["test.one", "test.two"]);
  });

  it("rejects invalid lifecycle metadata at registration", () => {
    expect(() =>
      registerCapability({
        ...makeCap("test.lifecycle"),
        lifecycle: {
          allowedEvents: [],
          effect: "mutation",
          idempotency: "none",
          outputKinds: [],
        },
      }),
    ).toThrow(/invalid_lifecycle_metadata/);
  });

  it("returns undefined for an unknown capability", () => {
    expect(getCapability("missing")).toBeUndefined();
  });

  it("resolves getCapability by canonical name only (no alias fallback)", () => {
    const cap = registerCapability(makeCap("test.canonical"));
    expect(getCapability("test.canonical")).toBe(cap);
    // A name that is not the canonical registered name never resolves.
    expect(getCapability("test.legacy_name")).toBeUndefined();
  });
});
