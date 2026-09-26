import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BODY_MEMBER_NAMES, ENVELOPE_COLUMNS } from "@oxagen/tacho";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { splitStatements } from "./migrate";
import { parseRebuildDirective } from "./table-rebuild";
import {
  bodyColumnType,
  DROPPED_COLUMNS,
  RETIRED_COLUMNS,
  TACHO_EVENTS_MODIFIABLE_SETTINGS,
  TACHO_EVENTS_PARTITION_KEY,
  TACHO_EVENTS_TABLE_SETTINGS,
  tachoEventsColumns,
  tachoEventsCreatedColumns,
  tachoEventsMigration,
  tachoEventsModifySettings,
} from "./tacho-events-ddl";

const here = dirname(fileURLToPath(import.meta.url));

describe("tacho_events DDL", () => {
  it("is exactly what the committed migration carries", () => {
    const committed = readFileSync(
      join(here, "migrations", "0027_tacho_events.sql"),
      "utf8",
    );
    expect(committed).toBe(tachoEventsMigration());
  });

  it("has one column per envelope column and per body member, plus the stamped ones", () => {
    const names = tachoEventsColumns().map((column) => column.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.slice(0, 2)).toEqual(["org_id", "workspace_id"]);
    expect(names.slice(-2)).toEqual(["received_at", "chain_verified"]);
    for (const column of ENVELOPE_COLUMNS) expect(names).toContain(column);
    for (const member of BODY_MEMBER_NAMES) expect(names).toContain(member);
    expect(names.length).toBe(
      ENVELOPE_COLUMNS.length +
        BODY_MEMBER_NAMES.length +
        RETIRED_COLUMNS.length +
        4,
    );
  });

  it("carries every retired column, and no producer set names one", () => {
    // The point of retiring rather than deleting: the table still has the
    // column, so a cluster bootstrapped today matches one bootstrapped before
    // the retirement and a rollback to a release that still sends the field
    // does not meet an unknown column. Nothing writes it. The list may be
    // empty: a retired column leaves it once its drop migration lands.
    const names = tachoEventsColumns().map((column) => column.name);
    for (const { name, after } of RETIRED_COLUMNS) {
      expect(names).toContain(name);
      expect(names.indexOf(name)).toBe(names.indexOf(after) + 1);
      expect(ENVELOPE_COLUMNS).not.toContain(name);
      expect(BODY_MEMBER_NAMES).not.toContain(name);
    }
  });

  it("keeps each dropped column in 0027 and drops it in the migration named for it", () => {
    // 0027 stays byte-identical, so every cluster creates the column. The
    // named forward migration then removes it on every cluster, and the live
    // column set, which writers project onto, no longer has it.
    const created = tachoEventsCreatedColumns().map((column) => column.name);
    const live = tachoEventsColumns().map((column) => column.name);
    for (const { name, after, droppedBy } of DROPPED_COLUMNS) {
      expect(created.indexOf(name)).toBe(created.indexOf(after) + 1);
      expect(live).not.toContain(name);
      expect(ENVELOPE_COLUMNS).not.toContain(name);
      expect(BODY_MEMBER_NAMES).not.toContain(name);
      const drop = readFileSync(join(here, "migrations", droppedBy), "utf8");
      expect(drop).toMatch(
        new RegExp(
          `^ALTER TABLE tacho_events DROP COLUMN IF EXISTS ${name};$`,
          "m",
        ),
      );
    }
  });

  it("drops the readable email address from the live table (#3072)", () => {
    // The address is the one plaintext personal identifier the table ever
    // held. 0027 still creates it; 0031 removes it and the values it holds.
    expect(tachoEventsCreatedColumns().map((c) => c.name)).toContain(
      "anthropic_user_email",
    );
    expect(tachoEventsColumns().map((c) => c.name)).not.toContain(
      "anthropic_user_email",
    );
    expect(DROPPED_COLUMNS.map((c) => c.droppedBy)).toContain(
      "0031_drop_tacho_events_anthropic_user_email.sql",
    );
  });

  it("derives body column types from the Zod definitions", () => {
    expect(bodyColumnType(z.string().max(512).optional())).toBe("String");
    expect(bodyColumnType(z.enum(["a", "b"]).optional())).toBe(
      "LowCardinality(String)",
    );
    expect(bodyColumnType(z.boolean().optional())).toBe("Nullable(Bool)");
    expect(bodyColumnType(z.number().int().min(0).max(255).optional())).toBe(
      "Nullable(UInt8)",
    );
    expect(bodyColumnType(z.number().int().min(0).max(65_535).optional())).toBe(
      "Nullable(UInt16)",
    );
    expect(
      bodyColumnType(z.number().int().min(0).max(4_294_967_295).optional()),
    ).toBe("Nullable(UInt32)");
    expect(
      bodyColumnType(
        z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
      ),
    ).toBe("Nullable(UInt64)");
    expect(bodyColumnType(z.number().int().optional())).toBe(
      "Nullable(Float64)",
    );
    expect(bodyColumnType(z.number().optional())).toBe("Nullable(Float64)");
    expect(bodyColumnType(z.array(z.string()).optional())).toBe(
      "Array(String)",
    );
    expect(bodyColumnType(z.array(z.object({})).optional())).toBe("String");
    expect(bodyColumnType(z.unknown().optional())).toBe("String");
    expect(
      bodyColumnType(
        z
          .string()
          .refine(() => true)
          .nullable()
          .default(null),
      ),
    ).toBe("String");
  });

  it("carries the observed worktree columns, forward as well as generated", () => {
    // 0027 is generated, so a new body member rewrites a file that real
    // clusters applied months ago and will never apply again. The generated
    // file is what a cluster bootstrapped today gets; 0028 is what every
    // cluster bootstrapped before the columns existed gets. Both are needed,
    // which is why this asserts both.
    const ddl = tachoEventsMigration();
    expect(ddl).toContain("observed_changes String");
    expect(ddl).toContain("observed_changes_total Nullable(UInt32)");
    expect(ddl).toContain("observed_changes_truncated Nullable(Bool)");
    const forward = readFileSync(
      join(here, "migrations", "0028_tacho_observed_changes.sql"),
      "utf8",
    );
    for (const column of [
      "observed_changes",
      "observed_changes_total",
      "observed_changes_truncated",
    ]) {
      expect(forward).toContain(`ADD COLUMN IF NOT EXISTS ${column} `);
    }
  });

  it("carries the request effort and the deciding rules, forward as well as generated (#3891, #3971)", () => {
    // The same two halves as the worktree columns above: 0027 for a cluster
    // bootstrapped today, 0035 for every cluster that applied 0027 before
    // the members existed.
    const ddl = tachoEventsMigration();
    expect(ddl).toContain("request_effort String");
    expect(ddl).toContain("policy_rules Array(String)");
    const forward = readFileSync(
      join(
        here,
        "migrations",
        "0035_tacho_events_request_effort_policy_rules.sql",
      ),
      "utf8",
    );
    expect(forward).toContain(
      "ADD COLUMN IF NOT EXISTS request_effort String AFTER workspace_host_paths",
    );
    expect(forward).toContain(
      "ADD COLUMN IF NOT EXISTS policy_rules Array(String) AFTER policy_rule",
    );
  });

  it("expires rows thirteen months after the control plane received them (#3944)", () => {
    // The hot window ADR-058 sets for a run's frame rows. The clock is
    // received_at, the server's, never ts, which the producer chooses. The
    // TTL is not materialized on existing parts, because rewriting them all
    // at once holds the app node at its memory cap (ADR-181).
    const ttl = readFileSync(
      join(here, "migrations", "0032_tacho_events_ttl.sql"),
      "utf8",
    );
    const statements = ttl
      .split("\n")
      .filter((line) => line.trim() !== "" && !line.startsWith("--"));
    expect(statements).toEqual([
      "ALTER TABLE tacho_events MODIFY TTL toDateTime(received_at) + INTERVAL 13 MONTH SETTINGS materialize_ttl_after_modify = 0;",
    ]);
  });

  it("keeps inserts and merges out of the wide writer's memory, forward as well as generated (#4316)", () => {
    // A wide part of this table opens a buffer per column stream, about
    // 1.3 GiB against the node's 1.5 GiB cap. 0027 carries the settings for a
    // cluster created today; 0033 carries them to every cluster created
    // before. Both lines come from one list, and this holds them to it.
    const ddl = tachoEventsMigration();
    expect(ddl).toContain(
      "SETTINGS index_granularity = 8192, min_bytes_for_wide_part = 67108864, vertical_merge_algorithm_min_rows_to_activate = 1;",
    );
    const forward = readFileSync(
      join(here, "migrations", "0033_tacho_events_part_settings.sql"),
      "utf8",
    );
    const statements = forward
      .split("\n")
      .filter((line) => line.trim() !== "" && !line.startsWith("--"));
    expect(statements).toEqual([tachoEventsModifySettings()]);
    expect(TACHO_EVENTS_MODIFIABLE_SETTINGS.map(([name]) => name)).toEqual(
      TACHO_EVENTS_TABLE_SETTINGS.map(([name]) => name).filter(
        (name) => name !== "index_granularity",
      ),
    );
  });

  it("partitions by the month the control plane received a row, forward as well as generated (#4297)", () => {
    // The producer's clock filed a wrong-clock host's frames into the wrong
    // month, one part per month per batch. 0027 creates the table with the
    // server's clock for a cluster created today; 0034 rebuilds a table
    // created with the old key. Both come from one constant.
    expect(TACHO_EVENTS_PARTITION_KEY).toBe("toYYYYMM(received_at)");
    expect(tachoEventsMigration()).toContain(
      `PARTITION BY ${TACHO_EVENTS_PARTITION_KEY}\n`,
    );
    const forward = readFileSync(
      join(here, "migrations", "0034_tacho_events_partition_received_at.sql"),
      "utf8",
    );
    const statements = splitStatements(forward);
    expect(statements).toHaveLength(1);
    expect(parseRebuildDirective(statements[0] ?? "")).toEqual({
      table: "tacho_events",
      partitionBy: TACHO_EVENTS_PARTITION_KEY,
      column: "received_at",
    });
  });

  it("orders by tenant, session, and seq under ReplacingMergeTree", () => {
    const ddl = tachoEventsMigration();
    expect(ddl).toContain("ENGINE = ReplacingMergeTree(received_at)");
    expect(ddl).toContain("ORDER BY (org_id, workspace_id, session_uuid, seq)");
    expect(ddl).toContain("PARTITION BY toYYYYMM(received_at)");
    expect(ddl).toContain("attrs Map(String, String)");
    expect(ddl).toContain("cost_usd_micros Nullable(UInt64)");
    expect(ddl).toContain("tool_targets Array(String)");
  });
});
