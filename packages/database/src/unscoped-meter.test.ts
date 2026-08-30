import { describe, expect, it } from "vitest";
import { runInTenantScope } from "@oxagen/tenancy";
import { recordIfUnscoped, __unscopedCountForTests } from "./unscoped-meter";

const ORG = "00000000-0000-0000-0000-00000000a111";
const WS = "00000000-0000-0000-0000-00000000b222";

describe("unscoped meter", () => {
  it("counts a call with no active scope", () => {
    const before = __unscopedCountForTests();
    recordIfUnscoped("db.read");
    expect(__unscopedCountForTests()).toBe(before + 1);
  });

  it("does not count a call inside a scope", () => {
    const before = __unscopedCountForTests();
    runInTenantScope({ orgId: ORG, workspaceId: WS }, () =>
      recordIfUnscoped("db.read"),
    );
    expect(__unscopedCountForTests()).toBe(before);
  });
});
