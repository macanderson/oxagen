import { describe, expect, it } from "vitest";
import raw from "./raw/mc-baseline-w1.json";
import * as markup from "./raw/markup-rows";
import {
  FIXTURE_NOW,
  MappingError,
  fromRelative,
  mapSeed,
  money,
  toInstant,
  toMicros,
  toSeconds,
} from "./mapping";
import { seed } from "./seed";
import { Seed } from "./seed-schema";

const run = (id: string) => {
  const found = seed.runs.find((r) => r.id === id);
  if (!found) throw new Error(`no run ${id}`);
  return found;
};

describe("scalar mapping", () => {
  it.each([
    ["2,450.00", "2450000000"],
    ["0.4126", "412600"],
    ["-193.08", "-193080000"],
    ["$884.60 USD", "884600000"],
    ["0.00", "0"],
    [6204.18, "6204180000"],
  ] as const)("dollars %s → %s micros", (dollars, micros) => {
    expect(toMicros(dollars)).toBe(micros);
  });

  it.each(["—", "two dollars", "1.2345678", ""])(
    "refuses a non-amount %j",
    (text) => {
      expect(() => toMicros(text)).toThrow(MappingError);
    },
  );

  it("attaches a basis only when one is given", () => {
    expect(money("4.13", "gateway_observed")).toEqual({
      micros: "4130000",
      currency: "USD",
      basis: "gateway_observed",
    });
    expect(money("4.13")).toEqual({ micros: "4130000", currency: "USD" });
  });

  it.each([
    ["09:14:02", "2026-09-11T09:14:02Z"],
    ["09:07:02.140", "2026-09-11T09:07:02.140Z"],
    ["09:31:08Z", "2026-09-11T09:31:08Z"],
    ["2026-09-10 23:12", "2026-09-10T23:12:00Z"],
    ["2026-09-02 09:14 UTC", "2026-09-02T09:14:00Z"],
    ["2026-09-11 06:00Z", "2026-09-11T06:00:00Z"],
    ["2026-03-02", "2026-03-02T00:00:00Z"],
  ])("clock %s → %s", (clock, instant) => {
    expect(toInstant(clock)).toBe(instant);
  });

  it("puts a bare clock on the day given", () => {
    expect(toInstant("11:31:12.004", "2025-07-02")).toBe(
      "2025-07-02T11:31:12.004Z",
    );
  });

  it.each(["yesterday", "9am", "25"])(
    "refuses a clock it cannot read: %s",
    (clock) => {
      expect(() => toInstant(clock)).toThrow(MappingError);
    },
  );

  it("resolves relative times against the fixture's now", () => {
    expect(fromRelative("2 min ago")).toBe("2026-09-11T15:58:00Z");
    expect(fromRelative("41 min")).toBe("2026-09-11T15:19:00Z");
    expect(fromRelative("2 h ago")).toBe("2026-09-11T14:00:00Z");
    expect(FIXTURE_NOW).toBe("2026-09-11T16:00:00Z");
    expect(() => fromRelative("a while ago")).toThrow(MappingError);
  });

  it("reads approval waits", () => {
    expect(toSeconds("4m 12s")).toBe(252);
    expect(toSeconds("47s")).toBe(47);
    expect(toSeconds("10m")).toBe(600);
    expect(() => toSeconds("")).toThrow(MappingError);
    expect(() => toSeconds("soon")).toThrow(MappingError);
  });
});

describe("the seed", () => {
  it("parses through every view-model contract", () => {
    expect(Seed.safeParse(mapSeed(raw, markup)).success).toBe(true);
  });

  it("carries every collection the mockup has", () => {
    expect(seed.runs).toHaveLength(raw.RUNS.length);
    expect(seed.agents).toHaveLength(raw.AGENTS.length);
    expect(seed.approvals).toHaveLength(raw.APPROVALS.length);
    expect(seed.toolVersions).toHaveLength(raw.TOOLS.length);
    expect(seed.spend.findings).toHaveLength(raw.FINDINGS.length);
    expect(seed.spend.fixes).toHaveLength(raw.FINDINGS.length);
    expect(seed.audit.receipts).toHaveLength(raw.RECEIPTS.length);
    expect(seed.notifications).toHaveLength(raw.NOTIFS.length);
  });

  it("fails loudly on a mockup value it has no mapping for", () => {
    const broken = structuredClone(raw);
    const first = broken.RUNS[0];
    if (!first) throw new Error("the mockup has runs");
    first.grade = "cinematic";
    expect(() => mapSeed(broken, markup)).toThrow(
      /unknown replay grade "cinematic"/,
    );
  });
});

describe("W3 vocabulary", () => {
  it("maps replay grades to the spec's verbs, weakest first", () => {
    expect(run("run_01K5RS7M2E8FJ3QW").grade).toBe("fork"); // full, Claude Code
    expect(run("run_01K5RQ4B9C7XTN2P").grade).toBe("retry"); // full, Stella
    expect(run("run_01K5RH3G8K5PAS7D").grade).toBe("view"); // partial
    expect(run("run_01K5RE9P4Q2WSX6C").grade).toBe("inspect"); // digest
    expect(run("run_01K4QJ9E4T6YUI1O").grade).toBe("inspect"); // ledger
  });

  it("spells an absent verdict `none`", () => {
    expect(run("run_01K5RS7M2E8FJ3QW").verdict).toBe("none");
  });

  it("maps egress, schema origin, consequence tags and agent status", () => {
    const tool = (name: string) =>
      seed.toolVersions.find((t) => t.name === name);
    expect(tool("snowflake__run_query")?.egress).toBe("org_tenant");
    expect(tool("claude_code__Bash")?.egress).toBe("local");
    expect(tool("slack__list_channels")?.schemaOrigin).toBe(
      "observed_proposed",
    );
    expect(tool("slack__list_channels")?.schemaDigest).toBeNull();
    expect(tool("stripe__create_payment")?.consequenceTags).toEqual([
      "moves_money",
    ]);
    expect(seed.agents.every((a) => a.status === "active")).toBe(true);
    expect(seed.approvals.find((a) => a.id === "apr_01K5RH8M2")?.egress).toBe(
      "local",
    );
  });

  it("stores money as integer micros, never a display string", () => {
    const approval = seed.approvals.find((a) => a.id === "apr_01K5RN9T4");
    expect(approval?.amount).toEqual({ micros: "2450000000", currency: "USD" });
    expect(seed.spend.summary.total.micros).toBe("18402660000");
  });

  it("maps severities and org roles to App. A values", () => {
    expect(
      seed.audit.events.find((e) => e.kind === "mandate.exception")?.severity,
    ).toBe(10);
    expect(seed.people.find((p) => p.name === "Priya Natarajan")?.orgRole).toBe(
      "owner",
    );
    expect(seed.people.find((p) => p.name === "Marcus Bell")).toMatchObject({
      id: "usr_marcusbell",
      orgRole: "member",
      workspaceRoles: [{ slug: "core-platform", role: "owner" }],
    });
  });

  it("reads the four-hop chain and the approver exclusion out of the mockup's prose", () => {
    const approval = seed.approvals.find((a) => a.id === "apr_01K5RN9T4");
    expect(approval?.chain).toEqual({
      operatorId: "usr_danaokafor",
      agentKey: "acme.finops.invoice-bot",
      action: "stripe__create_payment@4",
      trigger: {
        kind: "mandate",
        ref: "mnd_7K2ETQ4",
        detail: "approval.above_micros = 100000000",
      },
    });
    expect(approval?.approvers.excluded).toEqual([
      { personId: "usr_danaokafor", rule: "fin.no_self_approval" },
    ]);
  });

  it("keeps observed schemas as valid JSON with their presence notes lifted out", () => {
    for (const proposal of seed.observedSchemas) {
      expect(() => JSON.parse(proposal.schema) as unknown).not.toThrow();
      expect(() => JSON.parse(proposal.sample) as unknown).not.toThrow();
    }
    expect(
      seed.observedSchemas.find((o) => o.tool === "slack__list_channels")
        ?.notes,
    ).toEqual(["topic: present in 318 of 341", "cursor: present in 41 of 341"]);
  });

  it("strips syntax-highlight markup from fix samples", () => {
    for (const fix of seed.spend.fixes) {
      if (fix.shape === "article") expect(fix.before.code).not.toMatch(/<span/);
    }
  });
});

describe("W4 repairs", () => {
  it("keys frames by run: the approval-ending frame list belongs to the live release run", () => {
    expect(Object.keys(seed.frames)).toEqual(["run_01K5RS7M2E8FJ3QW"]);
    expect(seed.frames.run_01K5RS7M2E8FJ3QW?.at(-1)).toMatchObject({
      seq: "15",
      kind: "approval.request",
    });
  });

  it("points the unpaged-results evidence at the agent that owns the tool", () => {
    const evidence = seed.spend.evidence.find(
      (e) => e.findingId === "fnd_01K5RTGH",
    );
    expect(evidence?.who.agentKey).toBe("acme.finops.invoice-bot");
  });

  it("links a cited run only when the run is in the record", () => {
    const evidence = seed.spend.evidence.find(
      (e) => e.findingId === "fnd_01K5RT8D",
    );
    expect(evidence?.runs.every((r) => r.runId === null)).toBe(true);
  });

  it("repairs the triage run's second name", () => {
    const incident = seed.audit.incidents.find((i) => i.id === "inc_01K5RH8M3");
    expect(incident?.runIds).toEqual(["run_01K5RH3G8K5PAS7D"]);
    expect(incident?.scope).not.toContain("run_01K5RH8M2V");
  });

  it("adds the people who act in the mockup but were missing", () => {
    expect(seed.people.map((p) => p.name)).toEqual(
      expect.arrayContaining(["Sofia Ruiz", "Helena Vogt"]),
    );
  });
});
