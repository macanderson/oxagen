/**
 * The kill-switch reads and flips against a recording transaction: what each
 * write sends (scope, deny kind, the conflict target for the partial unique
 * index) and how each read maps, rejects and orders what comes back. The SQL
 * itself runs in the handler integration suites; this pins the module's own
 * decisions without a database.
 */
import type { Tx } from "@oxagen/database";
import { describe, expect, it } from "vitest";
import {
  flipKillSwitchOff,
  flipKillSwitchOn,
  readActiveKillSwitches,
  readKillSwitches,
} from "./kill-switch";

const ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3e";
const WS = "0192d4a8-7c1e-7a00-8000-00000000ac40";
const USER = "0192d4a8-7c1e-7a00-8000-0000000005e1";

type Call = { op: string; args: unknown[] };

/**
 * A query-builder double: every builder step is recorded, and each terminal
 * (`limit`, `returning`, or awaiting the chain) answers the next canned result.
 */
function recordingTx(results: unknown[][]) {
  const calls: Call[] = [];
  const next = () => Promise.resolve(results.shift() ?? []);
  const chain: Record<string, unknown> = {};
  const step =
    (op: string) =>
    (...args: unknown[]) => {
      calls.push({ op, args });
      return chain;
    };
  for (const op of [
    "select",
    "from",
    "where",
    "orderBy",
    "insert",
    "values",
    "onConflictDoNothing",
    "update",
    "set",
  ]) {
    chain[op] = step(op);
  }
  chain.limit = (...args: unknown[]) => {
    calls.push({ op: "limit", args });
    return next();
  };
  chain.returning = (...args: unknown[]) => {
    calls.push({ op: "returning", args });
    return next();
  };
  chain.then = (
    resolve: (v: unknown) => unknown,
    reject: (e: unknown) => unknown,
  ) => next().then(resolve, reject);
  const argsOf = (op: string) => calls.find((c) => c.op === op)?.args[0];
  return { tx: chain as unknown as Tx, calls, argsOf };
}

function dbRow(over: Record<string, unknown> = {}) {
  return {
    id: "id_1",
    publicId: "emd_1",
    targetKind: "tool_server",
    targetId: "mcs_1",
    scopeKind: "workspace",
    workspaceId: WS,
    capabilityId: null,
    resourceScopeDigest: "sha256:" + "a".repeat(64),
    principalId: null,
    reason: "processor incident",
    active: true,
    activatedAt: new Date("2026-09-15T00:00:00Z"),
    deactivatedAt: null,
    flippedByUserId: USER,
    updatedByUserId: USER,
    ...over,
  };
}

describe("readKillSwitches", () => {
  it("maps each row and applies the page limit", async () => {
    const { tx, calls } = recordingTx([[dbRow()]]);
    const rows = await readKillSwitches(tx, {
      orgId: ORG,
      workspaceId: WS,
      onlyOn: true,
      limit: 25,
    });
    expect(rows).toEqual([
      expect.objectContaining({
        publicId: "emd_1",
        targetKind: "tool_server",
        scopeKind: "workspace",
      }),
    ]);
    expect(calls.find((c) => c.op === "limit")?.args).toEqual([25]);
    expect(calls.map((c) => c.op)).toContain("orderBy");
  });

  it("reads org-wide switches only when no workspace is given", async () => {
    const { tx } = recordingTx([
      [dbRow({ workspaceId: null, scopeKind: "org" })],
    ]);
    const rows = await readKillSwitches(tx, {
      orgId: ORG,
      workspaceId: null,
      onlyOn: false,
      limit: 10,
    });
    expect(rows[0]?.scopeKind).toBe("org");
  });

  it.each([
    ["no target kind", { targetKind: null }],
    ["no target id", { targetId: null }],
    ["a kind outside the vocabulary", { targetKind: "repository" }],
    ["a scope outside the vocabulary", { scopeKind: "team" }],
  ])("refuses a row with %s", async (_label, over) => {
    const { tx } = recordingTx([[dbRow(over)]]);
    await expect(
      readKillSwitches(tx, {
        orgId: ORG,
        workspaceId: WS,
        onlyOn: false,
        limit: 5,
      }),
    ).rejects.toThrow(RangeError);
  });
});

describe("readActiveKillSwitches", () => {
  it("answers the active rows in precedence order", async () => {
    const { tx } = recordingTx([
      [
        dbRow({ publicId: "emd_org", targetKind: "org", targetId: ORG }),
        dbRow({
          publicId: "emd_class",
          targetKind: "class",
          targetId: "moves_money",
        }),
        dbRow({
          publicId: "emd_tlv",
          targetKind: "tool_version",
          targetId: "tlv_1",
          capabilityId: "mcp.x.pay",
          resourceScopeDigest: null,
        }),
      ],
    ]);
    const rows = await readActiveKillSwitches(tx, {
      orgId: ORG,
      workspaceId: WS,
    });
    expect(rows.map((r) => r.publicId)).toEqual([
      "emd_tlv",
      "emd_class",
      "emd_org",
    ]);
  });
});

describe("flipKillSwitchOn", () => {
  it("inserts a workspace capability deny and reports the change", async () => {
    const { tx, argsOf } = recordingTx([[{ publicId: "emd_new" }]]);
    const out = await flipKillSwitchOn(tx, {
      orgId: ORG,
      workspaceId: WS,
      target: { kind: "tool_version", id: "tlv_1" },
      deny: { kind: "capability", capabilityId: "mcp.x.pay" },
      reason: "processor incident",
      userId: USER,
    });
    expect(out).toEqual({ publicId: "emd_new", changed: true });
    expect(argsOf("values")).toMatchObject({
      orgId: ORG,
      workspaceId: WS,
      scopeKind: "workspace",
      denyKind: "capability",
      capabilityId: "mcp.x.pay",
      resourceScopeDigest: null,
      targetKind: "tool_version",
      targetId: "tlv_1",
      active: true,
      flippedByUserId: USER,
    });
    const conflict = argsOf("onConflictDoNothing") as { target: unknown[] };
    expect(conflict.target).toHaveLength(4);
  });

  it("writes an org-wide resource-scope deny against the org-wide index", async () => {
    const digest = "sha256:" + "b".repeat(64);
    const { tx, argsOf } = recordingTx([[{ publicId: "emd_org" }]]);
    await flipKillSwitchOn(tx, {
      orgId: ORG,
      workspaceId: null,
      target: { kind: "class", id: "moves_money" },
      deny: { kind: "resource_scope", digest },
      reason: "freeze payments",
      userId: null,
    });
    expect(argsOf("values")).toMatchObject({
      scopeKind: "org",
      denyKind: "resource_scope",
      capabilityId: null,
      resourceScopeDigest: digest,
    });
    const conflict = argsOf("onConflictDoNothing") as { target: unknown[] };
    expect(conflict.target).toHaveLength(3);
  });

  it("answers the switch already on, unchanged, when the insert conflicts", async () => {
    const { tx } = recordingTx([[], [{ publicId: "emd_existing" }]]);
    const out = await flipKillSwitchOn(tx, {
      orgId: ORG,
      workspaceId: WS,
      target: { kind: "agent", id: "agt_1" },
      deny: { kind: "resource_scope", digest: "sha256:" + "c".repeat(64) },
      reason: "runaway",
      userId: USER,
    });
    expect(out).toEqual({ publicId: "emd_existing", changed: false });
  });

  it("fails loudly when the insert conflicted and no active row exists", async () => {
    const { tx } = recordingTx([[], []]);
    await expect(
      flipKillSwitchOn(tx, {
        orgId: ORG,
        workspaceId: WS,
        target: { kind: "agent", id: "agt_1" },
        deny: { kind: "resource_scope", digest: "sha256:" + "d".repeat(64) },
        reason: "runaway",
        userId: USER,
      }),
    ).rejects.toThrow(/conflicted with no active row/);
  });
});

describe("flipKillSwitchOff", () => {
  it("deactivates the target's active rows and keeps them", async () => {
    const { tx, argsOf } = recordingTx([
      [{ publicId: "emd_1" }, { publicId: "emd_2" }],
    ]);
    const out = await flipKillSwitchOff(tx, {
      orgId: ORG,
      workspaceId: WS,
      target: { kind: "tool_server", id: "mcs_1" },
      reason: "vendor patched",
      userId: USER,
    });
    expect(out).toEqual({ publicId: "emd_1", changed: true });
    expect(argsOf("set")).toMatchObject({
      active: false,
      clearedReason: "vendor patched",
      updatedByUserId: USER,
    });
  });

  it("reports no change when nothing for the target is on", async () => {
    const { tx } = recordingTx([[]]);
    const out = await flipKillSwitchOff(tx, {
      orgId: ORG,
      workspaceId: null,
      target: { kind: "org", id: ORG },
      reason: "resolved",
      userId: null,
    });
    expect(out).toEqual({ publicId: null, changed: false });
  });
});
