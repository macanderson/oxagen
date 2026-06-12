import type { OxagenPluginManifest } from "../../manifest";

export const mediaVideoManifest: OxagenPluginManifest = {
  id: "oxagen/media-video",
  name: "Video Generation",
  description: "Generate videos from text prompts and images using state-of-the-art AI models.",
  version: "1.0.0",
  tier: "premium",
  visibility: "ga",
  category: "media",
  icon: "clapperboard",
  contracts: ["video.generate"],
  scopes: [],
};
