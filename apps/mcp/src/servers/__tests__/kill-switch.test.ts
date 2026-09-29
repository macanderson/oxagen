// kill-switch.test.ts: a served call's facts reach the kill switch gate in
// the gate's own terms (#4666). The real gate and matcher run here over fake
// reads, so each case is a switch the steering projection's rows would let a
// person turn on. The tenancy shim records that every read runs in the run's
// scope.
import { resourceScopeDigestOf, type KillSwitchRow, type KillSwitchTargetKind } from "@oxagen/iam";
import type { KillSwitchGateReads, KillSwitchSnapshot } from "@oxagen/agent/runtime/kill-switch-gate";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tenancy = vi.hoisted(() => ({ scopes: [] as Array<{ orgId: string; workspaceId: string }> }));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: async <T>(scope: { orgId: string; workspaceId: string }, fn: () => Promise<T> | T): Promise<T> => {
    tenancy.scopes.push(scope);
    return fn();
  },
}));

import { servedEmergencyDenies, type EmergencyDenyReads, type SwitchTargets } from "../kill-switch";
import type { EmergencyCall, ServedRun } from "../types";
import { run as fixtureRun } from "./fixtures";

const ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3e";
const WS = "0192d4a8-7c1e-7a00-8000-00000000ac40";
const SERVER = "0192d4a8-7c1e-7a00-8000-0000000000aa";
const CONNECTION = "0192d4a8-7c1e-7a00-8000-0000000000cc";
const OPERATOR = "0192d4a8-7c1e-7a00-8000-0000000005e1";
const TOOL = "billing__create_refund";
const CAPABILITY = `mcp.${SERVER}.${TOOL}`;

const REFUND: EmergencyCall = {
  server: "billing",
  tool: TOOL,
  credential: "oxagen:credential/billing-sandbox",
  readOnly: false,
};

function served(overrides: Partial<ServedRun> = {}): ServedRun {
  return fixtureRun({ orgId: ORG, workspaceId: WS, operator: OPERATOR, ...overrides });
}

let seq = 0;
function switchOn(
  targetKind: KillSwitchTargetKind,
  targetId: string,
  deny: { capabilityId: string } | { digest: string },
): KillSwitchRow {
  seq += 1;
  return {
    id: `id_${seq}`,
    publicId: `emd_${seq}`,
    targetKind,
    targetId,
    scopeKind: targetKind === "org" || targetKind === "class" ? "org" : "workspace",
    workspaceId: targetKind === "org" || targetKind === "class" ? null : WS,
    capabilityId: "capabilityId" in deny ? deny.capabilityId : null,
    resourceScopeDigest: "digest" in deny ? deny.digest : null,
    principalId: null,
    reason: "incident",
    active: true,
    activatedAt: new Date("2026-09-28T00:00:00Z"),
    deactivatedAt: null,
    flippedByUserId: OPERATOR,
    updatedById: OPERATOR,
  };
}

function scopeSwitch(targetKind: KillSwitchTargetKind, id: string): KillSwitchRow {
  return switchOn(targetKind, id, { digest: resourceScopeDigestOf({ kind: targetKind, id }) });
}

/** Reads over a mutable store. `flip` models a write to the switches, which bumps the generation. */
function store(switches: KillSwitchRow[], tags: KillSwitchSnapshot["tags"] = new Map()) {
  const state = { generation: 1, switches, tags };
  const gate: KillSwitchGateReads = {
    readGeneration: vi.fn(() => Promise.resolve({ org: state.generation, workspace: 0 })),
    readSnapshot: vi.fn(() =>
      Promise.resolve({
        generation: { org: state.generation, workspace: 0 },
        switches: state.switches,
        tags: state.tags,
      }),
    ),
  };
  return {
    gate,
    flip(next: KillSwitchRow[]) {
      state.generation += 1;
      state.switches = next;
    },
  };
}

function reads(gate: KillSwitchGateReads, targets: SwitchTargets = { serverId: SERVER, connectionId: CONNECTION }) {
  const asked: Array<{ run: ServedRun; call: { server: string; credential: string | null } }> = [];
  const value: EmergencyDenyReads = {
    gate,
    targets: (run, call) => {
      asked.push({ run, call });
      return Promise.resolve(targets);
    },
  };
  return { value, asked };
}

beforeEach(() => {
  tenancy.scopes.length = 0;
});

describe("servedEmergencyDenies", () => {
  const cases: Array<{ name: string; row: () => KillSwitchRow; tags?: KillSwitchSnapshot["tags"] }> = [
    { name: "the tool", row: () => switchOn("tool_version", "tov_1", { capabilityId: CAPABILITY }) },
    { name: "the server", row: () => scopeSwitch("tool_server", SERVER) },
    { name: "the connection", row: () => scopeSwitch("connection", CONNECTION) },
    { name: "the operator", row: () => scopeSwitch("operator", OPERATOR) },
    { name: "the workspace", row: () => scopeSwitch("workspace", WS) },
    { name: "the organization", row: () => scopeSwitch("org", ORG) },
    {
      name: "a class the tool is tagged with",
      row: () => scopeSwitch("class", "moves_money"),
      tags: new Map([[CAPABILITY, ["moves_money"]]]),
    },
  ];

  for (const { name, row, tags } of cases) {
    it(`stops a call when a switch on ${name} is on`, async () => {
      const on = row();
      const { gate } = store([on], tags);
      const check = servedEmergencyDenies(served(), reads(gate).value);
      await expect(check(REFUND)).resolves.toEqual({
        id: on.publicId,
        targetKind: on.targetKind,
        targetId: on.targetId,
        reason: "incident",
      });
    });
  }

  it("lets a call through when no switch is on", async () => {
    const { gate } = store([]);
    await expect(servedEmergencyDenies(served(), reads(gate).value)(REFUND)).resolves.toBeNull();
  });

  it("asks for the registry rows of the call's server and credential, in the run's scope", async () => {
    const { gate } = store([scopeSwitch("org", ORG)]);
    const run = served();
    const { value, asked } = reads(gate);
    await servedEmergencyDenies(run, value)(REFUND);
    expect(asked).toEqual([{ run, call: { server: "billing", credential: "oxagen:credential/billing-sandbox" } }]);
    expect(tenancy.scopes.length).toBeGreaterThan(0);
    expect(tenancy.scopes.every((s) => s.orgId === ORG && s.workspaceId === WS)).toBe(true);
  });

  it("reaches no server, connection, or tool switch when the registry holds no row for the call", async () => {
    const { gate } = store([
      switchOn("tool_version", "tov_1", { capabilityId: CAPABILITY }),
      scopeSwitch("tool_server", SERVER),
      scopeSwitch("connection", CONNECTION),
    ]);
    const { value } = reads(gate, { serverId: null, connectionId: null });
    await expect(servedEmergencyDenies(served(), value)(REFUND)).resolves.toBeNull();
  });

  it("still stops an unregistered call when the organization is switched off", async () => {
    const org = scopeSwitch("org", ORG);
    const { gate } = store([org]);
    const { value } = reads(gate, { serverId: null, connectionId: null });
    await expect(servedEmergencyDenies(served(), value)(REFUND)).resolves.toMatchObject({ id: org.publicId });
  });

  it("reaches no operator switch when the host records no operator", async () => {
    const { gate } = store([scopeSwitch("operator", OPERATOR)]);
    const run = served();
    delete run.operator;
    await expect(servedEmergencyDenies(run, reads(gate).value)(REFUND)).resolves.toBeNull();
  });

  it("names the switch that comes first when several reach one call", async () => {
    const org = scopeSwitch("org", ORG);
    const server = scopeSwitch("tool_server", SERVER);
    const { gate } = store([org, server]);
    await expect(servedEmergencyDenies(served(), reads(gate).value)(REFUND)).resolves.toMatchObject({
      id: server.publicId,
      targetKind: "tool_server",
    });
  });

  it("stops a write when a switch goes on after the run's first check", async () => {
    const s = store([]);
    const check = servedEmergencyDenies(served(), reads(s.gate).value);
    await expect(check(REFUND)).resolves.toBeNull();
    const server = scopeSwitch("tool_server", SERVER);
    s.flip([server]);
    await expect(check(REFUND)).resolves.toMatchObject({ id: server.publicId });
    expect(s.gate.readSnapshot).toHaveBeenCalledTimes(2);
  });

  it("checks a read against the switches the run last read", async () => {
    const s = store([]);
    const check = servedEmergencyDenies(served(), reads(s.gate).value);
    const read = { ...REFUND, tool: "billing__list_charges", readOnly: true };
    await expect(check(read)).resolves.toBeNull();
    s.flip([scopeSwitch("tool_server", SERVER)]);
    await expect(check(read)).resolves.toBeNull();
    expect(s.gate.readGeneration).not.toHaveBeenCalled();
    expect(s.gate.readSnapshot).toHaveBeenCalledTimes(1);
  });
});
