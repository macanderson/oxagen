/**
 * The steering head roles. Every reader that asks which repository steers a
 * workspace filters on STEERING_HEAD_ROLES, so the list has to name only roles
 * the table's CHECK admits, and `linked` must never be one of them.
 *
 * 20260927185600 moved every `main` head to `steering` and dropped `main`
 * from the CHECK (ADR-212). The schema here has to say the same, or Atlas
 * reads drift and a reader built on the list asks for a role no row holds.
 */

import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  isSteeringHeadRole,
  repositoryBindingHeads,
  STEERING_HEAD_ROLES,
} from "../schema/index";
import { type DrizzleCheck, flattenCheckSql, getChecks } from "./_test-helpers";

/** An index's partial predicate, flattened the way a CHECK is. */
function indexPredicate(name: string): string | undefined {
  const idx = getTableConfig(repositoryBindingHeads).indexes.find(
    (i) => i.config.name === name,
  );
  if (!idx?.config.where) return undefined;
  return flattenCheckSql({
    name,
    value: idx.config.where as unknown as DrizzleCheck["value"],
  });
}

describe("STEERING_HEAD_ROLES", () => {
  const roleCheck = getChecks(repositoryBindingHeads).find(
    (c) => c.name === "repository_binding_heads_role_check",
  );

  it("names the steering role", () => {
    expect(STEERING_HEAD_ROLES).toContain("steering");
  });

  it("never names the linked role", () => {
    expect(STEERING_HEAD_ROLES).not.toContain("linked");
  });

  it("is the steering role alone", () => {
    expect([...STEERING_HEAD_ROLES]).toEqual(["steering"]);
  });

  for (const role of STEERING_HEAD_ROLES) {
    it(`names '${role}', which the role CHECK admits`, () => {
      expect(roleCheck).toBeDefined();
      expect(flattenCheckSql(roleCheck!)).toContain(`'${role}'`);
    });
  }

  it("leaves 'main' out of the role CHECK", () => {
    expect(roleCheck).toBeDefined();
    const check = flattenCheckSql(roleCheck!);
    expect(check).not.toContain("'main'");
    expect(check).toContain("'linked'");
  });
});

describe("repository_binding_heads role column", () => {
  it("has no default role", () => {
    const role = getTableConfig(repositoryBindingHeads).columns.find(
      (c) => c.name === "role",
    );
    expect(role).toBeDefined();
    expect(role!.notNull).toBe(true);
    expect(role!.hasDefault).toBe(false);
  });
});

describe("steering head uniqueness", () => {
  const indexes = getTableConfig(repositoryBindingHeads).indexes;

  it("holds one workspace per steering repository", () => {
    const idx = indexes.find(
      (i) => i.config.name === "repository_binding_heads_main_repository_uq",
    );
    expect(idx?.config.unique).toBe(true);
    const where = indexPredicate("repository_binding_heads_main_repository_uq");
    expect(where).toContain("= 'steering'");
    expect(where).not.toContain("'main'");
  });

  it("holds one steering repository per workspace", () => {
    const idx = indexes.find(
      (i) => i.config.name === "repository_binding_heads_workspace_steering_uq",
    );
    expect(idx?.config.unique).toBe(true);
    expect(idx?.config.columns.map((c) => (c as { name: string }).name)).toEqual(
      ["workspace_id"],
    );
    expect(
      indexPredicate("repository_binding_heads_workspace_steering_uq"),
    ).toContain("= 'steering'");
  });

  it("leaves linked heads unlimited per workspace", () => {
    for (const i of indexes) {
      if (!i.config.unique) continue;
      const cols = i.config.columns.map((c) => (c as { name: string }).name);
      if (cols.length !== 1 || cols[0] !== "workspace_id") continue;
      expect(indexPredicate(i.config.name!)).toContain("'steering'");
    }
  });
});

describe("isSteeringHeadRole", () => {
  it("answers true for each steering head role", () => {
    for (const role of STEERING_HEAD_ROLES) {
      expect(isSteeringHeadRole(role)).toBe(true);
    }
  });

  it("answers false for a linked head and for a role the table never holds", () => {
    expect(isSteeringHeadRole("linked")).toBe(false);
    expect(isSteeringHeadRole("")).toBe(false);
    expect(isSteeringHeadRole("Steering")).toBe(false);
  });
});
