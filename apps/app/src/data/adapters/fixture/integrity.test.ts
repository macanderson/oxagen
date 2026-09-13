// Plan W4: the fixture seed must fail this test on any dangling id. It was
// mutation-tested once by deleting an agent from raw/mc-baseline-w1.json; the
// negative cases below keep that guard honest on every run.
import { describe, expect, it } from "vitest";
import { findDanglingReferences } from "./integrity";
import { seed } from "./seed";
import type { Seed } from "./seed-schema";

const agentKeys = new Set(seed.agents.map((a) => a.key));
const runIds = new Set(seed.runs.map((r) => r.id));
const personIds = new Set(seed.people.map((p) => p.id));
const mandateIds = new Set(seed.mandates.map((m) => m.id));

describe("fixture referential integrity", () => {
  it("has no dangling reference anywhere in the seed", () => {
    expect(findDanglingReferences(seed)).toEqual([]);
  });

  it.each(seed.runs)("run $id → agent and operator exist", (r) => {
    expect(agentKeys).toContain(r.agentKey);
    expect(personIds).toContain(r.operatorId);
  });

  it.each(seed.approvals)(
    "approval $id → run, agent and mandate exist",
    (a) => {
      expect(runIds).toContain(a.runId);
      expect(agentKeys).toContain(a.chain.agentKey);
      if (a.mandateId) expect(mandateIds).toContain(a.mandateId);
    },
  );

  it.each(seed.notifications.filter((n) => n.runId !== null))(
    "notification $id → run exists",
    (n) => {
      expect(runIds).toContain(n.runId);
    },
  );

  it.each(Object.keys(seed.frames))("frames keyed by a real run: %s", (id) => {
    expect(runIds).toContain(id);
  });

  it("every finding's evidence names a known agent, or none", () => {
    for (const e of seed.spend.evidence) {
      if (e.who.agentKey !== null) expect(agentKeys).toContain(e.who.agentKey);
    }
  });

  it("every agent's mandate exists and names that agent", () => {
    for (const a of seed.agents) {
      for (const id of a.mandateIds ?? []) {
        expect(seed.mandates.find((m) => m.id === id)?.agentKey).toBe(a.key);
      }
    }
  });
});

describe("the integrity check catches what it guards (negative)", () => {
  const mutate = (change: (copy: Seed) => void): Seed => {
    const copy = structuredClone(seed);
    change(copy);
    return copy;
  };

  it("reports every reference to a deleted agent", () => {
    const broken = mutate((s) => {
      s.agents = s.agents.filter((a) => a.key !== "acme.core.triage");
    });
    const refs = findDanglingReferences(broken);
    expect(refs).toEqual(
      expect.arrayContaining([
        {
          at: "runs[run_01K5RP2D6H4KLM8V].agentKey",
          expected: "agents",
          ref: "acme.core.triage",
        },
        {
          at: "approvals[apr_01K5RH8M2].chain.agentKey",
          expected: "agents",
          ref: "acme.core.triage",
        },
        {
          at: "toolbelts[acme.core.triage]",
          expected: "agents",
          ref: "acme.core.triage",
        },
      ]),
    );
  });

  it("reports frames keyed by a run that is not in the record", () => {
    const broken = mutate((s) => {
      s.frames.run_01ZZZZZZZZZZZZZZ = [];
    });
    expect(findDanglingReferences(broken)).toContainEqual({
      at: "frames[run_01ZZZZZZZZZZZZZZ]",
      expected: "runs",
      ref: "run_01ZZZZZZZZZZZZZZ",
    });
  });

  it("reports an approval whose agent is not its run's agent", () => {
    const broken = mutate((s) => {
      const approval = s.approvals.find((a) => a.id === "apr_01K5RS3K7");
      if (approval) approval.chain.agentKey = "acme.core.triage";
    });
    expect(findDanglingReferences(broken)).toContainEqual({
      at: "approvals[apr_01K5RS3K7].chain.agentKey",
      expected: "the agent of run_01K5RS7M2E8FJ3QW",
      ref: "acme.core.triage",
    });
  });

  it("reports a notification, receipt and ledger entry pointing nowhere", () => {
    const broken = mutate((s) => {
      const note = s.notifications[0];
      if (note) note.ref = "apr_01ZZZZ";
      const receipt = s.audit.receipts[0];
      if (receipt) receipt.runId = "run_01ZZZZ";
      const entry = s.mandateLedger[0];
      if (entry) entry.receiptId = "rcp_01ZZZZ";
    });
    const refs = findDanglingReferences(broken).map((d) => d.ref);
    expect(refs).toEqual(
      expect.arrayContaining(["apr_01ZZZZ", "run_01ZZZZ", "rcp_01ZZZZ"]),
    );
  });

  it("reports organization-level targets that name another organization", () => {
    const broken = mutate((s) => {
      const org = s.killSwitches.find((k) => k.level === "org");
      if (org) org.target = "globex";
      const budget = s.spend.budgets.find((b) => b.scopeKind === "org");
      if (budget) budget.scopeId = "globex";
    });
    expect(
      findDanglingReferences(broken).filter(
        (d) => d.expected === "organization",
      ),
    ).toHaveLength(2);
  });

  it("reports onboarding data that names another organization, a stranger or a namespace no agent uses", () => {
    const broken = mutate((s) => {
      const [first] = s.onboarding.invitations;
      if (first) {
        first.orgSlug = "globex";
        first.inviterName = "Nobody Atall";
      }
      s.onboarding.namespaces.workspaces["core-platform"] = "platform";
      s.onboarding.firstFrame.host = "elsewhere.local";
    });
    const refs = findDanglingReferences(broken);
    expect(refs.map((d) => d.expected)).toEqual(
      expect.arrayContaining([
        "organization",
        "people",
        "the installer's host",
      ]),
    );
    expect(
      refs.some(
        (d) =>
          d.at === "agents[acme.core.release-manager].key" &&
          d.expected === "a key minted in acme.platform.",
      ),
    ).toBe(true);
  });

  it("reports proposal, drill, finding and budget references by their kind", () => {
    const broken = mutate((s) => {
      for (const p of s.proposals) p.source.ref = "nobody";
      for (const d of s.spend.drills) d.id = "nothing";
      for (const f of s.spend.findings) f.subject = "nothing";
      for (const b of s.spend.budgets) b.scopeId = "nothing";
      for (const k of s.killSwitches) k.target = "nothing";
    });
    const expected = new Set(
      findDanglingReferences(broken).map((d) => d.expected),
    );
    for (const kind of [
      "findings",
      "runs",
      "people",
      "agents",
      "tools",
      "workspaces",
      "servers",
      "toolVersions",
      "organization",
    ]) {
      expect(expected).toContain(kind);
    }
  });
});
