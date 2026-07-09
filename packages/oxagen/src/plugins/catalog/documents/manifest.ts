import type { OxagenPluginManifest } from "../../manifest";

export const documentsManifest: OxagenPluginManifest = {
  id: "oxagen/documents",
  name: "Document Generation",
  description:
    "Generate rich documents and PDFs from structured content, templates, and AI-composed output.",
  version: "1.0.0",
  pluginType: "agent_capability",
  tier: "free",
  visibility: "ga",
  category: "documents",
  icon: "notebook-pen",
  color: "#10b981",
  contracts: [
    "generate_document",
    "create_pdf",
    "generate_markdown",
    "generate_mermaid",
  ],
  scopes: [],
};
