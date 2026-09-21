import { describe, expect, it } from "vitest";
import {
  baselineOf,
  compareBaseline,
  scanSystemCalls,
  substantiveJustification,
} from "./check-system-db-justifications";

describe("system database bypass justifications", () => {
  it("finds direct, imported alias, namespace, computed, and local alias calls", () => {
    const calls = scanSystemCalls(
      "packages/example.ts",
      `
      import { withSystemDb as system } from '@oxagen/database';
      const local = system;
      const { withSystemDb: destructured } = database;
      withSystemDb(tx => tx.read());
      system(tx => tx.read());
      local(tx => tx.read());
      database.withSystemDb(tx => tx.read());
      database['withSystemDb'](tx => tx.read());
      destructured(tx => tx.read());
      // withSystemDb(tx => tx.read());
      const text = 'withSystemDb(tx => tx.read())';
    `,
    );
    expect(calls).toHaveLength(6);
    expect(calls.every((call) => !call.justified)).toBe(true);
  });

  it("requires a nearby comment naming the fence and does not accept a distant file comment", () => {
    const calls = scanSystemCalls(
      "packages/example.ts",
      `
      // tenancy: filtered by orgId after verified membership in the authenticated request.
      const first = withSystemDb(tx => tx.read());
      const second = withSystemDb(tx => tx.read());
      function run() {
        // tenancy: global lookup of public catalog rows with no org_id column.
        return withSystemDb(tx => tx.catalog());
      }
    `,
    );
    expect(calls.map((call) => call.justified)).toEqual([true, false, true]);
    expect(
      substantiveJustification("// tenancy: necessary system bypass"),
    ).toBe(false);
    expect(
      substantiveJustification(
        "// tenancy: this is a long comment that says nothing about a data boundary",
      ),
    ).toBe(false);
  });

  it("keeps formatting and comments out of the fingerprint, while detecting changed query scope", () => {
    const read = (body: string) =>
      scanSystemCalls("packages/example.ts", body)[0]?.fingerprint;
    expect(read("withSystemDb(tx=>tx.read(orgId));")).toBe(
      read("withSystemDb( tx => /* explanation */ tx.read(orgId) );"),
    );
    expect(read("withSystemDb(tx=>tx.read(orgId));")).not.toBe(
      read("withSystemDb(tx=>tx.read());"),
    );
  });

  it("rejects new or duplicated unreviewed calls while allowing a baseline to shrink", () => {
    const old = baselineOf(
      scanSystemCalls("packages/a.ts", "withSystemDb(tx => tx.read());"),
    );
    const duplicate = baselineOf(
      scanSystemCalls(
        "packages/a.ts",
        "withSystemDb(tx => tx.read()); withSystemDb(tx => tx.read());",
      ),
    );
    expect(compareBaseline(duplicate, old)).toHaveLength(1);
    expect(compareBaseline({}, old)).toEqual([]);
    expect(compareBaseline(old, {})).toHaveLength(1);
    expect(
      compareBaseline({ "packages/b.ts": old["packages/a.ts"] ?? [] }, old),
    ).toHaveLength(1);
  });

  it("removes justified sites from the active baseline and exposes obsolete exceptions", () => {
    const old = baselineOf(
      scanSystemCalls("packages/a.ts", "withSystemDb(tx => tx.read(orgId));"),
    );
    const current = baselineOf(
      scanSystemCalls(
        "packages/a.ts",
        "// tenancy: filtered by orgId after verified membership in the authenticated request.\nwithSystemDb(tx => tx.read(orgId));",
      ),
    );
    expect(current).toEqual({});
    expect(compareBaseline(old, current)).toHaveLength(1);
  });
});
