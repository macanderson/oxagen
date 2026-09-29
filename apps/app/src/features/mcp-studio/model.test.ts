// How a Studio page joins the registry to the Studio record (#4678): which
// tools it lists, whose classification wins, which switch speaks for a
// target, which environment agents call, and the server's folder name.
import { describe, expect, it } from "vitest";
import type { KillSwitch, KillSwitchBoard } from "@/data/contracts/tools";
import { buildStudioView, sumTokens } from "./model";
import {
  BILLING,
  billingRecord,
  FLIPPER,
  GITHUB,
  offSwitch,
  SCRATCH,
  STRIPE,
  stripeRecord,
  studioBoard,
  studioServer,
  studioVersions,
  studioView,
  WAREHOUSE,
  WAREHOUSE_IMPORTED,
  WAREHOUSE_TOOLS,
} from "./studio.builders";

function toolOf(view: ReturnType<typeof studioView>, name: string) {
  const tool = view.tools.find((row) => row.name === name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return tool;
}

function killSwitch(over: Partial<KillSwitch>): KillSwitch {
  return {
    id: "emd_01k5x1",
    target: { kind: "tool_version", ref: "tlv_01k5a1" },
    scope: "workspace",
    on: false,
    reason: "Test switch.",
    flippedByRef: FLIPPER,
    flippedAt: "2026-09-01T09:00:00.000Z",
    clearedAt: "2026-09-02T09:00:00.000Z",
    clearedByRef: FLIPPER,
    ...over,
  };
}

function board(switches: KillSwitch[]): KillSwitchBoard {
  return {
    denyGeneration: { org: 1, workspace: 1 },
    switches,
    truncated: false,
  };
}

describe("buildStudioView", () => {
  it("lists the record's tools, imported first, then by name", () => {
    const view = studioView(STRIPE);
    expect(view.tools).toHaveLength(23);
    expect(view.tools.slice(0, 2).map((tool) => tool.name)).toEqual([
      "create_payment",
      "list_customers",
    ]);
    const offered = view.tools.slice(2);
    expect(offered.every((tool) => !tool.imported)).toBe(true);
    expect(offered.map((tool) => tool.name)).toEqual(
      offered.map((tool) => tool.name).sort((a, b) => a.localeCompare(b)),
    );
    expect(view.tools.some((tool) => tool.name === "get_file_contents")).toBe(
      false,
    );
  });

  it("joins a record row to its version and takes the version's classification", () => {
    const tool = toolOf(studioView(STRIPE), "create_payment");
    expect(tool).toMatchObject({
      imported: true,
      versionId: "tlv_01k5a1",
      version: 4,
      tokens: 412,
      description: "Charges a customer.",
      serverDescription: "Creates a PaymentIntent and confirms it.",
      classification: {
        risk: "critical",
        sideEffect: "irreversible",
        egress: "third_party",
        impacts: ["moves_money"],
        confirmed: true,
        basis: null,
      },
      killSwitch: null,
    });
  });

  it("keeps a record row with no version, and its own description", () => {
    const tool = toolOf(studioView(STRIPE), "list_customers");
    expect(tool).toMatchObject({
      imported: true,
      versionId: null,
      version: null,
      description: "Lists Stripe customers by email.",
      classification: { risk: "low", confirmed: true },
    });
  });

  it("lets the record's classification win over the version's", () => {
    const record = stripeRecord();
    const view = buildStudioView({
      server: studioServer(STRIPE),
      versions: studioVersions().items,
      board: null,
      record: {
        ...record,
        tools: record.tools.map((row) =>
          row.name === "create_payment"
            ? {
                ...row,
                classification: {
                  risk: "high",
                  sideEffect: "write",
                  egress: "third_party",
                  impacts: [],
                  confirmed: false,
                  basis: "annotations",
                },
              }
            : row,
        ),
      },
    });
    expect(toolOf(view, "create_payment").classification).toMatchObject({
      risk: "high",
      confirmed: false,
    });
  });

  it("lists a server with no record from its versions alone", () => {
    const view = studioView(GITHUB);
    expect(view.record).toBeNull();
    expect(view.serverName).toBeNull();
    expect(view.tools).toEqual([
      {
        name: "get_file_contents",
        imported: true,
        versionId: "tlv_01k5a2",
        version: 3,
        tokens: null,
        classification: null,
        description: null,
        serverDescription: null,
        annotations: [],
        shaping: null,
        feedback: null,
        killSwitch: null,
      },
    ]);
    expect(view.environments).toEqual([
      {
        name: "default",
        sandbox: false,
        url: "https://mcp.github.example/sse",
        network: null,
        credential: null,
      },
    ]);
    expect(view.agentEnvironment).toBe("default");
  });

  it("gives a server without environments one default at its endpoint", () => {
    const view = studioView(STRIPE);
    expect(view.serverName).toBe("stripe");
    expect(view.environments).toEqual([
      {
        name: "default",
        sandbox: false,
        url: "https://mcp.stripe.example/v1",
        network: null,
        credential: "oxagen:credential/stripe-restricted",
      },
    ]);
    expect(view.agentEnvironment).toBe("default");
  });

  it("sends agents to the one sandbox of several environments", () => {
    const view = studioView(BILLING);
    expect(view.environments.map((env) => env.name)).toEqual([
      "sandbox",
      "production",
    ]);
    expect(view.agentEnvironment).toBe("sandbox");
    expect(toolOf(view, "list_invoices").classification).toMatchObject({
      risk: "low",
      sideEffect: "read",
      egress: "org_tenant",
      confirmed: true,
    });
    expect(toolOf(view, "create_refund")).toMatchObject({
      imported: true,
      classification: null,
    });
    expect(toolOf(view, "void_invoice")).toMatchObject({
      imported: false,
      classification: { basis: "http_method", confirmed: false },
    });
  });

  it("names no agent environment when none or both are sandboxes", () => {
    const record = billingRecord();
    for (const sandbox of [false, true]) {
      const view = studioView(BILLING, {
        ...record,
        environments: record.environments.map((env) => ({ ...env, sandbox })),
      });
      expect(view.agentEnvironment).toBeNull();
    }
  });

  it("shows a server that offers no tools", () => {
    const view = studioView(SCRATCH);
    expect(view.tools).toEqual([]);
    expect(view.serverName).toBe("scratch");
  });

  it("joins the first registry page of a server with 600 tools", () => {
    const view = studioView(WAREHOUSE);
    expect(view.tools).toHaveLength(WAREHOUSE_TOOLS);
    const imported = view.tools.filter((tool) => tool.imported);
    expect(imported).toHaveLength(WAREHOUSE_IMPORTED);
    expect(toolOf(view, "tool_000").versionId).toBe("tlv_wh0");
    expect(toolOf(view, "tool_300")).toMatchObject({
      imported: true,
      versionId: null,
    });
    expect(sumTokens(imported)).toBe(10_000);
  });
});

describe("kill switches", () => {
  it("shows the switch that turned a tool or the server off", () => {
    const view = studioView(
      STRIPE,
      stripeRecord(),
      studioBoard([
        offSwitch("emd_01k5d1", "tool_version", "tlv_01k5a1"),
        offSwitch("emd_01k5d2", "tool_server", STRIPE),
      ]),
    );
    expect(toolOf(view, "create_payment").killSwitch).toMatchObject({
      id: "emd_01k5d1",
      on: true,
      flippedByRef: FLIPPER,
    });
    // The board also holds the Tools fixture's cleared server switch. The
    // one that denies speaks for the server.
    expect(view.killSwitch?.id).toBe("emd_01k5d2");
  });

  it("shows the newest cleared switch when none denies", () => {
    const view = studioView(
      STRIPE,
      stripeRecord(),
      board([
        killSwitch({ id: "emd_01k5e1", flippedAt: "2026-09-01T09:00:00.000Z" }),
        killSwitch({ id: "emd_01k5e2", flippedAt: "2026-09-20T09:00:00.000Z" }),
        killSwitch({ id: "emd_01k5e3", flippedAt: "2026-09-10T09:00:00.000Z" }),
      ]),
    );
    expect(toolOf(view, "create_payment").killSwitch?.id).toBe("emd_01k5e2");
    expect(view.killSwitch).toBeNull();
  });

  it("shows the Tools fixture's cleared server switch", () => {
    expect(studioView(STRIPE).killSwitch).toMatchObject({
      id: "emd_01k5c3",
      on: false,
    });
  });

  it("shows no switch when the board did not load", () => {
    const view = studioView(STRIPE, stripeRecord(), null);
    expect(view.killSwitch).toBeNull();
    expect(view.tools.every((tool) => tool.killSwitch === null)).toBe(true);
  });
});

describe("tool and server names", () => {
  it("reads the folder's last part, and refuses a name no draft can use", () => {
    const name = (folder: string) =>
      studioView(STRIPE, { ...stripeRecord(), folder }).serverName;
    expect(name("tools/servers/stripe/")).toBe("stripe");
    expect(name("tools/servers/Stripe")).toBeNull();
    expect(name("tools/servers/builtin")).toBeNull();
    expect(name(`tools/servers/${"a".repeat(25)}`)).toBeNull();
    expect(name("")).toBeNull();
  });

  it("names a tool by its capability, else by its slug", () => {
    const [stripe] = studioVersions().items;
    if (stripe === undefined) throw new Error("no Stripe version");
    const view = buildStudioView({
      server: studioServer(STRIPE),
      versions: [
        { ...stripe, id: "tlv_01k5f1", capability: "mcp.stripe.charges.create" },
        { ...stripe, id: "tlv_01k5f2", capability: "mcp.stripe", slug: "legacy" },
      ],
      board: null,
      record: null,
    });
    expect(view.tools.map((tool) => tool.name)).toEqual([
      "charges.create",
      "legacy",
    ]);
  });
});

describe("sumTokens", () => {
  it("sums measured tools and answers null once one is unmeasured", () => {
    expect(sumTokens([])).toBe(0);
    expect(sumTokens([{ tokens: 412 }, { tokens: 268 }])).toBe(680);
    expect(sumTokens([{ tokens: 412 }, { tokens: null }])).toBeNull();
  });
});
