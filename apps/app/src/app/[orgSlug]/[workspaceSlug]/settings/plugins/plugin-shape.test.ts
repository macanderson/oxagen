import { describe, it, expect } from "vitest";
import {
  shapeInstalledPlugins,
  isCapabilityListing,
  type OrgListingRow,
} from "./plugin-shape";

function listing(over: Partial<OrgListingRow> = {}): OrgListingRow {
  return {
    id: "lst_1",
    name: "image-generation",
    title: "Image Generation",
    description: "Generate images",
    iconUrl: null,
    pluginType: "capability",
    authKind: "none",
    enabled: true,
    ...over,
  };
}

describe("isCapabilityListing", () => {
  it("is true only for the capability plugin type", () => {
    expect(isCapabilityListing("capability")).toBe(true);
    expect(isCapabilityListing("mcp_server")).toBe(false);
    expect(isCapabilityListing("integration")).toBe(false);
    expect(isCapabilityListing("content_tool")).toBe(false);
  });
});

describe("shapeInstalledPlugins", () => {
  it("shows capability packs with NO workspace install row (the reported bug)", () => {
    // Capability packs are org-level and never create an mcp.mcp_servers row.
    // They must still appear on the workspace tab.
    const out = shapeInstalledPlugins(
      [
        listing({ id: "cap_video", name: "video-generation", pluginType: "capability" }),
        listing({ id: "cap_image", name: "image-generation", pluginType: "capability" }),
      ],
      [], // no workspace install rows at all
    );
    expect(out.map((p) => p.id)).toEqual(["cap_video", "cap_image"]);
  });

  it("derives capability wsEnabled from the org-level enabled flag", () => {
    const out = shapeInstalledPlugins(
      [
        listing({ id: "cap_on", enabled: true }),
        listing({ id: "cap_off", enabled: false }),
      ],
      [],
    );
    expect(out.find((p) => p.id === "cap_on")?.wsEnabled).toBe(true);
    expect(out.find((p) => p.id === "cap_off")?.wsEnabled).toBe(false);
    // A disabled capability still SHOWS (so the toggle can re-enable it).
    expect(out.map((p) => p.id)).toEqual(["cap_on", "cap_off"]);
  });

  it("hides a workspace-level plugin that has no install row", () => {
    const out = shapeInstalledPlugins(
      [listing({ id: "mcp_1", pluginType: "mcp_server", enabled: true })],
      [],
    );
    expect(out).toEqual([]);
  });

  it("shows a workspace-level plugin only when it has an install row, using the row's enabled state", () => {
    const out = shapeInstalledPlugins(
      [listing({ id: "mcp_1", pluginType: "mcp_server", enabled: true })],
      [{ orgListingId: "mcp_1", enabled: false }],
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe("mcp_1");
    // ws install state drives the toggle for non-capability plugins.
    expect(out[0]?.wsEnabled).toBe(false);
  });

  it("hides an org-disabled workspace-level plugin even with an install row", () => {
    const out = shapeInstalledPlugins(
      [listing({ id: "mcp_1", pluginType: "mcp_server", enabled: false })],
      [{ orgListingId: "mcp_1", enabled: true }],
    );
    expect(out).toEqual([]);
  });

  it("does not let a capability's visibility depend on a ws row, but other types still need one", () => {
    const out = shapeInstalledPlugins(
      [
        listing({ id: "cap_1", pluginType: "capability", enabled: true }),
        listing({ id: "int_1", pluginType: "integration", enabled: true }),
      ],
      [{ orgListingId: "int_1", enabled: true }],
    );
    expect(out.map((p) => p.id).sort()).toEqual(["cap_1", "int_1"]);
  });

  it("ignores ws install rows with a null orgListingId", () => {
    const out = shapeInstalledPlugins(
      [listing({ id: "mcp_1", pluginType: "mcp_server", enabled: true })],
      [{ orgListingId: null, enabled: true }],
    );
    expect(out).toEqual([]);
  });
});
