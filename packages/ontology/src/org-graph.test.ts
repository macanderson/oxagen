import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: vi.fn() }));
vi.mock("./client", () => ({
  driver: () => ({ session: mocks.session }),
}));

import {
  isOrgGraphDatabaseName,
  listOrgGraphDatabases,
  OrgGraphNameError,
  orgGraphDatabaseName,
  systemSession,
} from "./org-graph";

describe("orgGraphDatabaseName", () => {
  it("names the database org-<namespace>", () => {
    expect(orgGraphDatabaseName("acme")).toBe("org-acme");
    expect(orgGraphDatabaseName("a1")).toBe("org-a1");
  });

  it("lowercases a citext namespace, since Neo4j normalises names", () => {
    expect(orgGraphDatabaseName("AcMe")).toBe("org-acme");
  });

  it.each([
    ["too short", "a"],
    ["too long", "abcdefg"],
    ["an underscore", "ac_me"],
    ["a dash", "ac-me"],
    ["a dot", "a.b"],
    ["a backtick", "a`b"],
    ["whitespace", "a b"],
    ["non-ASCII", "acmé"],
    ["an injection attempt", "x` IF NOT EXISTS; DROP DATABASE neo4j //"],
    ["empty", ""],
  ])("refuses a namespace with %s", (_why, ns) => {
    expect(() => orgGraphDatabaseName(ns)).toThrow(OrgGraphNameError);
  });

  it("carries a stable code", () => {
    try {
      orgGraphDatabaseName("_");
    } catch (err) {
      expect((err as OrgGraphNameError).code).toBe("org_graph_name_invalid");
    }
  });
});

describe("isOrgGraphDatabaseName", () => {
  it.each([
    ["org-acme", true],
    ["org-a1", true],
    ["neo4j", false],
    ["system", false],
    ["org_acme", false],
    ["ORG-ACME", false],
    // Legal Neo4j names under the prefix that the provisioner cannot produce:
    // the migrator must not touch a database somebody else named.
    ["org-analytics", false],
    ["org-a", false],
    ["org-ab.cd", false],
    ["org-ab-cd", false],
    ["org-", false],
    ["org-abcdefg", false],
  ])("%s → %s", (name, expected) => {
    expect(isOrgGraphDatabaseName(name)).toBe(expected);
  });
});

describe("listOrgGraphDatabases", () => {
  it("returns only organisation databases, sorted, and closes the session", async () => {
    const close = vi.fn(async () => undefined);
    const run = vi.fn(async () => ({
      records: [
        "system",
        "org-zz",
        "neo4j",
        "org-ab",
        "org-analytics",
        "org-ab.cd",
      ].map((name) => ({
        get: () => name,
      })),
    }));
    const names = await listOrgGraphDatabases(() => ({ run, close }) as never);
    expect(names).toEqual(["org-ab", "org-zz"]);
    expect(run).toHaveBeenCalledWith(
      "SHOW DATABASES YIELD name RETURN DISTINCT name",
    );
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes the session when SHOW DATABASES fails", async () => {
    const close = vi.fn(async () => undefined);
    const run = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(
      listOrgGraphDatabases(() => ({ run, close }) as never),
    ).rejects.toThrow("boom");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("defaults to a session on the system database", async () => {
    mocks.session.mockReturnValue({
      run: async () => ({ records: [] }),
      close: async () => undefined,
    });
    await expect(listOrgGraphDatabases()).resolves.toEqual([]);
    expect(mocks.session).toHaveBeenCalledWith({ database: "system" });
    systemSession();
    expect(mocks.session).toHaveBeenLastCalledWith({ database: "system" });
  });
});
