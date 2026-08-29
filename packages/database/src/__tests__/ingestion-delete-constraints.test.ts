/**
 * ingestion-delete-constraints.test.ts
 *
 * These tests assert the Drizzle schema (the sole source of truth Atlas diffs
 * against) keeps two CHECK constraints aligned with the values the handlers
 * write:
 *   - source_connections.status must permit 'deleting' (set by
 *     connection.delete) and 'deleted' (set by the async purge job).
 *   - deletion_jobs.delete_mode must permit the contract modes
 *     connection_only | data_only | full, and no others.
 */

import { describe, it, expect } from "vitest";
import { sourceConnections, deletionJobs } from "../schema/index";
import { flattenCheckSql, getChecks } from "./_test-helpers";

describe("source_connections.status CHECK", () => {
  const checks = getChecks(sourceConnections);
  const statusCheck = checks.find((c) => c.name.includes("status_check"));

  it("has a status_check constraint", () => {
    expect(
      statusCheck,
      `status_check not found in [${checks.map((c) => c.name).join(", ")}]`,
    ).toBeDefined();
  });

  // Every status the application writes must be permitted.
  for (const status of [
    "pending_setup",
    "connected",
    "paused",
    "error",
    "deleting",
    "deleted",
  ]) {
    it(`permits status '${status}'`, () => {
      expect(flattenCheckSql(statusCheck!)).toContain(`'${status}'`);
    });
  }
});

describe("deletion_jobs.delete_mode CHECK", () => {
  const checks = getChecks(deletionJobs);
  const modeCheck = checks.find((c) => c.name.includes("delete_mode_check"));

  it("has a delete_mode_check constraint", () => {
    expect(
      modeCheck,
      `delete_mode_check not found in [${checks.map((c) => c.name).join(", ")}]`,
    ).toBeDefined();
  });

  for (const mode of ["connection_only", "data_only", "full"]) {
    it(`permits contract mode '${mode}'`, () => {
      expect(flattenCheckSql(modeCheck!)).toContain(`'${mode}'`);
    });
  }

  for (const legacy of ["soft", "hard"]) {
    it(`no longer references legacy mode '${legacy}'`, () => {
      expect(flattenCheckSql(modeCheck!)).not.toContain(`'${legacy}'`);
    });
  }
});
