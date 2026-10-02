// The steering record rename (#4325). The record and its pull request took
// their steering names in one change (decision 1), and no old name stays as
// an alias (decision 3).
//
// The retired names are read from the migration that recorded them in
// iam.capability_renames, so this file spells only the current ones and a
// later rename adds its rows there, not here.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PERMISSION_CATALOG } from "../iam/permission-catalog";
import { getCapability, listCapabilities } from "../registry";
import "./index";

const MIGRATIONS = fileURLToPath(
  new URL("../../../database/atlas/migrations/", import.meta.url),
);

/** Every retired capability name and its replacement, from the migrations. */
function renames(): ReadonlyArray<{ retired: string; current: string }> {
  const out: Array<{ retired: string; current: string }> = [];
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"))) {
    const text = readFileSync(join(MIGRATIONS, file), "utf8");
    const at = text.indexOf("INSERT INTO iam.capability_renames");
    if (at === -1) continue;
    const statement = text.slice(at, text.indexOf(";", at));
    for (const m of statement.matchAll(/\('([a-z0-9_]+)', '([a-z0-9_]+)', '[^']*'\)/g)) {
      out.push({ retired: m[1]!, current: m[2]! });
    }
  }
  return out;
}

const STEERING_PR = [
  "open_steering_pr",
  "get_steering_pr",
  "get_steering_pr_diff",
  "refresh_steering_pr",
  "merge_steering_pr",
  "revert_steering_pr",
];

const STEERING_RECORD = [
  "list_steering_records",
  "publish_steering_record",
  "promote_steering_record",
  "revise_steering_record",
];

describe("the steering record rename (#4325)", () => {
  it("names the pull request of a steering record a steering PR (decision 1)", () => {
    for (const name of [...STEERING_PR, ...STEERING_RECORD]) {
      expect(getCapability(name), name).toBeDefined();
    }
  });

  it("records each retired name once, with a registered replacement", () => {
    const rows = renames();
    expect(rows.map((r) => r.current).sort()).toEqual(
      [...STEERING_PR, ...STEERING_RECORD]
        .filter((name) => name !== "revert_steering_pr")
        .sort(),
    );
    expect(new Set(rows.map((r) => r.retired)).size).toBe(rows.length);
    for (const { retired, current } of rows) {
      expect(retired).not.toBe(current);
      expect(getCapability(current), current).toBeDefined();
    }
  });

  it("keeps no retired name as an alias (decision 3)", () => {
    const registered = new Set(listCapabilities().map((c) => c.name));
    const granted = new Set(PERMISSION_CATALOG.flatMap((p) => p.capabilities));
    for (const { retired } of renames()) {
      expect(getCapability(retired), retired).toBeUndefined();
      expect(registered.has(retired), retired).toBe(false);
      expect(granted.has(retired), retired).toBe(false);
    }
  });

  it("describes no registered capability by the retired words", () => {
    const retiredWords = /\bcontext\s+(?:records?|PRs?)\b/i;
    for (const capability of listCapabilities()) {
      expect(capability.description, capability.name).not.toMatch(
        retiredWords,
      );
    }
  });
});
