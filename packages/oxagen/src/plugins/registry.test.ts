import { afterEach, describe, expect, it } from "vitest";
import {
  listOxagenPlugins,
  getOxagenPlugin,
  pluginForContract,
  validateOxagenPluginContracts,
  clearPluginRegistryForTests,
} from "./registry";

// Import the contracts barrel so all capabilities register before we run
// validateOxagenPluginContracts(). Without this import the capability registry
// is empty and every contract would appear unknown.
import "../contracts/index";

describe("listOxagenPlugins", () => {
  afterEach(() => {
    clearPluginRegistryForTests();
  });

  it("returns all first-party manifests", () => {
    const plugins = listOxagenPlugins();
    expect(plugins).toHaveLength(5);
    const ids = plugins.map((p) => p.id);
    expect(ids).toContain("oxagen/media-video");
    expect(ids).toContain("oxagen/media-image");
    expect(ids).toContain("oxagen/media-svg");
    expect(ids).toContain("oxagen/documents");
    // Template-distribution proof pack (Spec §6) — ships a sandbox template,
    // claims no capability contract.
    expect(ids).toContain("oxagen/swe-bench-evals");
  });

  it("returns manifests that each pass the zod schema", async () => {
    const { oxagenPluginManifestSchema } = await import("./manifest");
    for (const plugin of listOxagenPlugins()) {
      const result = oxagenPluginManifestSchema.safeParse(plugin);
      expect(result.success, `manifest "${plugin.id}" should pass schema`).toBe(
        true,
      );
    }
  });
});

describe("getOxagenPlugin", () => {
  afterEach(() => {
    clearPluginRegistryForTests();
  });

  it("returns the manifest for a known plugin id", () => {
    const plugin = getOxagenPlugin("oxagen/media-video");
    expect(plugin).toBeDefined();
    expect(plugin?.id).toBe("oxagen/media-video");
    expect(plugin?.tier).toBe("free");
  });

  it("returns undefined for an unknown plugin id", () => {
    const plugin = getOxagenPlugin("oxagen/nonexistent");
    expect(plugin).toBeUndefined();
  });

  it("returns the full media-image manifest with correct contracts", () => {
    const plugin = getOxagenPlugin("oxagen/media-image");
    expect(plugin).toBeDefined();
    expect(plugin?.contracts).toContain("generate_image");
    expect(plugin?.contracts).toContain("create_image");
    expect(plugin?.contracts).toContain("analyze_image");
    expect(plugin?.contracts).toContain("list_images");
  });

  it("returns the documents manifest with correct contracts", () => {
    const plugin = getOxagenPlugin("oxagen/documents");
    expect(plugin).toBeDefined();
    expect(plugin?.contracts).toContain("generate_document");
    expect(plugin?.contracts).toContain("create_pdf");
    expect(plugin?.contracts).toContain("generate_markdown");
    expect(plugin?.contracts).toContain("generate_mermaid");
    expect(plugin?.category).toBe("documents");
  });
});

describe("pluginForContract", () => {
  afterEach(() => {
    clearPluginRegistryForTests();
  });

  it("returns the correct plugin for each claimed contract", () => {
    const contractCases: Array<[string, string]> = [
      ["generate_video", "oxagen/media-video"],
      ["generate_image", "oxagen/media-image"],
      ["create_image", "oxagen/media-image"],
      ["analyze_image", "oxagen/media-image"],
      ["list_images", "oxagen/media-image"],
      ["generate_svg", "oxagen/media-svg"],
      ["generate_document", "oxagen/documents"],
      ["create_pdf", "oxagen/documents"],
      ["generate_markdown", "oxagen/documents"],
      ["generate_mermaid", "oxagen/documents"],
    ];
    for (const [contract, expectedId] of contractCases) {
      const plugin = pluginForContract(contract);
      expect(
        plugin,
        `contract "${contract}" should map to plugin "${expectedId}"`,
      ).toBeDefined();
      expect(plugin?.id).toBe(expectedId);
    }
  });

  it("returns undefined for a builtin contract not claimed by any plugin", () => {
    // document.create/list/read are builtin — NOT in any plugin's contracts list.
    expect(pluginForContract("create_document")).toBeUndefined();
    expect(pluginForContract("list_documents")).toBeUndefined();
    expect(pluginForContract("read_document")).toBeUndefined();
  });

  it("returns undefined for a completely unknown contract name", () => {
    expect(pluginForContract("nonexistent.capability")).toBeUndefined();
  });

  it("returns undefined for chat and agent contracts (always builtin)", () => {
    expect(pluginForContract("send_message")).toBeUndefined();
    expect(pluginForContract("execute_code")).toBeUndefined();
  });
});

describe("validateOxagenPluginContracts", () => {
  afterEach(() => {
    clearPluginRegistryForTests();
  });

  it("passes without throwing when all claimed contracts exist in the capability registry", () => {
    // The contracts barrel was imported at the top of this file, so all
    // capabilities are registered in the live capability registry.
    expect(() => validateOxagenPluginContracts()).not.toThrow();
  });
});

describe("plugin registry invariants — Phase 1 pack assignments", () => {
  afterEach(() => {
    clearPluginRegistryForTests();
  });

  it("media-video has tier=free and visibility=ga", () => {
    const p = getOxagenPlugin("oxagen/media-video");
    expect(p?.tier).toBe("free");
    expect(p?.visibility).toBe("ga");
    expect(p?.icon).toBe("video");
  });

  it("media-image has tier=free and visibility=ga", () => {
    const p = getOxagenPlugin("oxagen/media-image");
    expect(p?.tier).toBe("free");
    expect(p?.visibility).toBe("ga");
    expect(p?.icon).toBe("image-plus");
  });

  it("media-svg has tier=free and visibility=ga", () => {
    const p = getOxagenPlugin("oxagen/media-svg");
    expect(p?.tier).toBe("free");
    expect(p?.visibility).toBe("ga");
    expect(p?.icon).toBe("pen-tool");
  });

  it("documents has tier=free, visibility=ga, and category=documents", () => {
    const p = getOxagenPlugin("oxagen/documents");
    expect(p?.tier).toBe("free");
    expect(p?.visibility).toBe("ga");
    expect(p?.category).toBe("documents");
    expect(p?.icon).toBe("notebook-pen");
  });

  it("all Phase 1 plugins have version 1.0.0 and empty scopes", () => {
    for (const plugin of listOxagenPlugins()) {
      expect(plugin.version, `${plugin.id} version`).toBe("1.0.0");
      expect(plugin.scopes, `${plugin.id} scopes`).toEqual([]);
    }
  });

  it("no contract is claimed by more than one plugin (O(1) index integrity)", () => {
    const seen = new Map<string, string>();
    for (const plugin of listOxagenPlugins()) {
      for (const contract of plugin.contracts) {
        const prev = seen.get(contract);
        expect(
          prev,
          `contract "${contract}" claimed by both "${prev}" and "${plugin.id}"`,
        ).toBeUndefined();
        seen.set(contract, plugin.id);
      }
    }
  });
});
