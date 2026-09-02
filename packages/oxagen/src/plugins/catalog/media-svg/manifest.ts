import type { OxagenPluginManifest } from "../../manifest";

export const mediaSvgManifest: OxagenPluginManifest = {
  id: "oxagen/media-svg",
  name: "SVG Generation",
  description:
    "Generate scalable vector graphics from natural language descriptions.",
  version: "1.0.0",
  pluginType: "agent_capability",
  tier: "free",
  visibility: "ga",
  category: "media",
  icon: "pen-tool",
  color: "#0ea5e9",
  contracts: ["generate_svg"],
  scopes: [],
};
