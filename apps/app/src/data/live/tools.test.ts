// The four Tools ports: one kernel read each on the Tools page's failure row,
// mapped into the page's view models, with a refusal passed through and an
// unmappable record reported once.
import { approvalRuleList } from "@oxagen/oxagen/contracts/approval_rule.list";
import { credentialGrantList } from "@oxagen/oxagen/contracts/credential.grant.list";
import { killSwitchList } from "@oxagen/oxagen/contracts/kill_switch.list";
import { toolVersionList } from "@oxagen/oxagen/contracts/tool.version.list";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KILL_SWITCH_BOARD_LIMIT } from "@/data/contracts/tools";
import {
  approvalRuleListOutput,
  credentialGrantListOutput,
  killSwitchListOutput,
  toolVersionListOutput,
} from "@/test/tools-outputs";

const { kernelRead, captureError } = vi.hoisted(() => ({
  kernelRead: vi.fn(),
  captureError: vi.fn(),
}));
vi.mock("@/server/kernel", () => ({ kernelRead }));
vi.mock("@oxagen/telemetry", () => ({ captureError }));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { readError, readOk } = await import("@/data/read");
const { tools } = await import("./tools");

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

beforeEach(() => {
  kernelRead.mockReset();
  captureError.mockReset();
});

describe("tools.versions", () => {
  const firstPage = { category: null, cursor: null, serverId: null };

  it("reads the first page on the tools failure row and maps the classification the view shows", async () => {
    kernelRead.mockResolvedValue(readOk(toolVersionListOutput()));
    const read = await tools.versions(ctx, firstPage);
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: toolVersionList,
      input: {},
      page: "tools",
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const [financial, plain] = read.value.items;
    expect(financial?.capability).toBe("mcp.stripe.create_payment");
    expect(financial?.gate).toEqual({
      kind: "killed_class",
      switchId: "emd_01k5c1",
    });
    expect(financial?.classification?.measures).toEqual([
      {
        name: "amount",
        path: "$.amount",
        type: "money",
        currencyPath: "$.currency",
        unit: null,
      },
    ]);
    // A count the store did not answer stays null; it is never a zero.
    expect(plain?.calls30d).toBeNull();
    expect(plain?.classification).toBeNull();
  });

  it("carries the consequence tag, the server, and the cursor the view asked for", async () => {
    kernelRead.mockResolvedValue(readOk(toolVersionListOutput()));
    await tools.versions(ctx, {
      category: "moves_money",
      cursor: "c2",
      serverId: "mcs_stripe",
    });
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: toolVersionList,
      input: { category: "moves_money", cursor: "c2", serverId: "mcs_stripe" },
      page: "tools",
    });
  });

  it("passes a refusal through as the kernel classified it", async () => {
    const denied = {
      ok: false,
      reason: "denied",
      permission: "tools.read",
    } as const;
    kernelRead.mockResolvedValue(denied);
    expect(await tools.versions(ctx, firstPage)).toEqual(
      denied,
    );
    expect(captureError).not.toHaveBeenCalled();
  });

  it("reports a record the view model refuses, once, as record_unmappable", async () => {
    kernelRead.mockResolvedValue(
      readOk(
        toolVersionListOutput({
          items: toolVersionListOutput().items.map((item) => ({
            ...item,
            id: "not-a-public-id",
          })),
        }),
      ),
    );
    expect(await tools.versions(ctx, firstPage)).toEqual(
      readError("record_unmappable", 502),
    );
    expect(captureError).toHaveBeenCalledTimes(1);
  });
});

describe("tools.grants", () => {
  it("reads the broker's grants and maps the scope the view prints", async () => {
    kernelRead.mockResolvedValue(readOk(credentialGrantListOutput()));
    const read = await tools.grants(ctx, { cursor: null });
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: credentialGrantList,
      input: {},
      page: "tools",
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const [first, second] = read.value.items;
    expect(first?.scope).toEqual({
      endpointUrl: "https://api.github.com",
      authKind: "oauth",
      downscope: "token_exchange",
    });
    expect(first?.runId).toBe("arun_01k5r7");
    expect(second?.runId).toBeNull();
    expect(second?.status).toBe("revoked");
  });

  it("carries a later page's cursor", async () => {
    kernelRead.mockResolvedValue(readOk(credentialGrantListOutput()));
    await tools.grants(ctx, { cursor: "g2" });
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: credentialGrantList,
      input: { cursor: "g2" },
      page: "tools",
    });
  });

  it("reports a record the view model refuses", async () => {
    kernelRead.mockResolvedValue(
      readOk(
        credentialGrantListOutput({
          items: credentialGrantListOutput().items.map((item) => ({
            ...item,
            serverName: "",
          })),
        }),
      ),
    );
    expect(await tools.grants(ctx, { cursor: null })).toEqual(
      readError("record_unmappable", 502),
    );
    expect(captureError).toHaveBeenCalledTimes(1);
  });
});

describe("tools.killSwitches", () => {
  it("reads the switches with the deny generation and keeps the uuid target off the id fields", async () => {
    kernelRead.mockResolvedValue(readOk(killSwitchListOutput()));
    const read = await tools.killSwitches(ctx);
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: killSwitchList,
      // The contract carries no cursor, so the board asks for its ceiling
      // rather than taking the default hundred as the whole record.
      input: { limit: KILL_SWITCH_BOARD_LIMIT },
      page: "tools",
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.denyGeneration).toEqual({ org: 12, workspace: 4 });
    expect(read.value.truncated).toBe(false);
    const [cls, workspace] = read.value.switches;
    expect(cls?.target).toEqual({ kind: "class", ref: "moves_money" });
    expect(cls?.flippedByRef).toBe("7c9e6679-7425-40de-944b-e07fc1f90ae7");
    expect(workspace?.target.kind).toBe("workspace");
    expect(workspace?.flippedByRef).toBeNull();
  });

  it("calls a board that came back at the ceiling truncated", async () => {
    const [first] = killSwitchListOutput().switches;
    if (first === undefined) throw new Error("no fixture switch");
    kernelRead.mockResolvedValue(
      readOk(
        killSwitchListOutput({
          switches: Array.from(
            { length: KILL_SWITCH_BOARD_LIMIT },
            (_, index) => ({
              ...first,
              id: `emd_${String(index).padStart(5, "0")}`,
            }),
          ),
        }),
      ),
    );
    const read = await tools.killSwitches(ctx);
    // A full answer is all the page can know: there is no later page to ask for.
    expect(read.ok && read.value.truncated).toBe(true);
  });

  it("passes an error through", async () => {
    kernelRead.mockResolvedValue(readError("tool_registry_unavailable", 503));
    expect(await tools.killSwitches(ctx)).toEqual(
      readError("tool_registry_unavailable", 503),
    );
  });

  it("reports a board the view model refuses", async () => {
    kernelRead.mockResolvedValue(
      readOk(
        killSwitchListOutput({
          switches: killSwitchListOutput().switches.map((item) => ({
            ...item,
            id: "12345",
          })),
        }),
      ),
    );
    expect(await tools.killSwitches(ctx)).toEqual(
      readError("record_unmappable", 502),
    );
    expect(captureError).toHaveBeenCalledTimes(1);
  });
});

describe("tools.approvalRules", () => {
  it("reads the whole rule set on the tools failure row and carries every field the edit dialog shows", async () => {
    kernelRead.mockResolvedValue(readOk(approvalRuleListOutput()));
    const read = await tools.approvalRules(ctx);
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: approvalRuleList,
      input: {},
      page: "tools",
    });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.windowDays).toBe(30);
    const [refunds, deploys] = read.value.rules;
    expect(refunds).toEqual({
      slug: "small-refunds",
      name: "Small refunds to known customers",
      tools: ["stripe__create_refund@*"],
      enabled: true,
      maxMeasures: { amount: "50000000" },
      allowTargets: { counterparty: ["cus_*", "vendor:aws"] },
      standingWindowMs: null,
      businessHours: {
        timezone: "Europe/London",
        days: [1, 2, 3, 4, 5],
        start: "09:00",
        end: "17:00",
      },
      lastWrittenBy: "usr_01k5a1",
      lastWrittenAt: "2026-09-12T10:00:00.000Z",
      authoredConsequences: ["moves_money"],
      released: 212,
      held: 9,
    });
    // A rule the record carries no stamp for says so as null, which the tab
    // prints as "releases nothing until saved again", never as an empty set.
    expect(deploys?.authoredConsequences).toBeNull();
    expect(deploys?.lastWrittenBy).toBeNull();
  });

  it("passes a refusal through as the kernel classified it", async () => {
    const denied = {
      ok: false,
      reason: "denied",
      permission: "tools.read",
    } as const;
    kernelRead.mockResolvedValue(denied);
    expect(await tools.approvalRules(ctx)).toEqual(denied);
    expect(captureError).not.toHaveBeenCalled();
  });

  it("reports a rule set the view model refuses", async () => {
    kernelRead.mockResolvedValue(
      readOk(
        approvalRuleListOutput({
          items: approvalRuleListOutput().items.map((item) => ({
            ...item,
            createdBy: "not a public id",
          })),
        }),
      ),
    );
    expect(await tools.approvalRules(ctx)).toEqual(
      readError("record_unmappable", 502),
    );
    expect(captureError).toHaveBeenCalledTimes(1);
  });
});
