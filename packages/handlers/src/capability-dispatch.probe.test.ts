import { describe, it, expect } from "vitest";
import { hasHandler, getCapability, listCapabilities } from "@oxagen/oxagen";
import {
  agentHandlerNames,
  resolveHandler as agentResolveHandler,
} from "@oxagen/agent";
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
  "agent.memory.recall",
  "connection.list",
  "audit.log.query",
];

// Capabilities with NO kernel handler registration, excluded from the hasHandler
// gate. This set is intentionally EMPTY: the last handler-less family
// (upsert_graph_relationship + semantic.relationship.*) was deleted outright —
// contracts, API routes, and MCP tools — so every registered capability now
// resolves a real handler. Do NOT re-add an entry here to paper over a missing
// handler; wire the handler (or delete the capability) instead.
const NO_HANDLER_OK = new Set<string>([]);

describe("ADR-025 naming realignment — dispatch probe", () => {
  const caps = listCapabilities();

  it("every snake capability resolves a handler (no no_handler)", () => {
    const noHandler: string[] = [];
    for (const cap of caps) {
      expect(getCapability(cap.name)).toBe(cap);
      if (NO_HANDLER_OK.has(cap.name)) continue;
      if (!hasHandler(cap.name)) noHandler.push(cap.name);
    }
    if (noHandler.length)
      console.log("MISSING HANDLERS:", noHandler.join(", "));
    expect(noHandler).toEqual([]);
  });

  it("every registered capability name is snake_case (no dots remain)", () => {
    const dotted = caps.map((c) => c.name).filter((n) => n.includes("."));
    if (dotted.length)
      console.log("DOTTED NAMES REGISTERED:", dotted.join(", "));
    expect(dotted).toEqual([]);
  });

  it("no OLD dotted capability name resolves (aliases gone, keys realigned)", () => {
    const leaked: string[] = [];
    for (const dotted of OLD_DOTTED_NAMES) {
      if (getCapability(dotted) !== undefined)
        leaked.push("getCapability:" + dotted);
      if (hasHandler(dotted)) leaked.push("hasHandler:" + dotted);
    }
    if (leaked.length) console.log("DOTTED LEAKS:", leaked.join(", "));
    expect(leaked).toEqual([]);
  });

  it("representative capabilities resolve contract + handler", () => {
    for (const name of [
      "create_org",
      "set_plugin_enabled",
      "send_message",
      "list_agent_tools",
      "search_graph",
    ]) {
      expect(getCapability(name), `contract ${name}`).toBeDefined();
      expect(hasHandler(name), `handler ${name}`).toBe(true);
    }
  });

  // ACTUAL DISPATCH (not just registration): drive the agent package's real
  // resolveHandler, which loads the handler MODULE by its snake key and returns
  // the concrete handler function. A dotted key here would throw "No handler
  // registered". The list is NOT hand-maintained: it is every name in
  // @oxagen/agent's LOADERS map, so a capability added to that package is
  // dispatch-probed the moment it is registered. A hand-list is what let
  // get_assistant_engine ship unresolvable — its module exported two `*Handler`
  // functions, which the unique-`*Handler` fallback in resolveHandler refuses,
  // so every call threw and no test noticed.
  it.each(agentHandlerNames)(
    "agent handler loader actually loads a function for %s (real dispatch)",
    async (name) => {
      const fn = await agentResolveHandler(name);
      expect(typeof fn, `resolved handler for ${name}`).toBe("function");
    },
    // The first lazy import() cold-starts the module-graph transform; on a
    // loaded CI runner that can exceed vitest's 5s default.
    30_000,
  );
});
