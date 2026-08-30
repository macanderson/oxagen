/**
 * Extensibility seam: Integration (ontology-graph ingestion) and Content-tool
 * (Google Drive / Workspace / Microsoft Excel) verticals are first-class plugin
 * types in the marketplace + governance now, but their deep runtimes are
 * separate Linear epics. They register here as contributors that yield no tools
 * yet — deepening them later means filling in contributeTools only; the spine,
 * governance, and runtime wrapping never change.
 */
import { registerPluginType } from "../plugin-type";

registerPluginType({ type: "integration", contributeTools: async () => [] });
registerPluginType({
  type: "knowledge_source",
  contributeTools: async () => [],
});
