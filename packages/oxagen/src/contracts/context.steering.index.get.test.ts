import { describe, expect, it } from "vitest";
import { steeringIndexGet } from "./context.steering.index.get";

const CONTEXT = {
  runtimes: ["ci-linux-01"],
  members: [],
  teams: [],
  groups: [],
  credentials: ["stripe-live"],
};

const RECORD = {
  lineage: "rec_billing_refunds",
  path: "steering/billing/refunds.md",
  id: "rec_billing_refunds_0a1b2c3d4e5f",
  hash: `sha256:${"0".repeat(64)}`,
  kind: "constraint",
  effect: "require",
};

describe("get_steering_index contract", () => {
  it("is a scoped read on api and cli, outside metering", () => {
    expect(steeringIndexGet.scoped).toBe(true);
    expect(steeringIndexGet.mutates).toBe(false);
    expect(steeringIndexGet.noBillingGate).toBe(true);
    expect(steeringIndexGet.sensitivity).toBe("low");
    expect(steeringIndexGet.surfaces).toEqual(["api", "cli"]);
  });

  it("takes no input", () => {
    expect(steeringIndexGet.input.parse({})).toEqual({});
    expect(steeringIndexGet.input.safeParse({ runId: "run_1" }).success).toBe(
      false,
    );
  });

  it("answers a null index before the first publish", () => {
    const out = { index: null, context: CONTEXT };
    expect(steeringIndexGet.output.parse(out)).toEqual(out);
  });

  it("answers the records of the published version", () => {
    const out = {
      index: { records: [RECORD, { ...RECORD, kind: "memory", effect: null }] },
      context: CONTEXT,
    };
    expect(steeringIndexGet.output.parse(out)).toEqual(out);
  });

  it("refuses a record or a context with a field the checks do not read", () => {
    expect(
      steeringIndexGet.output.safeParse({
        index: { records: [{ ...RECORD, blob: "abc" }] },
        context: CONTEXT,
      }).success,
    ).toBe(false);
    expect(
      steeringIndexGet.output.safeParse({
        index: null,
        context: { ...CONTEXT, secrets: [] },
      }).success,
    ).toBe(false);
  });
});

// IAM. The kernel's gate reads these grants on the enterprise path. On every
// other tier it allows before it reads them, and workspace membership at the
// route is the fence (apps/api/src/middleware/workspace.ts).
describe("get_steering_index grants", () => {
  const roles = steeringIndexGet.defaultRoles;
  const allowed = (
    grants: Readonly<Record<string, string | undefined>>,
    role: string,
  ) => grants[role] === "allow";

  it("allows a workspace Member, Admin, and Owner", () => {
    expect(allowed(roles.workspace, "Member")).toBe(true);
    expect(allowed(roles.workspace, "Admin")).toBe(true);
    expect(allowed(roles.workspace, "Owner")).toBe(true);
  });

  it("allows an org Owner and Admin", () => {
    expect(roles.org).toEqual({ Owner: "allow", Admin: "allow" });
  });

  it("denies a workspace role outside the defaults", () => {
    for (const role of ["Viewer", "Billing", "Compliance"]) {
      expect(allowed(roles.workspace, role)).toBe(false);
    }
  });

  it("denies a caller who holds no role", () => {
    expect(steeringIndexGet.defaultEffect).toBe("deny");
  });
});
