/**
 * The steering head roles. Every reader that asks which repository steers a
 * workspace filters on STEERING_HEAD_ROLES, so the list has to name only roles
 * the table's CHECK admits, and `linked` must never be one of them.
 */

import { describe, expect, it } from "vitest";
import {
  isSteeringHeadRole,
  repositoryBindingHeads,
  STEERING_HEAD_ROLES,
} from "../schema/index";
import { flattenCheckSql, getChecks } from "./_test-helpers";

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

  for (const role of STEERING_HEAD_ROLES) {
    it(`names '${role}', which the role CHECK admits`, () => {
      expect(roleCheck).toBeDefined();
      expect(flattenCheckSql(roleCheck!)).toContain(`'${role}'`);
    });
  }
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
