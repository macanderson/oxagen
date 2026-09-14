// Every guard in the mapping fails loudly on a mockup shape it does not know,
// rather than inventing a value (negative tests for each guard).
import { describe, expect, it } from "vitest";
import raw from "./raw/mc-baseline-w1.json";
import * as markup from "./raw/markup-rows";
import { MappingError, cols, mapSeed, orgRoleOf, req } from "./mapping";

type Raw = typeof raw;
const broken = (change: (copy: Raw) => void) => {
  const copy = structuredClone(raw);
  change(copy);
  return () => mapSeed(copy, markup);
};
const firstOf = <T>(items: T[]): T => {
  const item = items[0];
  if (item === undefined) throw new Error("expected a row");
  return item;
};

describe("helpers", () => {
  it("req returns a present value and refuses a missing one", () => {
    expect(req("x", "thing")).toBe("x");
    expect(req(0, "zero")).toBe(0);
    expect(() => {
      req(undefined, "thing");
    }).toThrow(MappingError);
    expect(() => req(null, "thing")).toThrow(/unknown thing/);
  });

  it("cols returns exactly the columns asked for, as strings", () => {
    expect(cols(["a", 2, "c"], 2, "row")).toEqual(["a", "2"]);
    expect(() => cols(["a"], 2, "row")).toThrow(MappingError);
  });

  it("maps every org and workspace role, with or without a workspace", () => {
    expect(orgRoleOf("org.owner")).toEqual({ org: "owner", workspace: null });
    expect(orgRoleOf("org.billing · finops")).toEqual({
      org: "billing",
      workspace: { slug: "finops", role: "owner" },
    });
    expect(orgRoleOf("org.billing")).toEqual({
      org: "billing",
      workspace: null,
    });
    expect(orgRoleOf("org.auditor")).toEqual({
      org: "compliance",
      workspace: null,
    });
    expect(orgRoleOf("workspace.member · core-platform")).toEqual({
      org: "member",
      workspace: { slug: "core-platform", role: "member" },
    });
    expect(() => orgRoleOf("org.superuser")).toThrow(/unknown role/);
  });
});

describe("mapSeed refuses shapes it does not know (negative)", () => {
  it.each([
    [
      "an unknown harness",
      (r: Raw) => {
        firstOf(r.AGENTS).harness = "cursor";
      },
      /unknown harness/,
    ],
    [
      "an unknown avatar kind",
      (r: Raw) => {
        firstOf(r.AGENTS).avatar = { kind: "emoji", icon: "x", tone: "solid" };
      },
      /unknown avatar kind/,
    ],
    [
      "a role assignment it cannot parse",
      (r: Raw) => {
        r.AGENT_ROLES["acme.core.triage"] = ["Agent Graph Read"];
      },
      /unknown role assignment/,
    ],
    [
      "a belt entry the catalogue lacks",
      (r: Raw) => {
        r.AGENT_BELTS["acme.core.triage"] = ["nothing@1"];
      },
      /unknown belt entry/,
    ],
    [
      "an approval rule of an unknown kind",
      (r: Raw) => {
        firstOf(r.APPROVALS).rule = "vibes · approve";
      },
      /unknown approval rule/,
    ],
    [
      "an approvers line with no role list",
      (r: Raw) => {
        firstOf(r.APPROVALS).approvers = "anyone";
      },
      /unknown approver roles/,
    ],
    [
      "repository events it cannot read",
      (r: Raw) => {
        firstOf(r.REPOS).events = "fine";
      },
      /unknown repository events/,
    ],
    [
      "a record effect it cannot read",
      (r: Raw) => {
        firstOf(r.RECORDS).effect = "popular";
      },
      /unknown record effect/,
    ],
    [
      "a transcript entry of an unknown kind",
      (r: Raw) => {
        firstOf(r.TRANSCRIPTS.run_01K5RS7M2E8FJ3QW).kind = "dream";
      },
      /unknown transcript entry kind/,
    ],
    [
      "a transcript usage entry with no model",
      (r: Raw) => {
        const usage = r.TRANSCRIPTS.run_01K5RS7M2E8FJ3QW.find(
          (e) => e.kind === "usage",
        );
        if (usage) delete usage.meta;
      },
      /unknown transcript model/,
    ],
    [
      "a waste badge with no tone",
      (r: Raw) => {
        firstOf(r.SPEND.wasteRunsList).badges = [["tampered"]];
      },
      /unknown badge/,
    ],
    [
      "a cited run with missing columns",
      (r: Raw) => {
        firstOf(r.EVIDENCE.fnd_01K5RTGH.runs).splice(3);
      },
      /unknown cited run/,
    ],
    [
      "a retention tier with missing columns",
      (r: Raw) => {
        firstOf(r.RETENTION_TIERS).splice(2);
      },
      /unknown retention tier/,
    ],
    [
      "no simulated policy version",
      (r: Raw) => {
        for (const p of r.POLICIES) p.state = "active";
      },
      /unknown simulated policy version/,
    ],
    [
      "a billing discount it cannot read",
      (r: Raw) => {
        r.BILLING.discount = "a nice discount";
      },
      /unknown billing discount/,
    ],
    [
      "an unknown kill switch level",
      (r: Raw) => {
        firstOf(r.SWITCHES).lvl = "Galaxy";
      },
      /unknown switch level/,
    ],
  ])("%s", (_name, change, message) => {
    expect(broken(change)).toThrow(message);
  });
});
