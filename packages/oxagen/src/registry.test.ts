import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  clearRegistryForTests,
  getCapability,
  listCapabilities,
  namesForCapability,
  registerCapability,
  resolveCanonicalName,
  setAliasDeprecationSink,
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
    expect(listCapabilities().filter((c) => c.name === "test.gamma")).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
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

describe("capability aliases (ADR-022)", () => {
  afterEach(() => {
    clearRegistryForTests();
    setAliasDeprecationSink(null);
  });

  const makeAliased = (name: string, aliases: string[]) => ({
    ...makeCap(name),
    aliases,
  });

  it("resolves getCapability through a legacy alias to the canonical contract", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cap = registerCapability(makeAliased("agent.file_lock.acquire", ["agent.file.lock.acquire"]));
    expect(getCapability("agent.file.lock.acquire")).toBe(cap);
    expect(getCapability("agent.file_lock.acquire")).toBe(cap);
    warn.mockRestore();
  });

  it("resolveCanonicalName maps alias→canonical and passes unknown names through", () => {
    registerCapability(makeAliased("org.create", ["organization.create"]));
    expect(resolveCanonicalName("organization.create")).toBe("org.create");
    expect(resolveCanonicalName("org.create")).toBe("org.create");
    expect(resolveCanonicalName("nope.nope")).toBe("nope.nope");
  });

  it("namesForCapability returns canonical + aliases (from either a canonical or an alias name)", () => {
    registerCapability(makeAliased("document.generate", ["documents.generate"]));
    expect(namesForCapability("document.generate").sort()).toEqual(
      ["document.generate", "documents.generate"],
    );
    expect(namesForCapability("documents.generate").sort()).toEqual(
      ["document.generate", "documents.generate"],
    );
    expect(namesForCapability("unknown.name")).toEqual(["unknown.name"]);
  });

  it("reports an alias hit through the injected deprecation sink exactly once per alias", () => {
    const sink = vi.fn();
    setAliasDeprecationSink(sink);
    registerCapability(makeAliased("notification.mark", ["notifications.mark"]));
    getCapability("notifications.mark");
    getCapability("notifications.mark");
    // canonical lookups never report a deprecation
    getCapability("notification.mark");
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith("notifications.mark", "notification.mark");
  });

  it("never lets an alias shadow a live capability name", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const live = registerCapability(makeCap("graph.node_label.get"));
    // A second contract that (wrongly) claims the live name as an alias must not
    // hijack it — the canonical registry entry always wins.
    registerCapability(makeAliased("graph.other.get", ["graph.node_label.get"]));
    expect(getCapability("graph.node_label.get")).toBe(live);
    warn.mockRestore();
  });
});
