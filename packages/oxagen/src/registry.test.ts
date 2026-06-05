import { afterEach, describe, expect, it } from "vitest";
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
    expect(listCapabilities().filter((c) => c.name === "test.beta")).toHaveLength(1);
  });

  it("throws when a different declaration claims an already-registered name", () => {
    registerCapability(makeCap("test.gamma"));
    expect(() =>
      registerCapability({
        ...makeCap("test.gamma"),
        description: "a conflicting redefinition",
      }),
    ).toThrow(/already registered/);
  });

  it("lists all registered capabilities", () => {
    registerCapability(makeCap("test.one"));
    registerCapability(makeCap("test.two"));
    const names = listCapabilities().map((c) => c.name).sort();
    expect(names).toEqual(["test.one", "test.two"]);
  });

  it("returns undefined for an unknown capability", () => {
    expect(getCapability("missing")).toBeUndefined();
  });
});
