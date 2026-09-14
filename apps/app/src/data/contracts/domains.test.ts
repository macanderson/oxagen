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

const usd = (micros: string) => ({ micros, currency: "USD" });

describe("runs", () => {
  const row = RunRow.parse({
    id: "run_01K5RS7M2E8FJ3QW",
    name: null,
    agentKey: "acme.core.release-manager",
    operatorId: "usr_marcusbell",
    workspaceSlug: "core-platform",
    status: "live",
    turns: 3,
    steps: 12,
    frames: 40,
    cost: usd("4130000"),
    tier: "harness",
    grade: "inspect",
    verdict: "unverified",
    taskRef: "#412",
    startedAt: "2026-09-11T09:14:02.000Z",
    sealedAt: null,
  });

  it("rejects the mockup's vocabulary on a run row (negative)", () => {
    expect(RunRow.safeParse({ ...row, grade: "full" }).success).toBe(false);
    expect(RunRow.safeParse({ ...row, verdict: "passed" }).success).toBe(false);
    expect(
      RunRow.safeParse({ ...row, cost: { micros: "4.13", currency: "USD" } })
        .success,
    ).toBe(false);
    expect(RunRow.safeParse({ ...row, status: "enrolled" }).success).toBe(
      false,
    );
  });

  it("keeps tier, grade and verdict nullable: not recorded is not a guess", () => {
    expect(
      RunRow.safeParse({ ...row, tier: null, grade: null, verdict: null })
        .success,
    ).toBe(true);
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
    const approval = ApprovalItem.parse({
      id: "apr_01K5RT0001",
      runId: "run_01K5RS7M2E8FJ3QW",
      workspaceSlug: "core-platform",
      status: "pending",
      chain: {
        operatorId: "usr_marcusbell",
        agentKey: "acme.core.release-manager",
        action: "github_open_pr@1.2",
        trigger: { kind: "policy", ref: "pol_01", detail: "writes to main" },
      },
      risk: "high",
      sideEffect: "write",
      egress: "third_party",
      amount: null,
      counterparty: null,
      mandateId: null,
      policyVersionId: null,
      inputDigest: "sha256:ab12",
      tainted: null,
      tier: "harness",
      requestedAt: "2026-09-11T09:20:00.000Z",
      expiresAt: "2026-09-11T10:20:00.000Z",
      approvers: { roles: ["owner"], eligiblePersonIds: [], excluded: [] },
      rules: null,
      taintSources: null,
    });
    const { trigger: _trigger, ...threeHops } = approval.chain;
    expect(
      ApprovalItem.safeParse({ ...approval, chain: threeHops }).success,
    ).toBe(false);
    expect(
      ApprovalItem.safeParse({ ...approval, egress: "none" }).success,
    ).toBe(false);
  });

  it("refuses a mandate with no consequence or no tool (negative)", () => {
    const mandate = Mandate.parse({
      id: "mnd_01K5RT0001",
      agentKey: "acme.core.release-manager",
      grantedById: "usr_marcusbell",
      roleAtGrant: "owner",
      secondApproverId: null,
      twoPerson: false,
      consequenceTags: ["moves_money"],
      limits: {
        perCall: usd("50000000"),
        perPeriod: usd("500000000"),
        period: "monthly",
        callsPerDay: null,
      },
      usage: {
        settled: usd("0"),
        reserved: usd("0"),
        remaining: usd("500000000"),
      },
      counterparties: { allow: [], deny: [] },
      tools: ["stripe_refund@*"],
      approval: {
        humanAbove: usd("10000000"),
        alwaysHumanFor: [],
        approvers: ["owner"],
      },
      purpose: "refunds under the support policy",
      validFrom: "2026-09-01",
      validTo: "2026-12-31",
      status: "active",
    });
    expect(Mandate.safeParse({ ...mandate, consequenceTags: [] }).success).toBe(
      false,
    );
    expect(Mandate.safeParse({ ...mandate, tools: [] }).success).toBe(false);
  });

  it("gives every kill switch a public id and a spec level (negative)", () => {
    const sw = KillSwitch.parse({
      id: "ksw_01K5RT0001",
      level: "class",
      target: "moves_money",
      on: false,
      headline: true,
      flippedById: null,
      flippedAt: null,
      reason: null,
      blastRadius: {
        agents: null,
        toolVersions: null,
        mandates: null,
        runsInFlight: null,
        grants24h: null,
      },
    });
    expect(KillSwitch.safeParse({ ...sw, id: "ks_cls_funds" }).success).toBe(
      false,
    );
    expect(KillSwitch.safeParse({ ...sw, level: "Organization" }).success).toBe(
      false,
    );
  });

  it("only accepts definitions under .oxagen/agents (negative)", () => {
    const definition = AgentDefinition.parse({
      agentKey: "acme.core.release-manager",
      path: ".oxagen/agents/release-manager.toml",
      digest: "sha256:ab12",
      commitSha: "0a1b2c3d4e5",
      source: "[agent]\nname = 'release-manager'",
      branches: [],
    });
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
