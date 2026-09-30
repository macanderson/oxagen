// call.test.ts: a served tools/call from each source in each exposure mode,
// decided on the real tool, parked, refused, and metered (lane M15).
import type { CallToolResult, ManifestServer, RequestKind, ResolvedCredential } from "@oxagen/mcp-studio";
import type { PolicyFile } from "@oxagen/policy";
import { describe, expect, it } from "vitest";
import { callServed, sandboxOf } from "../call";
import type { Ranker, SearchEntry } from "../search";
import { ServedRouteError, type PublishedTools, type ServedRun, type ServedTransport } from "../types";
import {
  AGENT,
  DIGEST,
  HASH,
  NOW,
  OPERATOR,
  POLICIES,
  RELAY,
  SOURCES,
  fakePorts,
  published,
  run,
  server,
  sourceNamed,
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

/** A route whose Transport checks the call with check. The fake Senders never use the Transport. */
function refusingTransport(check: (credential: ResolvedCredential | null) => Promise<string | null>): ServedTransport {
  const unused = (): Promise<never> => Promise.reject(new Error("A fake Sender answers every call."));
  return { http: unused, grpc: unused, local: unused, refusal: check };
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

  it("resolves the credential for the sandbox and the run's operator", async () => {
    const { call, recorded } = await setup();
    await call("billing__list_charges");
    expect(recorded.credentials).toHaveLength(1);
    expect(recorded.credentials[0]).toMatchObject({ server: "billing", environment: "sandbox", operator: OPERATOR });
    expect(recorded.routes.map((route) => route.network)).toEqual(["cloud"]);
  });

  it("names no operator when the run's host records no enroller", async () => {
    const { call, recorded } = await setup({}, published(), run({ operator: undefined }));
    await call("billing__list_charges");
    expect(recorded.credentials).toHaveLength(1);
    expect(recorded.credentials[0]?.operator).toBeUndefined();
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

  it("sends an approved call and uses its approval", async () => {
    const { call, recorded } = await setup({ approval: () => Promise.resolve({ state: "approved", id: "apr_3", approvers: 1 }) });
    const result = await call("billing__create_refund", REFUND);
    expect(result?.isError).not.toBe(true);
    expectCarried(recorded, "http");
    expect(recorded.claims).toEqual([{ request: recorded.approvals[0], approvers: 1 }]);
    expect(recorded.requested).toEqual([]);
    // Read once, before the claim, and handed to the executor as read.
    expect(recorded.credentials).toHaveLength(1);
    expect(outcomes(recorded)).toEqual(["call billing__create_refund allowed"]);
  });

  it("does not send a call whose approval another call used first", async () => {
    const { call, recorded } = await setup({
      approval: () => Promise.resolve({ state: "approved", id: "apr_3", approvers: 1 }),
      claim: () => Promise.resolve(false),
    });
    const result = await call("billing__create_refund", REFUND);
    expect(textOf(result)).toBe(
      "Approval apr_3 no longer covers billing__create_refund, because another call used it or it expired. Oxagen did not send the call. Call the tool again with the same arguments to ask for a new approval.",
    );
    // The credential is read before the claim, so a lost claim still read it once.
    expect(recorded.credentials).toHaveLength(1);
    nothingSent(recorded);
    expect(outcomes(recorded)).toEqual(["call billing__create_refund failed"]);
  });

  it("fails a call when its approval cannot be used, and logs only the error's name", async () => {
    const { call, recorded } = await setup({
      approval: () => Promise.resolve({ state: "approved", id: "apr_3", approvers: 1 }),
      claim: () => Promise.reject(new Error("approval_requests for org_1 is locked")),
    });
    const result = await call("billing__create_refund", REFUND);
    expect(textOf(result)).toBe(
      "Oxagen could not use approval apr_3 for billing__create_refund, so it was not sent. Call it again in a minute.",
    );
    expect(recorded.logs).toEqual([
      {
        message: "Oxagen could not use the approval, so the call was not sent.",
        fields: { tool: "billing__create_refund", error: "Error" },
      },
    ]);
    // The credential is read before the claim, so a failed claim still read it once.
    expect(recorded.credentials).toHaveLength(1);
    nothingSent(recorded);
    expect(outcomes(recorded)).toEqual(["call billing__create_refund failed"]);
  });

  it("leaves an approval unused when the call cannot be sent", async () => {
    const version = published({
      servers: [
        server({
          ...sourceNamed("billing"),
          // Two environments and no sandbox: with one, that one is the sandbox.
          environments: {
            production: { sandbox: false, network: "cloud", credential: "oxagen:credential/billing-live" },
            staging: { sandbox: false, network: "cloud", credential: "oxagen:credential/billing-staging" },
          },
        }),
      ],
    });
    const { call, recorded } = await setup(
      { approval: () => Promise.resolve({ state: "approved", id: "apr_3", approvers: 1 }) },
      version,
    );
    const result = await call("billing__create_refund", REFUND);
    expect(textOf(result)).toContain("billing has no sandbox environment");
    expect(recorded.claims).toEqual([]);
    nothingSent(recorded);
  });

  it("leaves an approval unused when the route cannot take the call", async () => {
    const offline = "The machine that runs billing is offline. Start tacho on it, then call the tool again.";
    const { call, recorded } = await setup({
      approval: () => Promise.resolve({ state: "approved", id: "apr_3", approvers: 1 }),
      transport: () => {
        throw new ServedRouteError("local_unavailable", offline);
      },
    });
    const result = await call("billing__create_refund", REFUND);
    expect(textOf(result)).toBe(offline);
    expect(recorded.approvals).toHaveLength(1);
    expect(recorded.claims).toEqual([]);
    expect(recorded.credentials).toEqual([]);
    nothingSent(recorded);
    expect(outcomes(recorded)).toEqual(["call billing__create_refund failed"]);
  });

  it("leaves an approval unused when the route would refuse the call before sending it", async () => {
    const down =
      "Relay corp is not connected to Oxagen. Start the relay in your network, or read its logs for why it cannot connect.";
    const checked: Array<ResolvedCredential | null> = [];
    const { call, recorded } = await setup({
      approval: () => Promise.resolve({ state: "approved", id: "apr_3", approvers: 1 }),
      transport: () =>
        refusingTransport((credential) => {
          checked.push(credential);
          return Promise.resolve(down);
        }),
    });
    const result = await call("billing__create_refund", REFUND);
    expect(result?.isError).toBe(true);
    expect(textOf(result)).toBe(down);
    expect(recorded.approvals).toHaveLength(1);
    expect(recorded.claims).toEqual([]);
    // The route checks the credential runTool read, so it reads it only once.
    expect(recorded.credentials).toHaveLength(1);
    expect(checked).toEqual([{ type: "bearer", token: "tok_never_logged" }]);
    nothingSent(recorded);
    expect(outcomes(recorded)).toEqual(["call billing__create_refund failed"]);
  });

  it("claims the approval and sends when the route would take the call", async () => {
    let checks = 0;
    const { call, recorded } = await setup({
      approval: () => Promise.resolve({ state: "approved", id: "apr_3", approvers: 1 }),
      transport: () =>
        refusingTransport(() => {
          checks += 1;
          return Promise.resolve(null);
        }),
    });
    const result = await call("billing__create_refund", REFUND);
    expect(result?.isError).not.toBe(true);
    expect(checks).toBe(1);
    expect(recorded.claims).toEqual([{ request: recorded.approvals[0], approvers: 1 }]);
    expectCarried(recorded, "http");
    expect(outcomes(recorded)).toEqual(["call billing__create_refund allowed"]);
  });

  it("leaves an approval unused when the route check throws, and logs only the error's name", async () => {
    const { call, recorded } = await setup({
      approval: () => Promise.resolve({ state: "approved", id: "apr_3", approvers: 1 }),
      transport: () => refusingTransport(() => Promise.reject(new Error("broker holds tok_route_secret"))),
    });
    const result = await call("billing__create_refund", REFUND);
    expect(textOf(result)).toBe(
      "Oxagen could not check the route for billing__create_refund, so it did not send it. Call it again in a minute.",
    );
    expect(recorded.logs).toEqual([
      {
        message: "Oxagen could not check the route, so the call was not sent.",
        fields: { tool: "billing__create_refund", error: "Error" },
      },
    ]);
    expect(recorded.claims).toEqual([]);
    nothingSent(recorded);
    expect(outcomes(recorded)).toEqual(["call billing__create_refund failed"]);
  });

  it("does not ask the route before sending a call that needs no approval", async () => {
    let checks = 0;
    const { call, recorded } = await setup({
      transport: () =>
        refusingTransport(() => {
          checks += 1;
          return Promise.resolve("never asked");
        }),
    });
    const result = await call("billing__list_charges");
    expect(result?.isError).not.toBe(true);
    expect(checks).toBe(0);
    expectCarried(recorded, "http");
  });

  it("leaves an approval unused when the credential lookup fails", async () => {
    const { call, recorded } = await setup({
      approval: () => Promise.resolve({ state: "approved", id: "apr_3", approvers: 1 }),
      credential: () => Promise.reject(new Error("vault is down")),
    });
    const result = await call("billing__create_refund", REFUND);
    expect(textOf(result)).toBe(
      "Oxagen could not read the credential for billing, so it did not send billing__create_refund. Call it again in a minute, and ask a workspace admin to reconnect Billing if it fails again.",
    );
    expect(recorded.approvals).toHaveLength(1);
    expect(recorded.credentials).toHaveLength(1);
    expect(recorded.claims).toEqual([]);
    nothingSent(recorded);
    expect(outcomes(recorded)).toEqual(["call billing__create_refund failed"]);
  });

  it("leaves an approval unused when the arguments do not match the tool's input schema", async () => {
    const { call, recorded } = await setup({
      approval: () => Promise.resolve({ state: "approved", id: "apr_3", approvers: 1 }),
    });
    // create_refund requires charge. Cedar reads the amount and the rule
    // parks the call, so the schema is the only thing that refuses it.
    const result = await call("billing__create_refund", { amount: 100 });
    expect(result?.isError).toBe(true);
    expect(textOf(result)).toBe("The arguments do not match the tool's input schema. input.charge is required.");
    expect(recorded.approvals).toHaveLength(1);
    expect(recorded.claims).toEqual([]);
    expect(recorded.credentials).toEqual([]);
    nothingSent(recorded);
    expect(outcomes(recorded)).toEqual(["call billing__create_refund failed"]);
  });

  it("leaves an approval unused when the credential is not connected", async () => {
    const { call, recorded } = await setup({
      approval: () => Promise.resolve({ state: "approved", id: "apr_3", approvers: 1 }),
      credential: () =>
        Promise.resolve({
          type: "missing",
          message: "Connect your Billing account in Oxagen, then retry.",
          connect_url: "https://app.oxagen.sh/connect/billing",
        }),
    });
    const result = await call("billing__create_refund", REFUND);
    expect(textOf(result)).toBe("Connect your Billing account in Oxagen, then retry.\nhttps://app.oxagen.sh/connect/billing");
    expect(recorded.approvals).toHaveLength(1);
    expect(recorded.claims).toEqual([]);
    nothingSent(recorded);
    expect(outcomes(recorded)).toEqual(["call billing__create_refund failed"]);
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

/** A rule that asks this many people to approve a refund over $1,000, like payments.two-approvers. */
function approversRule(people: number): PolicyFile {
  return {
    path: "policy/approvals.cedar",
    text: `@id("refunds.${people}-approvers")
@decision("require_approval")
forbid (principal, action, resource)
when {
  context.tool.impacts.contains("moves_money") &&
  context.args has amount &&
  context.args.amount > 100000
}
unless { context.approval.granted && context.approval.approvers >= ${people} };`,
  };
}

/** The fixture policies with the approval rule replaced by one that asks for `people` approvers. */
function needsApprovers(people: number): PublishedTools {
  return published({
    policies: [approversRule(people), ...POLICIES.filter((file) => file.path !== "policy/approvals.cedar")],
  });
}

const LARGE_REFUND = { charge: "ch_1", amount: 245_000 };

function approvedBy(approvers: number): PortOptions {
  return { approval: () => Promise.resolve({ state: "approved", id: "apr_3", approvers }) };
}

describe("callServed approver counts", () => {
  it("parks the first call under a two-person rule like any approval", async () => {
    const { call, recorded } = await setup({}, needsApprovers(2));
    const result = await call("billing__create_refund", LARGE_REFUND);
    expect(textOf(result)).toBe(
      "billing__create_refund waits for a person's approval under refunds.2-approvers. Oxagen opened approval apr_1. Call the tool again with the same arguments once it is approved.",
    );
    expect(recorded.requested).toEqual([]);
    expect(recorded.claims).toEqual([]);
    nothingSent(recorded);
    expect(outcomes(recorded)).toEqual(["call billing__create_refund parked"]);
  });

  it("parks a call a two-person rule holds after one approval, and asks another person", async () => {
    const { call, recorded } = await setup(approvedBy(1), needsApprovers(2));
    const result = await call("billing__create_refund", LARGE_REFUND);
    expect(result?.isError).toBe(true);
    expect(textOf(result)).toBe(
      "billing__create_refund needs approval from another person under refunds.2-approvers. One person has approved it so far. Oxagen opened approval apr_4. Call the tool again with the same arguments once another person approves it.",
    );
    expect(recorded.requested).toEqual([{ ...recorded.approvals[0], reasons: ["refunds.2-approvers"] }]);
    expect(recorded.claims).toEqual([]);
    expect(recorded.credentials).toEqual([]);
    nothingSent(recorded);
    expect(outcomes(recorded)).toEqual(["call billing__create_refund parked"]);
  });

  it("sends a call a two-person rule holds once two people approved, and uses both approvals", async () => {
    const { call, recorded } = await setup(approvedBy(2), needsApprovers(2));
    const result = await call("billing__create_refund", LARGE_REFUND);
    expect(result?.isError).not.toBe(true);
    expectCarried(recorded, "http");
    expect(recorded.requested).toEqual([]);
    expect(recorded.claims).toEqual([{ request: recorded.approvals[0], approvers: 2 }]);
    expect(outcomes(recorded)).toEqual(["call billing__create_refund allowed"]);
  });

  it("does not send a call when fewer people answer for it at the claim than at the decision", async () => {
    const { call, recorded } = await setup({ ...approvedBy(2), claim: () => Promise.resolve(false) }, needsApprovers(2));
    const result = await call("billing__create_refund", LARGE_REFUND);
    expect(textOf(result)).toContain("Approval apr_3 no longer covers billing__create_refund");
    nothingSent(recorded);
    expect(outcomes(recorded)).toEqual(["call billing__create_refund failed"]);
  });

  it("counts the people so far when a rule asks for three", async () => {
    const { call } = await setup(approvedBy(2), needsApprovers(3));
    const result = await call("billing__create_refund", LARGE_REFUND);
    expect(textOf(result)).toContain("under refunds.3-approvers. 2 people have approved it so far. Oxagen opened approval apr_4.");
  });

  it("counts no person for an approval an automatic rule resolved", async () => {
    const { call } = await setup(approvedBy(0), needsApprovers(2));
    const result = await call("billing__create_refund", LARGE_REFUND);
    expect(textOf(result)).toContain("No person has approved it yet.");
  });

  it("sends a refund under the limit without asking anyone", async () => {
    const { call, recorded } = await setup({}, needsApprovers(2));
    const result = await call("billing__create_refund", REFUND);
    expect(result?.isError).not.toBe(true);
    expect(recorded.approvals).toEqual([]);
    expect(recorded.claims).toEqual([]);
    expect(outcomes(recorded)).toEqual(["call billing__create_refund allowed"]);
  });

  it("fails a call when another approval cannot be opened", async () => {
    const { call, recorded } = await setup(
      { ...approvedBy(1), another: () => Promise.reject(new Error("approvals table is locked")) },
      needsApprovers(2),
    );
    const result = await call("billing__create_refund", LARGE_REFUND);
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
});

describe("callServed kill switches", () => {
  const INCIDENT = "Refunds are paused during the incident.";
  /** A switch at each scope a served call carries. */
  const SCOPES: ReadonlyArray<{ targetKind: string; targetId: string; words: string }> = [
    { targetKind: "tool_version", targetId: "tov_1", words: "tool version" },
    { targetKind: "tool_server", targetId: "mcs_1", words: "tool server" },
    { targetKind: "connection", targetId: "mcc_1", words: "connection" },
    { targetKind: "operator", targetId: "usr_1", words: "operator" },
    { targetKind: "workspace", targetId: "ws_1", words: "workspace" },
    { targetKind: "org", targetId: "org_1", words: "org" },
    { targetKind: "class", targetId: "moves_money", words: "class" },
  ];

  for (const { targetKind, targetId, words } of SCOPES) {
    it(`refuses a call a ${words} switch stops, before any approval or credential`, async () => {
      const { call, recorded } = await setup({
        emergencyDeny: () => Promise.resolve({ id: "emd_1", targetKind, targetId, reason: INCIDENT }),
      });
      const result = await call("billing__create_refund", REFUND);
      expect(result?.isError).toBe(true);
      expect(textOf(result)).toBe(
        `Kill switch emd_1 on ${words} ${targetId} stops billing__create_refund, so Oxagen did not send it. Reason: Refunds are paused during the incident. Ask an admin to turn the switch off if the call must run.`,
      );
      expect(recorded.approvals).toEqual([]);
      expect(recorded.credentials).toEqual([]);
      expect(recorded.routes).toEqual([]);
      nothingSent(recorded);
      expect(outcomes(recorded)).toEqual(["call billing__create_refund denied"]);
    });
  }

  it("stops a call a person already approved, and leaves the approval unused", async () => {
    const { call, recorded } = await setup({
      approval: () => Promise.resolve({ state: "approved", id: "apr_3", approvers: 1 }),
      emergencyDeny: () => Promise.resolve({ id: "emd_1", targetKind: "tool_server", targetId: "mcs_1", reason: INCIDENT }),
    });
    const result = await call("billing__create_refund", REFUND);
    expect(textOf(result)).toBe(
      "Kill switch emd_1 on tool server mcs_1 stops billing__create_refund, so Oxagen did not send it. Reason: Refunds are paused during the incident. Ask an admin to turn the switch off if the call must run.",
    );
    expect(recorded.approvals).toEqual([]);
    expect(recorded.claims).toEqual([]);
    expect(recorded.requested).toEqual([]);
    expect(recorded.credentials).toEqual([]);
    nothingSent(recorded);
    expect(outcomes(recorded)).toEqual(["call billing__create_refund denied"]);
  });

  it("ends the reason with one period whether or not the person wrote one", async () => {
    const { call } = await setup({
      emergencyDeny: () => Promise.resolve({ id: "emd_2", targetKind: "org", targetId: "org_1", reason: "Audit in progress " }),
    });
    const result = await call("billing__list_charges");
    expect(textOf(result)).toContain("Reason: Audit in progress. Ask an admin");
  });

  it("names the server, the tool, the credential, and whether the tool only reads", async () => {
    const { call, recorded } = await setup({ approval: () => Promise.resolve({ state: "approved", id: "apr_3", approvers: 1 }) });
    await call("billing__list_charges");
    await call("billing__create_refund", REFUND);
    await call("stripe__list_customers");
    await call("files__read_file");
    expect(recorded.emergencyDenies).toEqual([
      { server: "billing", tool: "billing__list_charges", credential: "oxagen:credential/billing-sandbox", readOnly: true },
      { server: "billing", tool: "billing__create_refund", credential: "oxagen:credential/billing-sandbox", readOnly: false },
      { server: "stripe", tool: "stripe__list_customers", credential: null, readOnly: true },
      { server: "files", tool: "files__read_file", credential: null, readOnly: true },
    ]);
  });

  it("names no credential for a server with no sandbox environment", async () => {
    const version = published({
      servers: [
        server({
          ...sourceNamed("billing"),
          environments: {
            production: { sandbox: false, network: "cloud", credential: "oxagen:credential/billing-live" },
            staging: { sandbox: false, network: "cloud", credential: "oxagen:credential/billing-staging" },
          },
        }),
      ],
    });
    const { call, recorded } = await setup({}, version);
    await call("billing__list_charges");
    expect(recorded.emergencyDenies.map((checked) => checked.credential)).toEqual([null]);
  });

  it("names no credential for an operator-oauth server, so a connection switch does not reach it", async () => {
    const version = published({
      servers: [server({ ...sourceNamed("billing"), authMode: "operator-oauth" })],
    });
    const { call, recorded } = await setup({}, version);
    await call("billing__list_charges");
    // The environment still names oxagen:credential/billing-sandbox, but in
    // operator-oauth mode that reference is a preregistered OAuth client and
    // the call runs on the operator's own token, so it is not a connection.
    expect(recorded.emergencyDenies.map((checked) => checked.credential)).toEqual([null]);
  });

  it("still stops an operator-oauth call at every other scope", async () => {
    const version = published({
      servers: [server({ ...sourceNamed("billing"), authMode: "operator-oauth" })],
    });
    const { call, recorded } = await setup(
      { emergencyDeny: () => Promise.resolve({ id: "emd_1", targetKind: "operator", targetId: "usr_1", reason: INCIDENT }) },
      version,
    );
    const result = await call("billing__list_charges");
    expect(textOf(result)).toContain("Kill switch emd_1 on operator usr_1 stops billing__list_charges");
    nothingSent(recorded);
    expect(outcomes(recorded)).toEqual(["call billing__list_charges denied"]);
  });

  it("checks the tool a search-mode call names", async () => {
    const { call, recorded } = await setup(
      { emergencyDeny: () => Promise.resolve({ id: "emd_1", targetKind: "tool_server", targetId: "mcs_1", reason: INCIDENT }) },
      searchBilling(),
    );
    const result = await call("billing__call", { tool: "create_refund", arguments: REFUND });
    expect(textOf(result)).toContain("Kill switch emd_1 on tool server mcs_1 stops billing__create_refund");
    expect(recorded.emergencyDenies.map((checked) => checked.tool)).toEqual(["billing__create_refund"]);
    expect(recorded.approvals).toEqual([]);
    nothingSent(recorded);
    expect(outcomes(recorded)).toEqual(["call billing__create_refund denied"]);
  });

  it("does not check a call the off switches already refused", async () => {
    const { call, recorded } = await setup({ off: { servers: ["billing"] } });
    await call("billing__list_charges");
    expect(recorded.emergencyDenies).toEqual([]);
  });

  it("fails a call when the switches cannot be read, and logs only the error's name", async () => {
    const { call, recorded } = await setup({
      emergencyDeny: () => Promise.reject(new Error("emergency_denies for org_1 is locked")),
    });
    const result = await call("billing__create_refund", REFUND);
    expect(textOf(result)).toBe(
      "Oxagen could not check the kill switches for billing__create_refund, so it did not send the call. Call it again in a minute.",
    );
    expect(recorded.logs).toEqual([
      {
        message: "Oxagen could not read the kill switches, so the call was not sent.",
        fields: { tool: "billing__create_refund", error: "Error" },
      },
    ]);
    expect(recorded.approvals).toEqual([]);
    nothingSent(recorded);
    expect(outcomes(recorded)).toEqual(["call billing__create_refund failed"]);
  });
});

describe("callServed routes", () => {
  it("sends a relay route's call through the transport its network names", async () => {
    const version = published({ servers: [...SOURCES.map(server), server(RELAY)] });
    const { call, recorded } = await setup({}, version);
    const result = await call("corp__list_users");
    expect(result?.isError).not.toBe(true);
    expect(recorded.routes.map((route) => route.network)).toEqual(["relay:corp"]);
    expectCarried(recorded, "http");
    expect(outcomes(recorded)).toEqual(["call corp__list_users allowed"]);
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

describe("callServed agent feedback records (ADR-234)", () => {
  function problems(recorded: Recorded): string[] {
    return recorded.calls.map((c) => `${c.tool} ${c.outcome} ${c.problem ?? "none"}`);
  }

  it("records an allowed call with its server, run, and time, and no problem", async () => {
    const { call, recorded } = await setup();
    await call("billing__list_charges");
    expect(recorded.calls).toEqual([
      {
        server: "billing",
        tool: "billing__list_charges",
        outcome: "allowed",
        problem: null,
        run: run(),
        at: new Date(NOW),
      },
    ]);
  });

  it("records an error result when the tool answers with an error", async () => {
    const { call, recorded } = await setup({
      answer: () => ({
        ok: false,
        error: { title: "Upstream error", detail: "The upstream answered 502.", status: 502 },
        attempts: 1,
      }),
    });
    await call("billing__list_charges");
    expect(problems(recorded)).toEqual(["billing__list_charges failed error_result"]);
  });

  it("records a schema rejection when the input schema refuses the arguments", async () => {
    const { call, recorded } = await setup({
      approval: () => Promise.resolve({ state: "approved", id: "apr_3", approvers: 1 }),
    });
    await call("billing__create_refund", { amount: 100 });
    expect(problems(recorded)).toEqual(["billing__create_refund failed schema_rejected"]);
  });

  it("records a schema rejection when Cedar cannot read the arguments", async () => {
    const { call, recorded } = await setup();
    await call("billing__list_charges", { limit: "5" });
    expect(problems(recorded)).toEqual(["billing__list_charges denied schema_rejected"]);
  });

  it("records a policy denial, a parked call, and a missing credential with no problem", async () => {
    const { call, recorded } = await setup({
      credential: () =>
        Promise.resolve({
          type: "missing",
          message: "Connect your Billing account in Oxagen, then retry.",
          connect_url: "https://app.oxagen.sh/connect/billing",
        }),
    });
    await call("billing__list_charges", { limit: 500 });
    await call("billing__create_refund", REFUND);
    await call("billing__list_charges");
    expect(problems(recorded)).toEqual([
      "billing__list_charges denied none",
      "billing__create_refund parked none",
      "billing__list_charges failed none",
    ]);
  });

  it("records a schema rejection when call's arguments are not an object, and nothing for a call that names no tool", async () => {
    const { call, recorded } = await setup({}, searchBilling());
    await call("billing__call", { tool: "list_charges", arguments: [] });
    await call("billing__call", { tool: "nope" });
    await call("billing__call", { tool: "" });
    expect(problems(recorded)).toEqual(["billing__list_charges failed schema_rejected"]);
  });

  it("records a call through call as the tool it names", async () => {
    const { call, recorded } = await setup({}, searchBilling());
    await call("billing__call", { tool: "list_charges" });
    expect(recorded.calls.map((c) => [c.server, c.tool, c.outcome])).toEqual([
      ["billing", "billing__list_charges", "allowed"],
    ]);
  });

  it("records nothing for search and describe", async () => {
    const { call, recorded } = await setup({}, searchBilling());
    await call("billing__search", { query: "charges" });
    await call("billing__describe", { tool: "list_charges" });
    expect(recorded.calls).toEqual([]);
  });

  it("keeps a call's result when the record cannot be written", async () => {
    const { call, recorded } = await setup({ recordCall: () => Promise.reject(new Error("clickhouse is down")) });
    const result = await call("stripe__list_customers");
    expect(textOf(result)).toBe("mcp answered");
    expect(recorded.logs).toEqual([
      {
        message: "Oxagen could not record a served call for agent feedback. The call's result stands.",
        fields: { tool: "stripe__list_customers", outcome: "allowed", error: "Error" },
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
