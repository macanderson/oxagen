import type { OxagenPluginManifest } from "../../manifest";

export const mediaSvgManifest: OxagenPluginManifest = {
  id: "oxagen/media-svg",
  name: "SVG Generation",
  description: "Generate scalable vector graphics from natural language descriptions.",
  version: "1.0.0",
  tier: "free",
  visibility: "ga",
  category: "media",
  icon: "shapes",
  contracts: ["svg.generate"],
  scopes: [],
};
