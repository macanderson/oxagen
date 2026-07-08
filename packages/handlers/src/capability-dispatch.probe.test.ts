import { describe, it, expect } from "vitest";
import { hasHandler, getCapability, listCapabilities } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import "@oxagen/agent/register";

// A representative sample of OLD dotted (ADR-022) capability names that must no
// longer resolve now that names are snake_case and aliases are removed.
const OLD_DOTTED_NAMES = [
  "org.create",
  "plugin.org.set_enabled",
  "plugin.workspace.set_enabled",
  "chat.message.send",
  "agent.tool.list",
  "graph.ingest",
  "agent.code.execute",
  "agent.memory.recall",
  "connection.list",
  "workflow.run",
];

// Capabilities with NO kernel handler registration. These are PRE-EXISTING gaps
// (verified unregistered on origin/main, the working reverted baseline — the
// rename did NOT introduce them) or handler-less by design. Excluded from the
// hasHandler gate; the gate's job is to prove the dotted→snake realignment added
// zero NEW no_handler, not to fix long-standing wiring gaps.
const NO_HANDLER_OK = new Set<string>([
  "render_agent_ui", // agent.ui.render — client-mapped (generateObject), no server handler by design
  // Pre-existing gaps (no registerHandler on origin/main either):
  "upsert_graph_relationship", // graph.relationship.upsert — deprecation alias, no kernel handler
  "erase_data", // privacy.data.erase — handler file exists but never wired into register.ts
  "export_data", // privacy.data.export — handler file exists but never wired into register.ts
  "approve_semantic_relationship", // semantic.relationship.* — no handler file
  "infer_semantic_relationships",
  "list_semantic_relationships",
  "suggest_semantic_relationships",
]);

describe("ADR-025 naming realignment — dispatch probe", () => {
  const caps = listCapabilities();

  it("every snake capability resolves a handler (no no_handler)", () => {
    const noHandler: string[] = [];
    for (const cap of caps) {
      expect(getCapability(cap.name)).toBe(cap);
      if (NO_HANDLER_OK.has(cap.name)) continue;
      if (!hasHandler(cap.name)) noHandler.push(cap.name);
    }
    if (noHandler.length) console.log("MISSING HANDLERS:", noHandler.join(", "));
    expect(noHandler).toEqual([]);
  });

  it("every registered capability name is snake_case (no dots remain)", () => {
    const dotted = caps.map((c) => c.name).filter((n) => n.includes("."));
    if (dotted.length) console.log("DOTTED NAMES REGISTERED:", dotted.join(", "));
    expect(dotted).toEqual([]);
  });

  it("no OLD dotted capability name resolves (aliases gone, keys realigned)", () => {
    const leaked: string[] = [];
    for (const dotted of OLD_DOTTED_NAMES) {
      if (getCapability(dotted) !== undefined) leaked.push("getCapability:" + dotted);
      if (hasHandler(dotted)) leaked.push("hasHandler:" + dotted);
    }
    if (leaked.length) console.log("DOTTED LEAKS:", leaked.join(", "));
    expect(leaked).toEqual([]);
  });

  it("representative capabilities resolve contract + handler", () => {
    for (const name of ["create_org", "set_plugin_enabled", "send_message", "list_agent_tools", "ingest_graph"]) {
      expect(getCapability(name), `contract ${name}`).toBeDefined();
      expect(hasHandler(name), `handler ${name}`).toBe(true);
    }
  });
});
