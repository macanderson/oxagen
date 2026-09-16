/**
 * assertNoActiveKillSwitch — the guard that stops a delete dismantling a kill
 * switch (ADR-069).
 *
 * A `connection`, `tool_server` or `tool_version` switch denies on a digest
 * over an INTERNAL uuid. `deleteWorkspaceSecret` and `plugin.org.uninstall`
 * hard-delete the rows those uuids belong to, and re-creating either mints a
 * fresh one, so after a delete-and-recreate the switch matches nothing while
 * `list_kill_switches` still reports it on. This module refuses the delete
 * instead. The reads run against a recording transaction — the SQL runs in the
 * handler suites.
 */
import type { Tx } from "@oxagen/database";
import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { assertNoActiveKillSwitch } from "./kill-switch-guard";

const ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3e";
const WS = "0192d4a8-7c1e-7a00-8000-00000000ac40";

type Call = { op: string; args: unknown[] };

/** Records each builder step; awaiting the chain answers the canned rows. */
function recordingTx(rows: unknown[]) {
  const calls: Call[] = [];
  const chain: Record<string, unknown> = {};
  const step =
    (op: string) =>
    (...args: unknown[]) => {
      calls.push({ op, args });
      return chain;
    };
  for (const op of ["select", "from", "where"]) chain[op] = step(op);
  chain.then = (
    resolve: (v: unknown) => unknown,
    reject: (e: unknown) => unknown,
  ) => Promise.resolve(rows).then(resolve, reject);
  return { tx: chain as unknown as Tx, calls };
}

function switchRow(over: Partial<Record<string, unknown>>) {
  return {
    id: "d1",
    publicId: "emd_1",
    targetKind: "connection",
    targetId: "mcrd_gh",
    scopeKind: "workspace",
    workspaceId: WS,
    capabilityId: null,
    resourceScopeDigest: "digest",
    principalId: null,
    reason: "token leaked",
    active: true,
    activatedAt: new Date("2026-09-16T00:00:00Z"),
    deactivatedAt: null,
    flippedByUserId: null,
    updatedByUserId: null,
    ...over,
  };
}

describe("assertNoActiveKillSwitch", () => {
  it("passes when nothing names the targets", async () => {
    const { tx } = recordingTx([]);
    await expect(
      assertNoActiveKillSwitch(tx, {
        orgId: ORG,
        targets: [{ kind: "connection", id: "mcrd_gh" }],
        action: "Removing this connection's authentication",
      }),
    ).resolves.toBeUndefined();
  });

  it("makes no read at all for an empty target list", async () => {
    const { tx, calls } = recordingTx([switchRow({})]);
    await assertNoActiveKillSwitch(tx, {
      orgId: ORG,
      targets: [],
      action: "Uninstalling this plugin",
    });
    expect(calls).toEqual([]);
  });

  it("refuses as a conflict naming the switch, its target and the way out", async () => {
    const { tx } = recordingTx([switchRow({})]);
    await expect(
      assertNoActiveKillSwitch(tx, {
        orgId: ORG,
        targets: [{ kind: "connection", id: "mcrd_gh" }],
        action: "Removing this connection's authentication",
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "kill_switch_on",
      message: expect.stringContaining("emd_1"),
    });
    await expect(
      assertNoActiveKillSwitch(recordingTx([switchRow({})]).tx, {
        orgId: ORG,
        targets: [{ kind: "connection", id: "mcrd_gh" }],
        action: "Removing this connection's authentication",
      }),
    ).rejects.toThrow(/set_kill_switch with on: false/);
  });

  it("matches on org, active, and each (kind, id) pair", async () => {
    const { tx, calls } = recordingTx([]);
    await assertNoActiveKillSwitch(tx, {
      orgId: ORG,
      targets: [
        { kind: "tool_server", id: "mcs_acme" },
        { kind: "tool_version", id: "tlv_1" },
      ],
      action: "Uninstalling this plugin",
    });
    const where = calls.find((c) => c.op === "where")!.args[0] as SQL;
    const rendered = new PgDialect().sqlToQuery(where);
    expect(rendered.sql).toContain("target_kind");
    expect(rendered.sql).toContain("target_id");
    expect(rendered.params).toEqual([
      ORG,
      true,
      "tool_server",
      "mcs_acme",
      "tool_version",
      "tlv_1",
    ]);
  });

  it("reports the highest-precedence switch when several name the targets", async () => {
    // INV-10's decision order: a tool_version switch outranks a tool_server one.
    const { tx } = recordingTx([
      switchRow({
        publicId: "emd_server",
        targetKind: "tool_server",
        targetId: "mcs_acme",
      }),
      switchRow({
        publicId: "emd_version",
        targetKind: "tool_version",
        targetId: "tlv_1",
      }),
    ]);
    await expect(
      assertNoActiveKillSwitch(tx, {
        orgId: ORG,
        targets: [
          { kind: "tool_server", id: "mcs_acme" },
          { kind: "tool_version", id: "tlv_1" },
        ],
        action: "Uninstalling this plugin",
      }),
    ).rejects.toThrow(/emd_version/);
  });
});
