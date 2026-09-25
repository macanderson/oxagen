/**
 * The tool gateway's kill-switch gate (spec §6.11, §7.4 last row): a
 * non-read-only call re-reads the deny generation before it runs and, when
 * the generation moved, the switches; a read-only call is checked against
 * what the gate last saw; a class switch matches a tool by the tags of its
 * registry version, which the gate reloads only when the generation moved.
 *
 * The reads are injected; the tenancy shim records that every read runs
 * inside the turn's scope (the execute closures run outside the route's).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resourceScopeDigestOf, type KillSwitchRow } from "@oxagen/iam";
import type { CapabilityContext } from "../types";

const tenancy = vi.hoisted(() => ({
  scopes: [] as Array<{ orgId: string; workspaceId: string }>,
}));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: async <T>(
    scope: { orgId: string; workspaceId: string },
    fn: () => Promise<T> | T,
  ): Promise<T> => {
    tenancy.scopes.push(scope);
    return fn();
  },
}));

import {
  createKillSwitchGate,
  type KillSwitchGateReads,
  type KillSwitchSnapshot,
} from "./kill-switch-gate";
import {
  registryCapabilityId,
  unionConsequenceTags,
} from "./tool-registry-facts";

const ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3e";
const WS = "0192d4a8-7c1e-7a00-8000-00000000ac40";
const SERVER = "0192d4a8-7c1e-7a00-8000-0000000000aa";
const USER = "0192d4a8-7c1e-7a00-8000-0000000005e1";

const ctx: CapabilityContext = {
  orgId: ORG,
  workspaceId: WS,
  userId: USER,
  apiKeyId: null,
  requestId: "req_1",
  surface: "runner",
  messageId: null,
};

let seq = 0;
function classSwitch(tag: string): KillSwitchRow {
  seq += 1;
  return {
    id: `id_${seq}`,
    publicId: `emd_${seq}`,
    targetKind: "class",
    targetId: tag,
    scopeKind: "org",
    workspaceId: null,
    capabilityId: null,
    resourceScopeDigest: resourceScopeDigestOf({ kind: "class", id: tag }),
    principalId: null,
    reason: "incident",
    active: true,
    activatedAt: new Date("2026-09-15T00:00:00Z"),
    deactivatedAt: null,
    flippedByUserId: USER,
    updatedById: USER,
  };
}

/**
 * Reads over a mutable store: the generation counter and what is on.
 *
 * `flip` models a write to iam.emergency_denies and `classify` a changed
 * agent.tool_versions.classification: each bumps the generation, as the
 * table triggers do in the writer's transaction. `retag` changes the tags
 * with no bump, the write the triggers exist to rule out.
 */
function store(initial: { generation: number; snapshot: KillSwitchSnapshot }) {
  const state = { ...initial };
  const reads: KillSwitchGateReads = {
    readGeneration: vi.fn(async () => ({
      org: state.generation,
      workspace: 0,
    })),
    readSnapshot: vi.fn(async () => ({
      ...state.snapshot,
      generation: { org: state.generation, workspace: 0 },
    })),
  };
  return {
    reads,
    flip(snapshot: Partial<KillSwitchSnapshot>) {
      state.generation += 1;
      state.snapshot = { ...state.snapshot, ...snapshot };
    },
    classify(tags: KillSwitchSnapshot["tags"]) {
      state.generation += 1;
      state.snapshot = { ...state.snapshot, tags };
    },
    retag(tags: KillSwitchSnapshot["tags"]) {
      state.snapshot = { ...state.snapshot, tags };
    },
  };
}

const open: KillSwitchSnapshot = {
  generation: { org: 1, workspace: 0 },
  switches: [],
  tags: new Map(),
};

beforeEach(() => {
  tenancy.scopes.length = 0;
});

describe("createKillSwitchGate", () => {
  it("reads the snapshot once for a turn with nothing switched", async () => {
    const { reads } = store({ generation: 1, snapshot: open });
    const gate = createKillSwitchGate(ctx, reads);

    expect(
      await gate.check({ capabilityId: "list_runs", readOnly: true }),
    ).toBeNull();
    expect(
      await gate.check({ capabilityId: "send_mail", readOnly: false }),
    ).toBeNull();
    expect(reads.readSnapshot).toHaveBeenCalledTimes(1);
    // The non-read-only call re-read the generation; the read-only one did not.
    expect(reads.readGeneration).toHaveBeenCalledTimes(1);
    // Every read ran inside the turn's tenant scope.
    expect(
      tenancy.scopes.every((s) => s.orgId === ORG && s.workspaceId === WS),
    ).toBe(true);
  });

  it("a switch flipped mid-turn stops the next non-read-only call (deny generation bump)", async () => {
    const s = store({ generation: 1, snapshot: open });
    const gate = createKillSwitchGate(ctx, s.reads);
    const facts = {
      capabilityId: `mcp.${SERVER}.create_payment`,
      serverId: SERVER,
      readOnly: false,
    };
    expect(await gate.check(facts)).toBeNull();

    s.flip({
      switches: [classSwitch("moves_money")],
      tags: new Map([[facts.capabilityId, ["moves_money"]]]),
    });

    const hit = await gate.check(facts);
    expect(hit?.targetKind).toBe("class");
    expect(hit?.targetId).toBe("moves_money");
    expect(s.reads.readSnapshot).toHaveBeenCalledTimes(2);
  });

  it("a read-only call is checked against the last-read switches without a refresh", async () => {
    const s = store({ generation: 1, snapshot: open });
    const gate = createKillSwitchGate(ctx, s.reads);
    expect(
      await gate.check({ capabilityId: "list_runs", readOnly: true }),
    ).toBeNull();
    s.flip({ switches: [classSwitch("moves_money")] });
    expect(
      await gate.check({ capabilityId: "list_runs", readOnly: true }),
    ).toBeNull();
    expect(s.reads.readGeneration).not.toHaveBeenCalled();
    expect(s.reads.readSnapshot).toHaveBeenCalledTimes(1);
  });

  it("an unchanged generation keeps the snapshot", async () => {
    const s = store({ generation: 1, snapshot: open });
    const gate = createKillSwitchGate(ctx, s.reads);
    await gate.check({ capabilityId: "a", readOnly: false });
    await gate.check({ capabilityId: "b", readOnly: false });
    expect(s.reads.readGeneration).toHaveBeenCalledTimes(2);
    expect(s.reads.readSnapshot).toHaveBeenCalledTimes(1);
  });

  it("a class switch matches a tool imported and classified afterwards by its tag", async () => {
    const s = store({
      generation: 2,
      snapshot: { ...open, switches: [classSwitch("moves_money")] },
    });
    const gate = createKillSwitchGate(ctx, s.reads);
    const cap = `mcp.${SERVER}.create_payment`;
    // Not yet in the registry: open.
    expect(
      await gate.check({
        capabilityId: cap,
        serverId: SERVER,
        readOnly: false,
      }),
    ).toBeNull();
    // Imported and tagged; the switch was on before the tool existed.
    s.classify(new Map([[cap, ["moves_money"]]]));
    expect(
      (
        await gate.check({
          capabilityId: cap,
          serverId: SERVER,
          readOnly: false,
        })
      )?.targetId,
    ).toBe("moves_money");
  });

  it("a tag change the generation did not record is not reloaded", async () => {
    const s = store({
      generation: 2,
      snapshot: { ...open, switches: [classSwitch("moves_money")] },
    });
    const gate = createKillSwitchGate(ctx, s.reads);
    const facts = { capabilityId: "create_payment", readOnly: false };
    expect(await gate.check(facts)).toBeNull();
    s.retag(new Map([["create_payment", ["moves_money"]]]));
    // The gate trusts the generation: without the classification trigger's
    // bump the new tag stays unseen for the rest of the turn.
    expect(await gate.check(facts)).toBeNull();
    expect(s.reads.readSnapshot).toHaveBeenCalledTimes(1);
  });

  it("a failed snapshot read rejects the call and is retried on the next one", async () => {
    const reads: KillSwitchGateReads = {
      readGeneration: vi.fn(async () => ({ org: 1, workspace: 0 })),
      readSnapshot: vi
        .fn<KillSwitchGateReads["readSnapshot"]>()
        .mockRejectedValueOnce(new Error("db down"))
        .mockResolvedValue(open),
    };
    const gate = createKillSwitchGate(ctx, reads);
    await expect(
      gate.check({ capabilityId: "a", readOnly: false }),
    ).rejects.toThrow("db down");
    expect(await gate.check({ capabilityId: "a", readOnly: false })).toBeNull();
  });
});

// The in-app assistant's turn runs as the person, with no agent run, and
// hands the gate the agent it runs as. An `agent` switch on that agent stops
// the turn's calls. The same person's own calls carry no acting agent.
describe("an agent switch and the agent a person's turn acts as", () => {
  const ASSISTANT = { agentId: "agt_assistant", principalId: "prn_assistant" };
  const agentSwitch = (agentId: string): KillSwitchRow => ({
    ...classSwitch("unused"),
    targetKind: "agent",
    targetId: agentId,
    scopeKind: "workspace",
    workspaceId: WS,
    resourceScopeDigest: resourceScopeDigestOf({ kind: "agent", id: agentId }),
  });

  it("stops every call of the assistant's turn, reads and writes", async () => {
    const s = store({
      generation: 1,
      snapshot: { ...open, switches: [agentSwitch(ASSISTANT.agentId)] },
    });
    const gate = createKillSwitchGate(ctx, s.reads, ASSISTANT);
    const write = await gate.check({
      capabilityId: "set_budget",
      readOnly: false,
    });
    expect(write?.targetKind).toBe("agent");
    expect(write?.targetId).toBe(ASSISTANT.agentId);
    expect(
      (await gate.check({ capabilityId: "list_runs", readOnly: true }))
        ?.targetKind,
    ).toBe("agent");
  });

  it("leaves the same person's own calls open (negative)", async () => {
    const s = store({
      generation: 1,
      snapshot: { ...open, switches: [agentSwitch(ASSISTANT.agentId)] },
    });
    const gate = createKillSwitchGate(ctx, s.reads);
    expect(
      await gate.check({ capabilityId: "set_budget", readOnly: false }),
    ).toBeNull();
  });

  it("leaves the assistant's calls open under a switch on another agent (negative)", async () => {
    const s = store({
      generation: 1,
      snapshot: { ...open, switches: [agentSwitch("agt_someone_else")] },
    });
    const gate = createKillSwitchGate(ctx, s.reads, ASSISTANT);
    expect(
      await gate.check({ capabilityId: "set_budget", readOnly: false }),
    ).toBeNull();
  });
});

describe("registryCapabilityId", () => {
  it("governs an imported tool under its server's synthetic id and a declared tool under its slug", () => {
    expect(
      registryCapabilityId({
        source: "mcp",
        slug: "create_payment",
        name: "create_payment",
        mcpServerId: SERVER,
      }),
    ).toBe(`mcp.${SERVER}.create_payment`);
    expect(
      registryCapabilityId({
        source: "builtin",
        slug: "list_runs",
        name: "list_runs",
        mcpServerId: null,
      }),
    ).toBe("list_runs");
  });
});

describe("unionConsequenceTags", () => {
  it("takes the declared column and the classified jsonb together, deduped and SORTED", () => {
    // The order is part of the contract, not an artefact of which half
    // contributed a tag first (ADR-070). It became load-bearing when a rule's
    // `authoredConsequences` stamp started comparing a stored set against a
    // later one, so the union sorts once at the point it is formed and every
    // reader gets the same answer. These assertions are exact on purpose.
    expect(
      unionConsequenceTags({
        consequenceTags: ["moves_money"],
        classification: null,
      }),
    ).toEqual(["moves_money"]);
    expect(
      unionConsequenceTags({
        consequenceTags: null,
        classification: { consequenceTags: ["sends_external"] },
      }),
    ).toEqual(["sends_external"]);
    expect(
      unionConsequenceTags({
        consequenceTags: ["moves_money", "deletes_data"],
        classification: { consequenceTags: ["moves_money", "sends_external"] },
      }),
    ).toEqual(["deletes_data", "moves_money", "sends_external"]);
  });

  it("ignores a classification that is not the schema's shape", () => {
    expect(
      unionConsequenceTags({
        consequenceTags: ["moves_money"],
        classification: { consequenceTags: "moves_money" },
      }),
    ).toEqual(["moves_money"]);
    expect(
      unionConsequenceTags({ consequenceTags: [], classification: 7 }),
    ).toEqual([]);
  });
});

describe("a class kill switch and a tool whose tags were declared, not classified", () => {
  /**
   * The regression this file exists for. `import_tools` and
   * `publish_tool_declaration` write consequence tags to
   * `agent.tool_versions.consequence_tags`; only `set_tool_classification`
   * writes the `classification` jsonb. The gate's index used to read the jsonb
   * alone, filtered on `classification IS NOT NULL`, so an admin could publish
   * a tool tagged `moves_money`, flip a `class` kill switch on `moves_money`,
   * see `list_kill_switches` report it on — and the tool still ran.
   */
  it("stops a tool tagged only in the declared column", async () => {
    const capabilityId = `mcp.${SERVER}.create_payment`;
    const { reads } = store({
      generation: 1,
      snapshot: {
        generation: { org: 1, workspace: 0 },
        switches: [classSwitch("moves_money")],
        // What readClassificationIndex now builds: the union of both halves,
        // for a version with NO classification jsonb at all.
        tags: new Map([
          [
            capabilityId,
            unionConsequenceTags({
              consequenceTags: ["moves_money"],
              classification: null,
            }),
          ],
        ]),
      },
    });
    const gate = createKillSwitchGate(ctx, reads);
    const hit = await gate.check({
      capabilityId,
      serverId: SERVER,
      readOnly: false,
    });
    expect(hit?.targetKind).toBe("class");
    expect(hit?.targetId).toBe("moves_money");
  });

  it("leaves a tool carrying neither half's tag open", async () => {
    const { reads } = store({
      generation: 1,
      snapshot: {
        generation: { org: 1, workspace: 0 },
        switches: [classSwitch("moves_money")],
        tags: new Map([["reads_only", ["reads_data"]]]),
      },
    });
    const gate = createKillSwitchGate(ctx, reads);
    expect(
      await gate.check({ capabilityId: "reads_only", readOnly: false }),
    ).toBeNull();
  });
});
