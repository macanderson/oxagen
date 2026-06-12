import type { OxagenPluginManifest } from "../../manifest";

export const documentsManifest: OxagenPluginManifest = {
  id: "oxagen/documents",
  name: "Document Generation",
  description:
    "Generate rich documents and PDFs from structured content, templates, and AI-composed output.",
  version: "1.0.0",
  tier: "free",
  visibility: "ga",
  category: "documents",
  icon: "file-text",
  contracts: ["documents.generate", "documents.pdf.create"],
  scopes: [],
};
