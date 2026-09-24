// @vitest-environment jsdom
// Fleet's spend tiles in each state: today's spend with its basis and the cache
// hit rate, a day the rollup has not priced, a day with no input tokens, and a
// read that failed. axe checks the state each test ends in (INV-26).
import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FleetSpend } from "@/data/contracts/spend";
import type { DataSource } from "@/data/ports";
import { type Read, readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import messages from "../../../messages/spend.json";

vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { FleetSpendTiles } = await import("./fleet-tiles");

const ctx = unsafeMint(WsCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "member",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

const TODAY = new Date("2026-09-15T12:00:00.000Z");
const DAY = { from: "2026-09-15", to: "2026-09-15" };

const fleet = vi.fn<DataSource["spend"]["fleet"]>();
const refuse = () => Promise.reject(new Error("not a Fleet spend read"));
const source: DataSource = {
  pretenant: { orgs: refuse, workspaces: refuse },
  shell: { context: refuse, preferences: refuse },
  billing: {
    plan: refuse,
    usageCredits: refuse,
    bucket: refuse,
    contractRate: refuse,
    invoices: refuse,
  },
  runs: {
    list: refuse,
    get: refuse,
    frameBody: refuse,
    cost: refuse,
    transcript: refuse,
    chain: refuse,
    outputs: refuse,
  },
  approvals: { pending: refuse, resolved: refuse },
  agents: {
    list: refuse,
    get: refuse,
    toolbelt: refuse,
    incidents: refuse,
  },
  spend: {
    byGroup: refuse,
    fleet,
    drill: refuse,
    waste: refuse,
    gatewayPolicy: refuse,
    budgets: refuse,
    findings: refuse,
    findingEvidence: refuse,
    priceBook: refuse,
    unpricedModels: refuse,
  },
  onboarding: { state: refuse, firstFrame: refuse },
  org: {
    members: refuse,
    roles: refuse,
    workspaces: refuse,
    apiKeys: refuse,
    costCenters: refuse,
    modelCredential: refuse,
    dataPlane: refuse,
    sso: refuse,
  },
  mandates: { list: refuse, get: refuse },
  audit: {
    events: refuse,
    exportEvents: refuse,
    retention: refuse,
    bundle: refuse,
  },
  skills: { inventory: refuse, configuration: refuse },
  steering: {
    records: refuse,
    record: refuse,
    proposals: refuse,
    contextPr: refuse,
    freshness: refuse,
    deliveries: refuse,
  },
  tools: {
    versions: refuse,
    grants: refuse,
    killSwitches: refuse,
    approvalRules: refuse,
    connections: refuse,
    mcpServers: refuse,
  },
};

function spend(over: Partial<FleetSpend> = {}): Read<FleetSpend> {
  return readOk({
    period: DAY,
    spend: { micros: "41300000", currency: "USD", basis: "gateway_observed" },
    cacheHitRate: 0.81,
    ...over,
  });
}

async function renderTiles() {
  const element = await FleetSpendTiles({ ctx, source, today: TODAY });
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <main>{element}</main>
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  fleet.mockReset();
});

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("Fleet spend tiles", () => {
  it("reads today's spend and prints it with its basis beside the cache hit rate", async () => {
    fleet.mockResolvedValue(spend());
    await renderTiles();
    expect(fleet).toHaveBeenCalledExactlyOnceWith(ctx, DAY);
    const today = screen.getByText("Spend today").closest("div");
    expect(today).toHaveTextContent("$41.30");
    expect(today).toHaveTextContent("gateway observed");
    const cache = screen.getByText("Cache hit rate").closest("div");
    expect(cache).toHaveTextContent("81%");
    expect(cache).toHaveTextContent(
      "cache_read ÷ (input_uncached + cache_read)",
    );
  });

  it("prints a day the rollup has not priced, and a day with no input tokens, as not recorded, never as a zero", async () => {
    fleet.mockResolvedValue(spend({ spend: null, cacheHitRate: null }));
    await renderTiles();
    const tiles = screen.getByTestId("fleet-spend");
    expect(tiles.querySelector("[data-testid=money]")).toBeNull();
    expect(screen.getAllByText("not recorded")).toHaveLength(2);
    expect(tiles).not.toHaveTextContent("$0.00");
    expect(tiles).not.toHaveTextContent("0%");
  });

  it.each([
    ["denied", { ok: false, reason: "denied", permission: "spend.read" }],
    ["error", readError("rollup_rebuild_in_progress", 504)],
  ] as const)(
    "draws no tile when the read is %s (negative)",
    async (_state, read) => {
      fleet.mockResolvedValue(read);
      await renderTiles();
      expect(screen.queryByTestId("fleet-spend")).toBeNull();
      expect(screen.queryByText("Spend today")).toBeNull();
    },
  );
});
