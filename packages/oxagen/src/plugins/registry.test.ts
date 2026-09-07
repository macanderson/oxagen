import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listOxagenPlugins,
  getOxagenPlugin,
  pluginForContract,
  validateOxagenPluginContracts,
  clearPluginRegistryForTests,
  registerOxagenPluginForTests,
} from "./registry";
import type { OxagenPluginManifest } from "./manifest";

// Import the contracts barrel so all capabilities register before we run
// validateOxagenPluginContracts(). Without this import the capability registry
// is empty and every contract would appear unknown.
import "../contracts/index";

// No pack ships built in (ADR-043): the registry starts empty and customer
// packs arrive through the plugin catalog (ADR-034). Tests register fixtures.
const fixture: OxagenPluginManifest = {
  id: "acme/graph-readers",
  name: "Graph readers",
  description: "A customer capability pack claiming two live graph contracts.",
  version: "1.0.0",
  pluginType: "agent_capability",
  tier: "free",
  visibility: "ga",
  category: "knowledge",
  contracts: ["get_graph_stats", "search_graph"],
  scopes: [],
};

beforeEach(() => clearPluginRegistryForTests());
afterEach(() => clearPluginRegistryForTests());

describe("listOxagenPlugins", () => {
  it("starts empty — nothing ships built in", () => {
    expect(listOxagenPlugins()).toEqual([]);
  });

  it("returns registered manifests in insertion order", () => {
    registerOxagenPluginForTests(fixture);
    registerOxagenPluginForTests({
      ...fixture,
      id: "acme/second",
      contracts: ["get_graph_node"],
    });
    expect(listOxagenPlugins().map((p) => p.id)).toEqual([
      "acme/graph-readers",
      "acme/second",
    ]);
  });
});

describe("getOxagenPlugin", () => {
  it("returns the manifest for a known plugin id", () => {
    registerOxagenPluginForTests(fixture);
    expect(getOxagenPlugin("acme/graph-readers")?.contracts).toEqual([
      "get_graph_stats",
      "search_graph",
    ]);
  });

  it("returns undefined for an unknown plugin id", () => {
    expect(getOxagenPlugin("oxagen/does-not-exist")).toBeUndefined();
  });
});

describe("pluginForContract", () => {
  it("returns the claiming plugin for a claimed contract", () => {
    registerOxagenPluginForTests(fixture);
    expect(pluginForContract("search_graph")?.id).toBe("acme/graph-readers");
  });

  it("returns undefined for a builtin contract not claimed by any plugin", () => {
    registerOxagenPluginForTests(fixture);
    expect(pluginForContract("send_message")).toBeUndefined();
    expect(pluginForContract("resolve_approval")).toBeUndefined();
  });

  it("returns undefined for a completely unknown contract name", () => {
    expect(pluginForContract("nonexistent.capability")).toBeUndefined();
  });
});

describe("registerOxagenPluginForTests invariants", () => {
  it("rejects a duplicate plugin id", () => {
    registerOxagenPluginForTests(fixture);
    expect(() => registerOxagenPluginForTests(fixture)).toThrow(
      /Duplicate plugin id/,
    );
  });

  it("rejects a contract already claimed by another plugin", () => {
    registerOxagenPluginForTests(fixture);
    expect(() =>
      registerOxagenPluginForTests({
        ...fixture,
        id: "acme/other",
        contracts: ["search_graph"],
      }),
    ).toThrow(/already claimed/);
  });

  it("validates the manifest against the zod schema", () => {
    expect(() =>
      registerOxagenPluginForTests({ ...fixture, contracts: [] }),
    ).toThrow();
  });
});

describe("validateOxagenPluginContracts", () => {
  it("passes when every claimed contract exists in the capability registry", () => {
    registerOxagenPluginForTests(fixture);
    expect(() => validateOxagenPluginContracts()).not.toThrow();
  });

  it("throws listing contracts no capability declares", () => {
    registerOxagenPluginForTests({
      ...fixture,
      contracts: ["not_a_real_capability"],
    });
    expect(() => validateOxagenPluginContracts()).toThrow(
      /not_a_real_capability/,
    );
  });
});
