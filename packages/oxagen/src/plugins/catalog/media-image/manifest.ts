import type { OxagenPluginManifest } from "../../manifest";

export const mediaImageManifest: OxagenPluginManifest = {
  id: "oxagen/media-image",
  name: "Image Generation",
  description:
    "Generate, create, analyze, and manage AI images within your workspace.",
  version: "1.0.0",
  pluginType: "agent_capability",
  tier: "free",
  visibility: "ga",
  category: "media",
  icon: "image-plus",
  color: "#6366f1",
  contracts: ["image.generate", "image.create", "image.analyze", "image.list"],
  scopes: [],
};
