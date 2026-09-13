// Guards on the domain view models that the type system alone cannot hold.
import { describe, expect, it } from "vitest";
import { AgentDefinition } from "./agents";
import { ApprovalItem } from "./approvals";
import { Actor, TAMPER_INCIDENT_KINDS, IncidentKind } from "./audit";
import { Mandate } from "./mandates";
import { Invitation } from "./org";
import { Frame, RunRow, TranscriptEntry } from "./runs";
import { FindingFix } from "./spend";
import { LineageId } from "./steering";
import { KillSwitch } from "./tools";
import { seed } from "../adapters/fixture/seed";

const first = <T>(items: readonly T[]): T => {
  const item = items[0];
  if (item === undefined) throw new Error("the seed has rows here");
  return item;
};

describe("runs", () => {
  const row = RunRow.parse(first(seed.runs));

  it("rejects the mockup's vocabulary on a run row (negative)", () => {
    expect(RunRow.safeParse({ ...row, grade: "full" }).success).toBe(false);
    expect(RunRow.safeParse({ ...row, verdict: null }).success).toBe(false);
    expect(
      RunRow.safeParse({ ...row, cost: { micros: "4.13", currency: "USD" } })
        .success,
    ).toBe(false);
    expect(RunRow.safeParse({ ...row, status: "enrolled" }).success).toBe(
      false,
    );
  });

  it("keeps tier and grade nullable: not recorded is not a guess", () => {
    expect(RunRow.safeParse({ ...row, tier: null, grade: null }).success).toBe(
      true,
    );
  });

  it("requires a decimal seq cursor and a spec frame kind", () => {
    const frame = {
      seq: "0",
      kind: "agent.start",
      ts: "2026-09-11T09:14:02Z",
      tier: null,
      cost: null,
      summary: "",
      hash: null,
      prevHash: null,
    };
    expect(Frame.safeParse(frame).success).toBe(true);
    expect(Frame.safeParse({ ...frame, seq: 0 }).success).toBe(false);
    expect(Frame.safeParse({ ...frame, seq: "-1" }).success).toBe(false);
    expect(Frame.safeParse({ ...frame, kind: "tool_call" }).success).toBe(
      false,
    );
  });

  it("discriminates transcript entries by kind (negative)", () => {
    expect(
      TranscriptEntry.safeParse({
        kind: "text",
        body: "hi",
        offsetSeconds: 0,
        frameSeq: null,
      }).success,
    ).toBe(true);
    expect(
      TranscriptEntry.safeParse({
        kind: "text",
        offsetSeconds: 0,
        frameSeq: null,
      }).success,
    ).toBe(false);
    expect(
      TranscriptEntry.safeParse({
        kind: "thought",
        body: "hi",
        offsetSeconds: 0,
        frameSeq: null,
      }).success,
    ).toBe(false);
  });
});

describe("governance", () => {
  it("requires the four hops of an approval chain (negative)", () => {
    const approval = ApprovalItem.parse(first(seed.approvals));
    const { trigger: _trigger, ...threeHops } = approval.chain;
    expect(
      ApprovalItem.safeParse({ ...approval, chain: threeHops }).success,
    ).toBe(false);
    expect(
      ApprovalItem.safeParse({ ...approval, egress: "none" }).success,
    ).toBe(false);
  });

  it("refuses a mandate with no consequence or no tool (negative)", () => {
    const mandate = Mandate.parse(first(seed.mandates));
    expect(Mandate.safeParse({ ...mandate, consequenceTags: [] }).success).toBe(
      false,
    );
    expect(Mandate.safeParse({ ...mandate, tools: [] }).success).toBe(false);
  });

  it("gives every kill switch a public id and a spec level (negative)", () => {
    const sw = KillSwitch.parse(first(seed.killSwitches));
    expect(KillSwitch.safeParse({ ...sw, id: "ks_cls_funds" }).success).toBe(
      false,
    );
    expect(KillSwitch.safeParse({ ...sw, level: "Organization" }).success).toBe(
      false,
    );
  });

  it("only accepts definitions under .oxagen/agents (negative)", () => {
    const definition = AgentDefinition.parse(first(seed.definitions));
    expect(
      AgentDefinition.safeParse({
        ...definition,
        path: "agents/release-manager.toml",
      }).success,
    ).toBe(false);
  });
});

describe("organization, steering, spend and audit", () => {
  it("scopes an invitation to the org or to one workspace (negative)", () => {
    const base = {
      email: "rowan@acme.example",
      invitedById: "usr_marcusbell",
      sentOn: "2026-09-10",
      expiresOn: "2026-09-17",
    };
    expect(
      Invitation.safeParse({
        ...base,
        role: {
          scope: "workspace",
          role: "member",
          workspaceSlug: "core-platform",
        },
      }).success,
    ).toBe(true);
    expect(
      Invitation.safeParse({
        ...base,
        role: { scope: "workspace", role: "member" },
      }).success,
    ).toBe(false);
    expect(
      Invitation.safeParse({
        ...base,
        email: "rowan",
        role: { scope: "org", role: "viewer" },
      }).success,
    ).toBe(false);
  });

  it("names records by lineage (negative)", () => {
    expect(LineageId.safeParse("ctx.release.notes-format").success).toBe(true);
    expect(LineageId.safeParse("release.notes-format").success).toBe(false);
  });

  it("shapes a fix as an article or a Context PR, nothing else (negative)", () => {
    expect(
      FindingFix.safeParse({ shape: "pr", findingId: "fnd_01K5RT6C" }).success,
    ).toBe(false);
  });

  it("types an actor as a person, an agent or a system (negative)", () => {
    expect(
      Actor.safeParse({ kind: "agent", agentKey: "acme.core.triage" }).success,
    ).toBe(true);
    expect(
      Actor.safeParse({ kind: "agent", agentKey: "Marcus Bell" }).success,
    ).toBe(false);
  });

  it("counts only incident kinds as tamper detections", () => {
    for (const kind of TAMPER_INCIDENT_KINDS)
      expect(IncidentKind.safeParse(kind).success).toBe(true);
    expect(TAMPER_INCIDENT_KINDS).not.toContain("taint_raised");
  });
});
