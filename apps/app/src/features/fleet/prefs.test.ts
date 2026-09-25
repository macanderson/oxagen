import { describe, expect, it } from "vitest";
import {
  DEFAULT_FLEET_PREFS,
  FLEET_COLUMNS,
  fleetPrefsCookieString,
  fleetPrefsValue,
  pageSizeOf,
  pullRequestFilterOf,
  readFleetPrefs,
  shownColumns,
  withColumn,
} from "./prefs";

describe("readFleetPrefs", () => {
  it("reads the page size and the hidden columns a cookie holds", () => {
    expect(readFleetPrefs("v1|100|summary~tokens")).toEqual({
      pageSize: 100,
      hidden: new Set(["summary", "tokens"]),
    });
  });

  it("reads no cookie as the defaults: 25 runs, every column", () => {
    expect(readFleetPrefs(undefined)).toBe(DEFAULT_FLEET_PREFS);
    expect(DEFAULT_FLEET_PREFS.pageSize).toBe(25);
    expect(shownColumns(DEFAULT_FLEET_PREFS)).toEqual([...FLEET_COLUMNS]);
  });

  it.each([
    ["another version", "v2|50|tier"],
    ["no version", "50|tier"],
    ["an empty value", ""],
    ["a value from elsewhere", "%7B%22a%22%3A1%7D"],
  ])("reads %s as the defaults (negative)", (_label, raw) => {
    expect(readFleetPrefs(raw)).toBe(DEFAULT_FLEET_PREFS);
  });

  it("drops a column this build does not know and keeps the rest (negative)", () => {
    expect(readFleetPrefs("v1|25|retired~tier~<script>").hidden).toEqual(
      new Set(["tier"]),
    );
  });

  it("never hides the run column, whatever the cookie says (negative)", () => {
    expect(readFleetPrefs("v1|25|run~agent").hidden).toEqual(
      new Set(["agent"]),
    );
  });

  it("reads a size the select does not offer as the default (negative)", () => {
    expect(readFleetPrefs("v1|7|").pageSize).toBe(25);
    expect(readFleetPrefs("v1|1000|").pageSize).toBe(25);
    expect(readFleetPrefs("v1||").pageSize).toBe(25);
  });
});

describe("the cookie a choice writes", () => {
  it("lists hidden columns in table order, so equal choices write equal text", () => {
    const prefs = {
      pageSize: 50 as const,
      hidden: new Set(["tokens", "agent"] as const),
    };
    expect(fleetPrefsValue(prefs)).toBe("v1|50|agent~tokens");
  });

  it("round-trips through the reader", () => {
    const prefs = {
      pageSize: 10 as const,
      hidden: new Set(["diff", "started"] as const),
    };
    expect(readFleetPrefs(fleetPrefsValue(prefs))).toEqual(prefs);
  });

  it("remembers the choice for a year on every path, Secure on https", () => {
    const cookie = fleetPrefsCookieString(DEFAULT_FLEET_PREFS, true);
    expect(cookie).toBe(
      "fleet_view=v1|25|; Path=/; Max-Age=31536000; SameSite=Lax; Secure",
    );
    expect(fleetPrefsCookieString(DEFAULT_FLEET_PREFS, false)).not.toContain(
      "Secure",
    );
  });

  it("writes only cookie-octets, so the value needs no encoding", () => {
    const all = { pageSize: 100 as const, hidden: new Set(FLEET_COLUMNS) };
    // RFC 6265 cookie-octet: no whitespace, DQUOTE, comma, semicolon or backslash.
    expect(fleetPrefsValue(all)).toMatch(
      /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/,
    );
  });
});

describe("withColumn", () => {
  it("hides and shows a column", () => {
    const hidden = withColumn(DEFAULT_FLEET_PREFS, "tier", false);
    expect(shownColumns(hidden)).not.toContain("tier");
    expect(shownColumns(withColumn(hidden, "tier", true))).toContain("tier");
  });

  it("leaves the run column shown (negative)", () => {
    expect(withColumn(DEFAULT_FLEET_PREFS, "run", false)).toBe(
      DEFAULT_FLEET_PREFS,
    );
  });
});

describe("pageSizeOf and pullRequestFilterOf", () => {
  it("reads each offered size and filter", () => {
    expect([10, 25, 50, 100].map((n) => pageSizeOf(String(n)))).toEqual([
      10, 25, 50, 100,
    ]);
    expect(pullRequestFilterOf("with")).toBe("with");
    expect(pullRequestFilterOf("without")).toBe("without");
  });

  it("reads anything else as the default (negative)", () => {
    expect(pageSizeOf("0")).toBe(25);
    expect(pageSizeOf(undefined)).toBe(25);
    expect(pullRequestFilterOf(undefined)).toBe("any");
    expect(pullRequestFilterOf("WITH")).toBe("any");
  });
});
