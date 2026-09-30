// The Studio record read through get_studio_server (#4678, part 3). The
// server action is the only fake. Each case shows what the page gets: the
// folder mapped to the record, with each tool joined to its key's shaping,
// and no record for a server no steering repo defines or a refused read.
import type { ToolStudioServerGetOutput } from "@oxagen/oxagen/contracts/tool.studio.server.get";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { STRIPE, studioServer } from "./studio.builders";

const actions = vi.hoisted(() => ({ getStudioServerAction: vi.fn() }));
vi.mock("./actions", () => actions);
// The viewer module reads the session and the tenancy lookups; neither runs here.
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { readStudioRecord, toStudioRecord } = await import("./record-read");
const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");

const ctx = unsafeMint(WsCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "admin",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

const OUTPUT: ToolStudioServerGetOutput = {
  server: "stripe",
  mcpServerId: "mcs_01k5s1",
  snapshotId: "snap_2",
  capturedAt: "2026-09-29T10:00:00.000Z",
  exposure: { mode: "direct", budget: 8000 },
  tokens: { definitions: 64, budget: 8000 },
  imported: 1,
  offered: 2,
  searchRecommended: false,
  compileError: null,
  tools: [
    {
      name: "create_payment",
      key: "create_payment",
      state: "imported",
      description: "Create a payment.",
      importedDescription: "Charge a customer once, in cents.",
      inputSchema: { type: "object" },
      annotations: { destructiveHint: true, readOnlyHint: false },
      tokens: 64,
      classification: {
        risk: "high",
        sideEffect: "write",
        egress: "third_party",
        impacts: ["moves_money"],
        confirmed: true,
        basis: null,
      },
      snapshotId: "snap_1",
      capturedAt: "2026-09-29T10:00:00.000Z",
      withheld: false,
    },
    {
      name: "list_customers",
      key: null,
      state: "available",
      description: "List customers.",
      importedDescription: null,
      inputSchema: { type: "object" },
      annotations: null,
      tokens: 40,
      classification: {
        risk: "low",
        sideEffect: "read",
        egress: "third_party",
        impacts: [],
        confirmed: false,
        basis: "annotations",
      },
      snapshotId: "snap_2",
      capturedAt: "2026-09-29T10:00:00.000Z",
      withheld: false,
    },
  ],
  folder: "tools/servers/stripe",
  label: "Stripe",
  description: "Payments and refunds in the a-intel Stripe account.",
  source: {
    type: "remote",
    url: "https://mcp.stripe.com",
    transport: "http",
    network: null,
  },
  auth: { mode: "service", scheme: "oauth", credential: null },
  environments: [
    {
      name: "live",
      sandbox: false,
      url: null,
      network: null,
      credential: "oxagen:credential/stripe-live",
    },
  ],
  sync: { schedule: "daily", lastAt: "2026-09-29T10:00:30.000Z" },
  shaping: [
    {
      tool: "create_payment",
      hide: ["idempotency_key"],
      fixed: [{ name: "currency", value: '"usd"' }],
      select: ["id", "status"],
      selection: null,
    },
  ],
};

beforeEach(() => {
  actions.getStudioServerAction.mockReset();
});

describe("toStudioRecord", () => {
  it("maps the folder, with each imported tool joined to its shaping", () => {
    const record = toStudioRecord(OUTPUT);
    expect(record).toMatchObject({
      folder: "tools/servers/stripe",
      source: OUTPUT.source,
      auth: { mode: "service", scheme: "oauth", credential: null },
      environments: OUTPUT.environments,
      exposure: { mode: "direct", definitionBudget: 8000 },
      sync: { schedule: "daily", lastAt: "2026-09-29T10:00:30.000Z" },
    });
    expect(record.tools).toEqual([
      {
        name: "create_payment",
        imported: true,
        tokens: 64,
        serverDescription: "Create a payment.",
        annotations: ["destructiveHint"],
        classification: {
          risk: "high",
          sideEffect: "write",
          egress: "third_party",
          impacts: ["moves_money"],
          confirmed: true,
          basis: null,
        },
        description: "Charge a customer once, in cents.",
        shaping: {
          hide: ["idempotency_key"],
          fixed: [{ name: "currency", value: '"usd"' }],
          select: ["id", "status"],
          selection: null,
        },
        feedback: null,
      },
      {
        name: "list_customers",
        imported: false,
        tokens: 40,
        serverDescription: "List customers.",
        annotations: [],
        classification: {
          risk: "low",
          sideEffect: "read",
          egress: "third_party",
          impacts: [],
          confirmed: false,
          basis: "annotations",
        },
        description: null,
        shaping: null,
        feedback: null,
      },
    ]);
  });
});

describe("readStudioRecord", () => {
  it("reads the folder the registry row names, for the page's workspace", async () => {
    actions.getStudioServerAction.mockResolvedValue({ ok: true, value: OUTPUT });
    const record = await readStudioRecord(ctx, {
      ...studioServer(STRIPE),
      steeringName: "stripe",
    });
    expect(record?.folder).toBe("tools/servers/stripe");
    expect(actions.getStudioServerAction).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "stripe",
    );
  });

  it("reads nothing for a server no steering repo defines", async () => {
    const record = await readStudioRecord(ctx, {
      ...studioServer(STRIPE),
      steeringName: null,
    });
    expect(record).toBeNull();
    expect(actions.getStudioServerAction).not.toHaveBeenCalled();
  });

  it("answers no record when the read is refused", async () => {
    actions.getStudioServerAction.mockResolvedValue({
      ok: false,
      reason: "not_found",
      code: "mcp_server_not_found",
    });
    expect(
      await readStudioRecord(ctx, { ...studioServer(STRIPE), steeringName: "stripe" }),
    ).toBeNull();
  });
});
