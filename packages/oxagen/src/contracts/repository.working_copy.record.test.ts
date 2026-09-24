import { describe, expect, it } from "vitest";
import { workingCopyRecord } from "./repository.working_copy.record";

const REPORT = {
  machineId: "0123456789abcdef",
  hostname: "mac-mini.local",
  directory: "/Users/ada/code/widgets",
  repository: "acme/widgets",
  branch: "main",
  headCommit: "abc1234",
  oxagenPresent: true,
  symlinks: "linked",
  pulledCommit: null,
  event: "init",
  cliVersion: "1.4.0",
};

describe("record_working_copy contract", () => {
  it("is a scoped write any workspace member may send, outside metering", () => {
    expect(workingCopyRecord.scoped).toBe(true);
    expect(workingCopyRecord.mutates).toBe(true);
    expect(workingCopyRecord.noBillingGate).toBe(true);
    expect(workingCopyRecord.defaultEffect).toBe("deny");
    expect(workingCopyRecord.surfaces).toEqual(["api", "cli"]);
    expect(workingCopyRecord.defaultRoles.workspace).toMatchObject({
      Member: "allow",
    });
  });

  it("admits a report with every field and nulls where the machine has nothing", () => {
    expect(workingCopyRecord.input.parse(REPORT)).toEqual(REPORT);
    const bare = {
      ...REPORT,
      repository: null,
      branch: null,
      headCommit: null,
      symlinks: "none",
      cliVersion: null,
    };
    expect(workingCopyRecord.input.safeParse(bare).success).toBe(true);
  });

  it("refuses a hardware serial as a machine id, an unknown event, and extra fields (negative)", () => {
    expect(
      workingCopyRecord.input.safeParse({
        ...REPORT,
        machineId: "C02XK0ABJG5H",
      }).success,
    ).toBe(false);
    expect(
      workingCopyRecord.input.safeParse({ ...REPORT, event: "clone" }).success,
    ).toBe(false);
    expect(
      workingCopyRecord.input.safeParse({ ...REPORT, contents: "x" }).success,
    ).toBe(false);
  });

  it("answers a wcp_ id and two instants", () => {
    const out = {
      workingCopyId: "wcp_0a1B",
      firstSeenAt: "2026-09-20T08:00:00.000Z",
      lastSeenAt: "2026-09-24T17:00:00.000Z",
    };
    expect(workingCopyRecord.output.parse(out)).toEqual(out);
    expect(
      workingCopyRecord.output.safeParse({ ...out, workingCopyId: "rpb_0a" })
        .success,
    ).toBe(false);
  });
});
