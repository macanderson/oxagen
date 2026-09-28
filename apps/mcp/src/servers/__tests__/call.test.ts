// call.test.ts: a served tools/call from each source in each exposure mode,
// decided on the real tool, parked, refused, and metered (lane M15).
import type { CallToolResult, ManifestServer, RequestKind } from "@oxagen/mcp-studio";
import { describe, expect, it } from "vitest";
import { callServed, sandboxOf, unbuiltRoute } from "../call";
import type { Ranker, SearchEntry } from "../search";
import { ServedRouteError, type PublishedTools, type ServedRun } from "../types";
import {
  AGENT,
  DIGEST,
  HASH,
  NOW,
  RELAY,
  SOURCES,
  fakePorts,
  published,
  run,
  server,
  textOf,
  view,
  type PortOptions,
  type Recorded,
} from "./fixtures";

/** One tool from each source, and what carries a call to it. */
const EACH: ReadonlyArray<{ server: string; key: string; carrier: RequestKind | "local" }> = [
  { server: "billing", key: "list_charges", carrier: "http" },
  { server: "catalog", key: "list_products", carrier: "graphql" },
  { server: "ledger", key: "list_entries", carrier: "grpc" },
  { server: "stripe", key: "list_customers", carrier: "mcp" },
  { server: "github", key: "get_issue", carrier: "mcp" },
  { server: "files", key: "read_file", carrier: "local" },
];

const REFUND = { charge: "ch_1", amount: 100 };

/** SOURCES with billing in search mode. */
function searchBilling(): PublishedTools {
  return published({ servers: SOURCES.map((spec) => server(spec.name === "billing" ? { ...spec, mode: "search" } : spec)) });
}

async function setup(options: PortOptions = {}, version: PublishedTools = published(), served: ServedRun = run()) {
  const { ports, recorded } = fakePorts(options);
  const v = await view(version, ports, served);
  const call = (name: string, args: Record<string, unknown> = {}, rank?: Ranker): Promise<CallToolResult | null> =>
    callServed(v, ports, name, args, rank);
  return { v, ports, recorded, call };
}

function expectCarried(recorded: Recorded, carrier: RequestKind | "local"): void {
  if (carrier === "local") {
    expect(recorded.local).toHaveLength(1);
    expect(recorded.sent).toEqual([]);
  } else {
    expect(recorded.sent.map((sent) => sent.kind)).toEqual([carrier]);
    expect(recorded.local).toEqual([]);
  }
}

function outcomes(recorded: Recorded): string[] {
  return recorded.meter.map((event) => `${event.kind} ${event.tool} ${event.outcome}`);
}

function nothingSent(recorded: Recorded): void {
  expect(recorded.sent).toEqual([]);
  expect(recorded.local).toEqual([]);
}

describe("callServed in direct mode", () => {
  for (const { server: name, key, carrier } of EACH) {
    it(`calls ${name}__${key} over ${carrier}`, async () => {
      const { call, recorded } = await setup();
      const result = await call(`${name}__${key}`);
      expect(result?.isError).not.toBe(true);
      expectCarried(recorded, carrier);
      expect(outcomes(recorded)).toEqual([`call ${name}__${key} allowed`]);
    });
  }

  it("resolves the credential for the sandbox and the agent's operator", async () => {
    const { call, recorded } = await setup();
    await call("billing__list_charges");
    expect(recorded.credentials).toHaveLength(1);
    expect(recorded.credentials[0]).toMatchObject({ server: "billing", environment: "sandbox", operator: "priya" });
    expect(recorded.routes.map((route) => route.network)).toEqual(["cloud"]);
  });

  it("sends a local server's call to the machine with its locked version", async () => {
    const { call, recorded } = await setup();
    const result = await call("files__read_file");
    expect(textOf(result)).toBe("local answered");
    expect(recorded.local[0]).toMatchObject({
      tool: "files__read_file",
      upstream: "read_file",
      version: 1,
      definition_hash: HASH,
      package_digest: DIGEST,
    });
    expect(recorded.routes.map((route) => route.network)).toEqual(["local"]);
    expect(recorded.credentials).toEqual([]);
  });

  it("answers an MCP server's call with its content", async () => {
    const { call } = await setup();
    expect(textOf(await call("stripe__list_customers"))).toBe("mcp answered");
  });

  it("meters each call with the agent, the run, and the time", async () => {
    const { call, recorded } = await setup();
    await call("billing__list_charges");
    expect(recorded.meter).toEqual([
      {
        id: "act_1",
        kind: "call",
        tool: "billing__list_charges",
        server: "billing",
        outcome: "allowed",
        agent: AGENT.name,
        run: run(),
        at: new Date(NOW),
      },
    ]);
  });

  it("gives each governed action its own id, even in one request", async () => {
    const { call, recorded } = await setup();
    await call("billing__list_charges");
    await call("billing__list_charges");
    expect(recorded.meter.map((event) => [event.id, event.run.requestId])).toEqual([
      ["act_1", "req_1"],
      ["act_2", "req_1"],
    ]);
  });

  it("decides with the operator's role when Oxagen knows it", async () => {
    const { call, recorded } = await setup({}, published(), run({ operatorRole: "admin" }));
    const result = await call("billing__list_charges");
    expect(result?.isError).not.toBe(true);
    expect(outcomes(recorded)).toEqual(["call billing__list_charges allowed"]);
  });

  it("leaves a name no published server holds to Oxagen's own tools", async () => {
    const { call, recorded } = await setup();
    expect(await call("oxagen_list_runs")).toBeNull();
    expect(await call("billing__nope")).toBeNull();
    expect(recorded.meter).toEqual([]);
  });
});

describe("callServed policy decisions", () => {
  it("denies a call a policy forbids and names the policy", async () => {
    const { call, recorded } = await setup();
    const result = await call("billing__list_charges", { limit: 500 });
    expect(result?.isError).toBe(true);
    expect(textOf(result)).toBe(
      "The policy charges.limit denied billing__list_charges for aintel.finops.release-bot. Ask a workspace admin to change it in a steering PR if this call is needed.",
    );
    nothingSent(recorded);
    expect(outcomes(recorded)).toEqual(["call billing__list_charges denied"]);
  });

  it("denies a call whose arguments Cedar cannot read", async () => {
    const { call, recorded } = await setup();
    const result = await call("billing__list_charges", { limit: "5" });
    expect(textOf(result)).toBe(
      "Oxagen could not decide billing__list_charges: Argument limit is not a Long. Check the arguments against the tool's input schema, then call it again.",
    );
    nothingSent(recorded);
    expect(outcomes(recorded)).toEqual(["call billing__list_charges denied"]);
  });

  it("denies a tool a policy hides", async () => {
    const { call, recorded } = await setup();
    const result = await call("billing__delete_customer");
    expect(textOf(result)).toBe(
      "The workspace's policies do not let aintel.finops.release-bot call billing__delete_customer, so Oxagen denied the call. Ask a workspace admin to permit it in a steering PR if this agent needs it.",
    );
    nothingSent(recorded);
    expect(outcomes(recorded)).toEqual(["call billing__delete_customer denied"]);
  });

  it("parks a call a rule sends for approval", async () => {
    const { call, recorded } = await setup();
    const result = await call("billing__create_refund", REFUND);
    expect(result?.isError).toBe(true);
    expect(textOf(result)).toBe(
      "billing__create_refund waits for a person's approval under irreversible.approval. Oxagen opened approval apr_1. Call the tool again with the same arguments once it is approved.",
    );
    expect(recorded.approvals).toEqual([
      {
        run: run(),
        agent: AGENT,
        tool: "billing__create_refund",
        version: 1,
        publication: { repository: "finops-steering", version: 1 },
        server: "billing",
        args: REFUND,
        reasons: ["irreversible.approval"],
        risk: "high",
      },
    ]);
    nothingSent(recorded);
    expect(outcomes(recorded)).toEqual(["call billing__create_refund parked"]);
  });

  it("sends an approved call", async () => {
    const { call, recorded } = await setup({ approval: () => Promise.resolve({ state: "approved", id: "apr_3" }) });
    const result = await call("billing__create_refund", REFUND);
    expect(result?.isError).not.toBe(true);
    expectCarried(recorded, "http");
    expect(outcomes(recorded)).toEqual(["call billing__create_refund allowed"]);
  });

  it("denies a call a person refused", async () => {
    const { call, recorded } = await setup({ approval: () => Promise.resolve({ state: "refused", id: "apr_2" }) });
    const result = await call("billing__create_refund", REFUND);
    expect(textOf(result)).toBe("A person refused billing__create_refund under approval apr_2, so it was not sent.");
    nothingSent(recorded);
    expect(outcomes(recorded)).toEqual(["call billing__create_refund denied"]);
  });

  it("fails a call when the approval cannot be opened", async () => {
    const { call, recorded } = await setup({ approval: () => Promise.reject(new Error("approvals table is locked")) });
    const result = await call("billing__create_refund", REFUND);
    expect(textOf(result)).toBe(
      "Oxagen could not open an approval for billing__create_refund, so it was not sent. Call it again in a minute.",
    );
    expect(recorded.logs).toEqual([
      {
        message: "Oxagen could not open an approval, so the call was not sent.",
        fields: { tool: "billing__create_refund", error: "Error" },
      },
    ]);
    nothingSent(recorded);
    expect(outcomes(recorded)).toEqual(["call billing__create_refund failed"]);
  });

  it("denies every call when the policies cannot be loaded", async () => {
    const { call, recorded } = await setup({ cedar: () => Promise.resolve(null) });
    const result = await call("billing__list_charges");
    expect(textOf(result)).toBe(
      "Oxagen could not load the workspace's policies, so it denied billing__list_charges. If a steering PR changed the policies, fix them and publish again. Otherwise call the tool again in a minute.",
    );
    nothingSent(recorded);
    expect(outcomes(recorded)).toEqual(["call billing__list_charges denied"]);
  });

  it("denies every call for a host that matches no agent", async () => {
    const { call, recorded } = await setup({}, published(), run({ runtime: "laptop-9" }));
    const result = await call("billing__list_charges");
    expect(textOf(result)).toBe(
      "Oxagen matched no agent to this run, so it serves no tool and did not send billing__list_charges. Add an agent file for runtime laptop-9 to the steering record and publish it.",
    );
    nothingSent(recorded);
    expect(recorded.meter.map((event) => [event.outcome, event.agent])).toEqual([["denied", null]]);
  });
});

describe("callServed billing admission", () => {
  it("asks billing once for each governed action, with the run", async () => {
    const { call, recorded } = await setup();
    await call("billing__list_charges");
    expect(recorded.admitted).toEqual([run()]);
  });

  it("refuses a call when the organization has no units left, before any approval, and meters nothing", async () => {
    const { call, recorded } = await setup({ admit: () => Promise.resolve({ admitted: false, reason: "units_exhausted" }) });
    const result = await call("billing__create_refund", REFUND);
    expect(result?.isError).toBe(true);
    expect(textOf(result)).toBe(
      "The organization has no governed actions left this period, so Oxagen did not send billing__create_refund. Ask an organization admin to add units in Billing.",
    );
    expect(recorded.approvals).toEqual([]);
    expect(recorded.credentials).toEqual([]);
    nothingSent(recorded);
    expect(recorded.meter).toEqual([]);
  });

  it("refuses a call when the free month is used and no card is saved", async () => {
    const { call, recorded } = await setup({ admit: () => Promise.resolve({ admitted: false, reason: "no_payment_method" }) });
    const result = await call("billing__list_charges");
    expect(textOf(result)).toBe(
      "The organization used this month's free governed actions, so Oxagen did not send billing__list_charges. Ask an organization admin to add a payment method in Billing.",
    );
    nothingSent(recorded);
    expect(recorded.meter).toEqual([]);
  });

  it("refuses a call when billing is suspended", async () => {
    const { call, recorded } = await setup({ admit: () => Promise.resolve({ admitted: false, reason: "suspended" }) });
    const result = await call("stripe__list_customers");
    expect(textOf(result)).toBe(
      "Billing is suspended for the organization, so Oxagen did not send stripe__list_customers. Ask an organization admin to pay the open invoice in Billing.",
    );
    nothingSent(recorded);
    expect(recorded.meter).toEqual([]);
  });

  it("sends nothing when billing cannot be read, and logs only the error's name", async () => {
    const { call, recorded } = await setup({ admit: () => Promise.reject(new Error("billing settings row for org_1 is locked")) });
    const result = await call("billing__list_charges");
    expect(textOf(result)).toBe("Oxagen could not check billing for billing__list_charges, so it was not sent. Call it again in a minute.");
    expect(recorded.logs).toEqual([
      {
        message: "Oxagen could not read the organization's billing, so the call was not sent.",
        fields: { tool: "billing__list_charges", error: "Error" },
      },
    ]);
    nothingSent(recorded);
    expect(recorded.meter).toEqual([]);
  });

  it("refuses a search-mode search when billing refuses it", async () => {
    const { call, recorded } = await setup(
      { admit: () => Promise.resolve({ admitted: false, reason: "units_exhausted" }) },
      searchBilling(),
    );
    const result = await call("billing__search", { query: "refund" });
    expect(result?.isError).toBe(true);
    expect(recorded.meter).toEqual([]);
  });

  it("leaves a name no published server holds to Oxagen's own tools without asking billing", async () => {
    const { call, recorded } = await setup();
    expect(await call("oxagen_list_runs")).toBeNull();
    expect(recorded.admitted).toEqual([]);
  });
});

describe("callServed off switches", () => {
  it("refuses a call to a server that is switched off", async () => {
    const { call, recorded } = await setup({ off: { servers: ["billing"] } });
    const result = await call("billing__list_charges");
    expect(textOf(result)).toBe(
      "billing is switched off in Oxagen, so billing__list_charges was not sent. Ask a workspace admin to switch it on.",
    );
    nothingSent(recorded);
    expect(outcomes(recorded)).toEqual(["call billing__list_charges denied"]);
  });

  it("refuses a call to a tool that is switched off", async () => {
    const { call, recorded } = await setup({ off: { tools: ["billing__list_charges"] } });
    const result = await call("billing__list_charges");
    expect(textOf(result)).toBe(
      "billing__list_charges is switched off in Oxagen, so it was not sent. Ask a workspace admin to switch it on.",
    );
    nothingSent(recorded);
    expect(outcomes(recorded)).toEqual(["call billing__list_charges denied"]);
  });

  it("refuses a call to a withheld tool", async () => {
    const { call, recorded } = await setup({ withheld: ["billing__list_charges"] });
    const result = await call("billing__list_charges");
    expect(textOf(result)).toBe("Oxagen withholds billing__list_charges from every agent, so it was not sent.");
    nothingSent(recorded);
    expect(outcomes(recorded)).toEqual(["call billing__list_charges denied"]);
  });
});

describe("callServed routes", () => {
  it("refuses a relay route with a typed error and sends nothing", async () => {
    const version = published({ servers: [...SOURCES.map(server), server(RELAY)] });
    const { call, recorded } = await setup({}, version);
    const result = await call("corp__list_users");
    expect(result?.isError).toBe(true);
    expect(textOf(result)).toBe(
      "Oxagen cannot send calls over relay:corp yet, so it sent nothing. Ask a workspace admin to give the server a cloud or local sandbox environment.",
    );
    expect(recorded.routes).toEqual([]);
    nothingSent(recorded);
    expect(outcomes(recorded)).toEqual(["call corp__list_users failed"]);
  });

  it("names the relay route error by its code", () => {
    const error = unbuiltRoute("relay:corp");
    expect(error).toBeInstanceOf(ServedRouteError);
    expect(error?.code).toBe("relay_not_built");
    expect(unbuiltRoute("cloud")).toBeNull();
    expect(unbuiltRoute("local")).toBeNull();
  });

  it("answers with the route's own error when the machine cannot take the call", async () => {
    const offline = "The machine that runs files is offline. Start tacho on it, then call the tool again.";
    const { call, recorded } = await setup({
      transport: () => {
        throw new ServedRouteError("local_unavailable", offline);
      },
    });
    const result = await call("files__read_file");
    expect(result?.isError).toBe(true);
    expect(textOf(result)).toBe(offline);
    nothingSent(recorded);
    expect(outcomes(recorded)).toEqual(["call files__read_file failed"]);
  });

  it("fails a call when the route lookup throws, and logs only the error's name", async () => {
    const { call, recorded } = await setup({
      transport: () => {
        throw new Error("route table holds tok_route_secret");
      },
    });
    const result = await call("billing__list_charges");
    expect(textOf(result)).toBe(
      "Oxagen could not send billing__list_charges because of an internal error. Call it again in a minute.",
    );
    expect(recorded.logs).toEqual([
      { message: "A served call failed before it was sent.", fields: { tool: "billing__list_charges", error: "Error" } },
    ]);
    expect(JSON.stringify(recorded.logs)).not.toContain("tok_route_secret");
    expect(outcomes(recorded)).toEqual(["call billing__list_charges failed"]);
  });

  it("fails a call to a server with no sandbox environment", async () => {
    const vault = server({
      name: "vault",
      source: "openapi",
      environments: { live: { sandbox: false, network: "cloud" }, staging: { sandbox: false, network: "cloud" } },
      tools: [{ key: "read_secret", description: "Read one secret." }],
    });
    const { call, recorded } = await setup({}, published({ servers: [...SOURCES.map(server), vault] }));
    const result = await call("vault__read_secret");
    expect(textOf(result)).toBe(
      "vault has no sandbox environment, so Oxagen cannot send vault__read_secret. Ask a workspace admin to mark one environment as the sandbox.",
    );
    nothingSent(recorded);
    expect(outcomes(recorded)).toEqual(["call vault__read_secret failed"]);
  });
});

describe("sandboxOf", () => {
  function withEnvironments(environments: Record<string, { sandbox: boolean; network: string }>): ManifestServer {
    return server({ name: "vault", source: "openapi", environments, tools: [] });
  }

  it("picks the sandbox", () => {
    const picked = sandboxOf(
      withEnvironments({ live: { sandbox: false, network: "cloud" }, test: { sandbox: true, network: "relay:corp" } }),
    );
    expect(picked).toEqual({ name: "test", network: "relay:corp" });
  });

  it("picks the first sandbox by name when there are several", () => {
    const picked = sandboxOf(
      withEnvironments({ zeta: { sandbox: true, network: "cloud" }, alpha: { sandbox: true, network: "local" } }),
    );
    expect(picked).toEqual({ name: "alpha", network: "local" });
  });

  it("picks the only environment when none is the sandbox", () => {
    expect(sandboxOf(withEnvironments({ live: { sandbox: false, network: "cloud" } }))).toEqual({
      name: "live",
      network: "cloud",
    });
  });

  it("picks nothing from several environments with no sandbox", () => {
    const picked = sandboxOf(
      withEnvironments({ live: { sandbox: false, network: "cloud" }, staging: { sandbox: false, network: "cloud" } }),
    );
    expect(picked).toBeNull();
  });
});

describe("callServed upstream failures", () => {
  it("fails a call the upstream answers with an error", async () => {
    const { call, recorded } = await setup({
      answer: () => ({
        ok: false,
        error: { title: "Upstream error", detail: "The upstream answered 502.", status: 502 },
        attempts: 1,
      }),
    });
    const result = await call("billing__list_charges");
    expect(result?.isError).toBe(true);
    expect(textOf(result)).toContain("The upstream answered 502.");
    expect(outcomes(recorded)).toEqual(["call billing__list_charges failed"]);
  });

  it("fails a call whose credential is not connected and says where to connect it", async () => {
    const { call, recorded } = await setup({
      credential: () =>
        Promise.resolve({
          type: "missing",
          message: "Connect your Billing account in Oxagen, then retry.",
          connect_url: "https://app.oxagen.sh/connect/billing",
        }),
    });
    const result = await call("billing__list_charges");
    expect(result?.isError).toBe(true);
    expect(textOf(result)).toContain("Connect your Billing account in Oxagen, then retry.");
    expect(textOf(result)).toContain("https://app.oxagen.sh/connect/billing");
    expect(recorded.sent).toEqual([]);
    expect(outcomes(recorded)).toEqual(["call billing__list_charges failed"]);
  });

  it("fails a call when the credential lookup throws, and never logs the secret", async () => {
    const { call, recorded } = await setup({
      credential: () => Promise.reject(new Error("vault answered with tok_live_secret")),
    });
    const result = await call("billing__list_charges");
    expect(textOf(result)).toBe(
      "Oxagen could not read the credential for billing, so it did not send billing__list_charges. Call it again in a minute, and ask a workspace admin to reconnect Billing if it fails again.",
    );
    expect(recorded.logs).toEqual([
      {
        message: "The credential lookup failed, so the call was not sent.",
        fields: { tool: "billing__list_charges", error: "Error" },
      },
    ]);
    expect(JSON.stringify(recorded.logs)).not.toContain("tok_live_secret");
    expect(textOf(result)).not.toContain("tok_live_secret");
    expect(recorded.sent).toEqual([]);
    expect(outcomes(recorded)).toEqual(["call billing__list_charges failed"]);
  });

  it("keeps a call's result when the meter cannot record it", async () => {
    const { call, recorded } = await setup({ meter: () => Promise.reject(new Error("clickhouse is down")) });
    const result = await call("stripe__list_customers");
    expect(textOf(result)).toBe("mcp answered");
    expect(recorded.logs).toEqual([
      {
        message: "Oxagen could not record a governed action. The call's result stands.",
        fields: { kind: "call", tool: "stripe__list_customers", outcome: "allowed", error: "Error" },
      },
    ]);
  });
});

describe("callServed in search mode", () => {
  const everySearch = published({ servers: SOURCES.map((spec) => server({ ...spec, mode: "search" })) });

  for (const { server: name, key, carrier } of EACH) {
    it(`calls ${key} through ${name}__call over ${carrier}`, async () => {
      const { call, recorded } = await setup({}, everySearch);
      const result = await call(`${name}__call`, { tool: key, arguments: {} });
      expect(result?.isError).not.toBe(true);
      expectCarried(recorded, carrier);
      expect(outcomes(recorded)).toEqual([`call ${name}__${key} allowed`]);
    });
  }

  it("takes the full name and no arguments in call", async () => {
    const { call, recorded } = await setup({}, searchBilling());
    const result = await call("billing__call", { tool: "billing__list_charges" });
    expect(result?.isError).not.toBe(true);
    expectCarried(recorded, "http");
  });

  it("decides call as the tool it names", async () => {
    const { call, recorded } = await setup({}, searchBilling());
    const denied = await call("billing__call", { tool: "list_charges", arguments: { limit: 500 } });
    expect(textOf(denied)).toContain("The policy charges.limit denied billing__list_charges");
    const hidden = await call("billing__call", { tool: "delete_customer" });
    expect(textOf(hidden)).toContain("do not let aintel.finops.release-bot call billing__delete_customer");
    const parked = await call("billing__call", { tool: "create_refund", arguments: REFUND });
    expect(textOf(parked)).toContain("waits for a person's approval under irreversible.approval");
    nothingSent(recorded);
    expect(outcomes(recorded)).toEqual([
      "call billing__list_charges denied",
      "call billing__delete_customer denied",
      "call billing__create_refund parked",
    ]);
  });

  it("fails call for a tool the server does not have", async () => {
    const { call, recorded } = await setup({}, searchBilling());
    const result = await call("billing__call", { tool: "nope" });
    expect(textOf(result)).toBe("billing serves no tool named nope. Call billing__search to find one.");
    expect(outcomes(recorded)).toEqual(["call billing__call failed"]);
  });

  it("fails call with no tool", async () => {
    const { call, recorded } = await setup({}, searchBilling());
    const result = await call("billing__call", { tool: "" });
    expect(textOf(result)).toBe("call needs a tool. Pass the tool's name in tool.");
    nothingSent(recorded);
    expect(outcomes(recorded)).toEqual(["call billing__call failed"]);
  });

  it("fails call when arguments is not an object", async () => {
    const { call, recorded } = await setup({}, searchBilling());
    const result = await call("billing__call", { tool: "list_charges", arguments: [] });
    expect(textOf(result)).toBe("arguments is an object of the tool's input. Call billing__describe for its schema.");
    nothingSent(recorded);
    expect(outcomes(recorded)).toEqual(["call billing__list_charges failed"]);
  });
});

describe("search", () => {
  it("finds a served tool by keyword", async () => {
    const { call, recorded } = await setup({}, searchBilling());
    const result = await call("billing__search", { query: "refund" });
    expect(textOf(result)).toBe(
      "create_refund   Refund a charge to the card it was paid with.   irreversible, high",
    );
    expect(outcomes(recorded)).toEqual(["search billing__search allowed"]);
    expect(recorded.meter[0]?.server).toBe("billing");
  });

  it("returns at most limit lines, best first", async () => {
    const { call } = await setup({}, searchBilling());
    const result = await call("billing__search", { query: "charge", limit: 1 });
    expect(textOf(result)).toBe("list_charges   List the charges on the account.   read, low");
  });

  it("finds nothing a policy hides", async () => {
    const { call, recorded } = await setup({}, searchBilling());
    const result = await call("billing__search", { query: "customer" });
    expect(result?.isError).not.toBe(true);
    expect(textOf(result)).toBe('No billing tool matches "customer". Search again with other words.');
    expect(outcomes(recorded)).toEqual(["search billing__search allowed"]);
  });

  it("ranks with the ranker it is given, over the served tools only", async () => {
    let seen: string[] = [];
    const reverse: Ranker = (_query, entries) => {
      seen = entries.map((entry) => entry.short);
      return Promise.resolve([...entries].reverse());
    };
    const { call } = await setup({}, searchBilling());
    const result = await call("billing__search", { query: "anything" }, reverse);
    expect(seen).toEqual(["create_refund", "list_charges"]);
    expect(textOf(result).split("\n").map((line) => line.split(" ")[0])).toEqual(["list_charges", "create_refund"]);
  });

  it("falls back to keyword ranking when the ranker fails", async () => {
    const broken: Ranker = (): Promise<readonly SearchEntry[]> => Promise.reject(new Error("index is down"));
    const { call, recorded } = await setup({}, searchBilling());
    const result = await call("billing__search", { query: "refund" }, broken);
    expect(textOf(result)).toBe(
      "create_refund   Refund a charge to the card it was paid with.   irreversible, high",
    );
    expect(recorded.logs).toEqual([
      { message: "The search index failed, so search ranked by keyword.", fields: { server: "billing", error: "Error" } },
    ]);
    expect(outcomes(recorded)).toEqual(["search billing__search allowed"]);
  });

  it("fails a search with a limit over 10", async () => {
    const { call, recorded } = await setup({}, searchBilling());
    const result = await call("billing__search", { query: "charge", limit: 11 });
    expect(result?.isError).toBe(true);
    expect(textOf(result)).toBe("limit is a whole number from 1 to 10. Pass a smaller limit, or leave it out.");
    expect(outcomes(recorded)).toEqual(["search billing__search failed"]);
  });

  it("fails a search with no query", async () => {
    const { call, recorded } = await setup({}, searchBilling());
    const result = await call("billing__search", {});
    expect(textOf(result)).toBe("search needs a query. Pass the words to look for in query.");
    expect(outcomes(recorded)).toEqual(["search billing__search failed"]);
  });
});

describe("describe", () => {
  const LIST_CHARGES = {
    name: "billing__list_charges",
    description: "List the charges on the account. Newest first.",
    input_schema: { type: "object", properties: { limit: { type: "integer" } } },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  };

  it("describes a served tool by its short name", async () => {
    const { call, recorded } = await setup({}, searchBilling());
    const result = await call("billing__describe", { tool: "list_charges" });
    expect(result?.structuredContent).toEqual(LIST_CHARGES);
    expect(outcomes(recorded)).toEqual(["describe billing__describe allowed"]);
  });

  it("describes a served tool by its full name", async () => {
    const { call } = await setup({}, searchBilling());
    const result = await call("billing__describe", { tool: "billing__list_charges" });
    expect(result?.structuredContent).toEqual(LIST_CHARGES);
  });

  it("does not describe a tool a policy hides", async () => {
    const { call, recorded } = await setup({}, searchBilling());
    const result = await call("billing__describe", { tool: "delete_customer" });
    expect(result?.isError).toBe(true);
    expect(textOf(result)).toBe("billing serves no tool named delete_customer. Call billing__search to find one.");
    expect(outcomes(recorded)).toEqual(["describe billing__describe failed"]);
  });

  it("fails describe with no tool", async () => {
    const { call, recorded } = await setup({}, searchBilling());
    const result = await call("billing__describe", {});
    expect(result?.isError).toBe(true);
    expect(textOf(result)).toBe("describe needs a tool. Pass the tool's name in tool.");
    expect(outcomes(recorded)).toEqual(["describe billing__describe failed"]);
  });
});

describe("a search-mode server's tools by full name", () => {
  it("still answers a direct call to a served tool", async () => {
    const { call, recorded } = await setup({}, searchBilling());
    const result = await call("billing__list_charges");
    expect(result?.isError).not.toBe(true);
    expect(outcomes(recorded)).toEqual(["call billing__list_charges allowed"]);
  });
});
