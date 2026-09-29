// list.test.ts: which tools a run lists, and with which annotations (lane M15).
import { SearchIndex, SearchIndexError, type Embedder } from "@oxagen/mcp-studio";
import { requireCedarRuntime, type PolicyFile } from "@oxagen/policy";
import { describe, expect, it } from "vitest";
import { callServed } from "../call";
import { servedRanker } from "../embeddings";
import { listServed } from "../list";
import { ServedCache, compileDecider, matchAgent } from "../snapshot";
import {
  AGENT,
  POLICIES,
  REVIEWER,
  SOURCES,
  fakePorts,
  published,
  run,
  server,
  sourceNamed,
  textOf,
  view,
} from "./fixtures";

/** What AGENT is served from SOURCES: every tool but the one customers.never hides. */
const SERVED = [
  "billing__create_refund",
  "billing__list_charges",
  "catalog__list_products",
  "files__read_file",
  "github__get_issue",
  "ledger__list_entries",
  "stripe__list_customers",
];

const NO_CATALOG_FOR_REVIEWER: PolicyFile = {
  path: "policy/reviewer.cedar",
  text: `@id("reviewer.no-catalog")
forbid (principal == Agent::"aintel.finops.reviewer", action == Action::"catalog__list_products", resource);`,
};

const BAD_GRANT: PolicyFile = {
  path: "policy/bad.cedar",
  text: `@id("grant.x")
permit (principal, action, resource);`,
};

function names(list: readonly { name: string }[]): string[] {
  return list.map((entry) => entry.name);
}

describe("listServed", () => {
  it("lists every served tool for the run's agent in a stable order", async () => {
    const v = await view();
    expect(v.agent).toEqual(AGENT);
    expect(names(listServed(v))).toEqual(SERVED);
  });

  it("drops a tool a policy forbids outright", async () => {
    const v = await view();
    expect(v.visible.has("billing__delete_customer")).toBe(false);
    expect(names(listServed(v))).not.toContain("billing__delete_customer");
  });

  it("takes the annotations from the classification, not the upstream", async () => {
    const billing = sourceNamed("billing");
    const lying = server({
      ...billing,
      tools: billing.tools.map((spec) =>
        spec.key === "list_charges"
          ? { ...spec, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } }
          : spec,
      ),
    });
    const list = listServed(await view(published({ servers: [lying] })));
    const byName = new Map(list.map((entry) => [entry.name, entry.annotations]));
    expect(byName.get("billing__list_charges")).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });
    expect(byName.get("billing__create_refund")).toEqual({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
  });

  it("drops every tool of a server that is switched off", async () => {
    const { ports } = fakePorts({ off: { servers: ["billing"] } });
    const list = names(listServed(await view(published(), ports)));
    expect(list).toEqual(SERVED.filter((name) => !name.startsWith("billing__")));
  });

  it("drops a tool that is switched off", async () => {
    const { ports } = fakePorts({ off: { tools: ["catalog__list_products"] } });
    const list = names(listServed(await view(published(), ports)));
    expect(list).toEqual(SERVED.filter((name) => name !== "catalog__list_products"));
  });

  it("drops a withheld tool", async () => {
    const { ports } = fakePorts({ withheld: ["github__get_issue"] });
    const list = names(listServed(await view(published(), ports)));
    expect(list).toEqual(SERVED.filter((name) => name !== "github__get_issue"));
  });

  it("lists nothing, and reads no port, for a host that matches no agent", async () => {
    let reads = 0;
    const { ports } = fakePorts({
      cedar: () => {
        reads += 1;
        return requireCedarRuntime();
      },
    });
    const v = await view(published(), ports, run({ runtime: "laptop-9" }));
    expect(v.agent).toBeNull();
    expect(listServed(v)).toEqual([]);
    expect(reads).toBe(0);
  });

  it("lists nothing when two agents share the runtime and the session names no harness", async () => {
    const v = await view(published(), fakePorts().ports, run({ harness: null }));
    expect(v.agent).toBeNull();
    expect(listServed(v)).toEqual([]);
  });

  it("lists nothing when no agent on the runtime uses the session's harness", async () => {
    const v = await view(published(), fakePorts().ports, run({ harness: "cursor" }));
    expect(v.agent).toBeNull();
    expect(listServed(v)).toEqual([]);
  });

  it("serves the one agent on a runtime whatever harness the session reports", async () => {
    const v = await view(published({ agents: [AGENT] }), fakePorts().ports, run({ harness: null }));
    expect(v.agent).toEqual(AGENT);
    expect(names(listServed(v))).toEqual(SERVED);
  });

  it("picks the agent by harness when several share the runtime", async () => {
    const v = await view(published(), fakePorts().ports, run({ harness: "codex" }));
    expect(v.agent).toEqual(REVIEWER);
    expect(names(listServed(v))).toEqual(SERVED);
  });

  it("runs the visibility test for each agent", async () => {
    const policies = [...POLICIES, NO_CATALOG_FOR_REVIEWER];
    const cache = new ServedCache();
    const reviewer = await view(published({ policies }), fakePorts().ports, run({ harness: "codex" }), cache);
    const releaseBot = await view(published({ policies }), fakePorts().ports, run(), cache);
    expect(names(listServed(reviewer))).toEqual(SERVED.filter((name) => name !== "catalog__list_products"));
    expect(names(listServed(releaseBot))).toEqual(SERVED);
  });

  it("serves the operator's role to the visibility test", async () => {
    const v = await view(published(), fakePorts().ports, run({ operatorRole: "admin" }));
    expect(names(listServed(v))).toEqual(SERVED);
  });

  it("lists nothing when no version is published", async () => {
    const v = await view(null);
    expect(v.agent).toBeNull();
    expect(listServed(v)).toEqual([]);
  });

  it("lists nothing when the steering record imports no server", async () => {
    const v = await view({ ...published(), manifest: null });
    expect(v.agent).toEqual(AGENT);
    expect(listServed(v)).toEqual([]);
  });

  it("lists nothing and says why when Cedar's evaluator is not installed", async () => {
    const { ports, recorded } = fakePorts({ cedar: () => Promise.resolve(null) });
    const v = await view(published(), ports);
    expect(v.decider).toBeNull();
    expect(listServed(v)).toEqual([]);
    expect(recorded.logs.map((line) => line.message)).toEqual([
      "Cedar's evaluator is not installed, so the gateway serves no tool and denies every call.",
    ]);
  });

  it("lists nothing and says why when the policies do not compile", async () => {
    const { ports, recorded } = fakePorts();
    const v = await view(published({ policies: [...POLICIES, BAD_GRANT] }), ports);
    expect(v.decider).toBeNull();
    expect(listServed(v)).toEqual([]);
    expect(recorded.logs).toEqual([
      {
        message: "The published policies did not compile, so the gateway serves no tool and denies every call.",
        fields: expect.objectContaining({ version: 1 }),
      },
    ]);
  });

  it("serves the grant alone when the steering record has no policies", async () => {
    const v = await view(published({ policies: null }));
    expect(names(listServed(v))).toEqual([...SERVED, "billing__delete_customer"].sort());
  });

  it("orders by server name, then by tool name, whatever order the manifest holds", async () => {
    const servers = [...SOURCES].reverse().map((spec) => server({ ...spec, tools: [...spec.tools].reverse() }));
    expect(names(listServed(await view(published({ servers }))))).toEqual(SERVED);
  });
});

describe("listServed in search mode", () => {
  const searchBilling = server({ ...sourceNamed("billing"), mode: "search" });
  const catalog = server(sourceNamed("catalog"));

  it("lists search, describe, and call in place of the server's tools", async () => {
    const list = listServed(await view(published({ servers: [searchBilling, catalog] })));
    expect(names(list)).toEqual(["billing__search", "billing__describe", "billing__call", "catalog__list_products"]);
    const byName = new Map(list.map((entry) => [entry.name, entry.annotations]));
    expect(byName.get("billing__search")).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    expect(byName.get("billing__call")).toEqual({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
  });

  it("marks call destructive only when a tool it can reach is", async () => {
    const { ports } = fakePorts({ withheld: ["billing__create_refund"] });
    const list = listServed(await view(published({ servers: [searchBilling, catalog] }), ports));
    const call = list.find((entry) => entry.name === "billing__call");
    expect(call?.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
  });

  it("lists a search-mode server in full while its embedder throws", async () => {
    let embeds = 0;
    const failing: Embedder = {
      key: "k".repeat(32),
      embed: () => {
        embeds += 1;
        return Promise.reject(new SearchIndexError("unreachable", "The embeddings endpoint answered HTTP 503.", 503));
      },
    };
    const index = new SearchIndex({
      embedder: failing,
      store: { read: () => Promise.resolve([]), write: () => Promise.resolve() },
      namespace: "ws_1",
    });
    const { ports, recorded } = fakePorts();
    const ranked = { ...ports, rank: servedRanker("ws_1", () => Promise.resolve(index)) };
    const v = await view(published({ servers: [searchBilling, catalog] }), ranked);

    expect(names(listServed(v))).toEqual(["billing__search", "billing__describe", "billing__call", "catalog__list_products"]);
    expect(embeds).toBe(0);
    expect(recorded.logs).toEqual([]);

    // The same ports fail a search's ranking, so the listing above ran beside a live failure.
    const searched = await callServed(v, ranked, "billing__search", { query: "refund" });
    expect(textOf(searched)).toContain("create_refund");
    expect(embeds).toBeGreaterThan(0);
    expect(recorded.logs).toEqual([
      expect.objectContaining({ message: "The search index failed, so search ranked by keyword." }),
    ]);
  });

  it("lists no search tools for a server that serves no tool", async () => {
    const { ports } = fakePorts({ off: { tools: ["billing__create_refund", "billing__list_charges"] } });
    const list = listServed(await view(published({ servers: [searchBilling, catalog] }), ports));
    expect(names(list)).toEqual(["catalog__list_products"]);
  });
});

describe("ServedCache", () => {
  it("compiles a version once and runs the visibility test once for each agent", async () => {
    const cache = new ServedCache();
    const first = await view(published(), fakePorts().ports, run(), cache);
    const second = await view(published(), fakePorts().ports, run({ requestId: "req_2" }), cache);
    expect(second.decider).not.toBeNull();
    expect(second.decider).toBe(first.decider);
    expect(second.visible).toBe(first.visible);
  });

  it("compiles a new version again", async () => {
    const cache = new ServedCache();
    const first = await view(published(), fakePorts().ports, run(), cache);
    const second = await view(published({ version: 2 }), fakePorts().ports, run(), cache);
    expect(second.decider).not.toBe(first.decider);
    expect(second.visible).not.toBe(first.visible);
  });

  it("logs a version that does not compile once", async () => {
    const cache = new ServedCache();
    const { ports, recorded } = fakePorts();
    const version = published({ policies: [...POLICIES, BAD_GRANT] });
    await view(version, ports, run(), cache);
    await view(version, ports, run({ requestId: "req_2" }), cache);
    expect(recorded.logs).toHaveLength(1);
  });

  it("drops the oldest version past its limit", async () => {
    const cache = new ServedCache(1);
    const first = await view(published(), fakePorts().ports, run(), cache);
    await view(published({ version: 2 }), fakePorts().ports, run(), cache);
    const again = await view(published(), fakePorts().ports, run(), cache);
    expect(again.decider).not.toBe(first.decider);
    expect(names(listServed(again))).toEqual(SERVED);
  });
});

describe("matchAgent", () => {
  it("matches no agent on a runtime no agent names", () => {
    expect(matchAgent([AGENT, REVIEWER], "laptop-9", "claude-code")).toBeNull();
  });

  it("matches no agent when two on the runtime share the harness", () => {
    expect(matchAgent([AGENT, { ...AGENT, name: "aintel.finops.twin" }], "ci-linux-01", "claude-code")).toBeNull();
  });
});

describe("compileDecider", () => {
  it("says which arguments Cedar cannot read", async () => {
    const runtime = await requireCedarRuntime();
    const { ports, recorded } = fakePorts();
    const priced = server({
      name: "shop",
      source: "openapi",
      tools: [{ key: "set_price", description: "Set a product's price.", side_effect: "write", properties: { price: { type: "number" } } }],
    });
    // POLICIES name billing's tools, and strict mode refuses an action the manifest lacks.
    const decider = compileDecider(published({ servers: [priced], policies: null }), runtime, ports.log);
    expect(decider).not.toBeNull();
    expect(recorded.logs).toEqual([
      {
        message: "Cedar cannot read some imported tools or arguments. A skipped tool is hidden and every call to it is denied.",
        fields: expect.objectContaining({ version: 1 }),
      },
    ]);
  });
});
