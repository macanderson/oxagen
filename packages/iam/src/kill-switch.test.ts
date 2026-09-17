/**
 * The kill-switch matcher and the resource-scope digests it shares with the
 * writer. Rows are built the way set_kill_switch writes them, so a test here
 * proves that a switch flipped for `{kind, id}` reaches the calls it should
 * and none it should not.
 */
import { describe, expect, it } from "vitest";
import {
  callScopeDigests,
  matchKillSwitch,
  sortByPrecedence,
  type KillSwitchRow,
  type KillSwitchTargetKind,
} from "./kill-switch";
import { implicitScopeDigests, resourceScopeDigestOf } from "./resource-scope";

const ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3e";
const WS = "0192d4a8-7c1e-7a00-8000-00000000ac40";
const SERVER = "0192d4a8-7c1e-7a00-8000-0000000000aa";
const CONNECTION = "0192d4a8-7c1e-7a00-8000-0000000000bb";
const USER = "0192d4a8-7c1e-7a00-8000-0000000005e1";

let seq = 0;
function row(
  targetKind: KillSwitchTargetKind,
  digestOver: { kind: string; id: string } | { capabilityId: string },
  over: Partial<KillSwitchRow> = {},
): KillSwitchRow {
  seq += 1;
  return {
    id: `id_${seq}`,
    publicId: `emd_${seq}`,
    targetKind,
    targetId: "kind" in digestOver ? digestOver.id : "tlv_x",
    scopeKind: "workspace",
    workspaceId: WS,
    capabilityId: "capabilityId" in digestOver ? digestOver.capabilityId : null,
    resourceScopeDigest:
      "kind" in digestOver ? resourceScopeDigestOf(digestOver) : null,
    principalId: null,
    reason: "test",
    active: true,
    activatedAt: new Date("2026-09-15T00:00:00Z"),
    deactivatedAt: null,
    flippedByUserId: USER,
    updatedById: USER,
    ...over,
  };
}

const call = {
  orgId: ORG,
  workspaceId: WS,
  capabilityId: `mcp.${SERVER}.create_payment`,
  serverId: SERVER,
  connectionId: CONNECTION,
  consequenceTags: ["moves_money"],
  agentId: "agt_finops",
  operatorUserId: USER,
};

describe("resourceScopeDigestOf", () => {
  it("is stable across key order and carries the sha256: prefix", () => {
    const a = resourceScopeDigestOf({ kind: "agent", id: "agt_1" });
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(resourceScopeDigestOf({ id: "agt_1", kind: "agent" })).toBe(a);
    expect(resourceScopeDigestOf({ kind: "agent", id: "agt_2" })).not.toBe(a);
    expect(resourceScopeDigestOf({ kind: "operator", id: "agt_1" })).not.toBe(
      a,
    );
  });

  it("implicit scopes cover org, workspace, agent and operator, skipping what is absent", () => {
    expect(
      implicitScopeDigests({
        orgId: ORG,
        workspaceId: null,
        agentId: null,
        operatorUserId: null,
      }),
    ).toEqual([resourceScopeDigestOf({ kind: "org", id: ORG })]);
    expect(
      implicitScopeDigests({
        orgId: ORG,
        workspaceId: WS,
        agentId: "agt_1",
        operatorUserId: USER,
      }),
    ).toHaveLength(4);
  });
});

describe("matchKillSwitch", () => {
  it("an open registry matches nothing", () => {
    expect(matchKillSwitch([], call)).toBeNull();
  });

  it.each([
    ["tool_version", { capabilityId: call.capabilityId }],
    ["tool_server", { kind: "tool_server", id: SERVER }],
    ["connection", { kind: "connection", id: CONNECTION }],
    ["class", { kind: "class", id: "moves_money" }],
    ["agent", { kind: "agent", id: "agt_finops" }],
    ["operator", { kind: "operator", id: USER }],
    ["workspace", { kind: "workspace", id: WS }],
    ["org", { kind: "org", id: ORG }],
  ] as const)("a %s switch stops the call", (kind, over) => {
    const hit = matchKillSwitch([row(kind, over)], call);
    expect(hit?.targetKind).toBe(kind);
  });

  it("a class switch matches a tool by its tag, and not one without it", () => {
    const switches = [row("class", { kind: "class", id: "moves_money" })];
    expect(matchKillSwitch(switches, call)?.targetKind).toBe("class");
    expect(
      matchKillSwitch(switches, {
        ...call,
        consequenceTags: ["destroys_data"],
      }),
    ).toBeNull();
    expect(
      matchKillSwitch(switches, { ...call, consequenceTags: [] }),
    ).toBeNull();
  });

  it("a switch on another version, server, agent or operator leaves the call open", () => {
    const switches = [
      row("tool_version", { capabilityId: `mcp.${SERVER}.list_payments` }),
      row("tool_server", { kind: "tool_server", id: CONNECTION }),
      row("agent", { kind: "agent", id: "agt_other" }),
      row("operator", { kind: "operator", id: WS }),
    ];
    expect(matchKillSwitch(switches, call)).toBeNull();
  });

  it("reports the version switch before the server and class switches", () => {
    const switches = [
      row("class", { kind: "class", id: "moves_money" }),
      row("tool_server", { kind: "tool_server", id: SERVER }),
      row("tool_version", { capabilityId: call.capabilityId }),
    ];
    expect(matchKillSwitch(switches, call)?.targetKind).toBe("tool_version");
    expect(sortByPrecedence(switches).map((s) => s.targetKind)).toEqual([
      "tool_version",
      "tool_server",
      "class",
    ]);
  });

  it("a call with no external server or classification still answers to scope switches", () => {
    const facts = {
      orgId: ORG,
      workspaceId: WS,
      capabilityId: "list_runs",
      operatorUserId: USER,
    };
    expect(callScopeDigests(facts)).toEqual([
      resourceScopeDigestOf({ kind: "org", id: ORG }),
      resourceScopeDigestOf({ kind: "workspace", id: WS }),
      resourceScopeDigestOf({ kind: "operator", id: USER }),
    ]);
    expect(
      matchKillSwitch([row("workspace", { kind: "workspace", id: WS })], facts)
        ?.targetKind,
    ).toBe("workspace");
  });
});
