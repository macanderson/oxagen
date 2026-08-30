import type { OxagenPluginManifest } from "../../manifest";

export const mediaVideoManifest: OxagenPluginManifest = {
  id: "oxagen/media-video",
  name: "Video Generation",
  description:
    "Generate videos from text prompts and images using state-of-the-art AI models.",
  version: "1.0.0",
  pluginType: "agent_capability",
  tier: "free",
  visibility: "ga",
  category: "media",
  icon: "video",
  color: "#f59e0b",
  contracts: ["generate_video"],
  scopes: [],
};
