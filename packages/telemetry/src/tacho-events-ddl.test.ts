import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BODY_MEMBER_NAMES, ENVELOPE_COLUMNS } from "@oxagen/tacho";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  bodyColumnType,
  RETIRED_COLUMNS,
  tachoEventsColumns,
  tachoEventsMigration,
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
    // does not meet an unknown column. Nothing writes it.
    const names = tachoEventsColumns().map((column) => column.name);
    expect(RETIRED_COLUMNS.length).toBeGreaterThan(0);
    for (const { name, after } of RETIRED_COLUMNS) {
      expect(names).toContain(name);
      expect(names.indexOf(name)).toBe(names.indexOf(after) + 1);
      expect(ENVELOPE_COLUMNS).not.toContain(name);
      expect(BODY_MEMBER_NAMES).not.toContain(name);
    }
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

  it("orders by tenant, session, and seq under ReplacingMergeTree", () => {
    const ddl = tachoEventsMigration();
    expect(ddl).toContain("ENGINE = ReplacingMergeTree(received_at)");
    expect(ddl).toContain("ORDER BY (org_id, workspace_id, session_uuid, seq)");
    expect(ddl).toContain("PARTITION BY toYYYYMM(ts)");
    expect(ddl).toContain("attrs Map(String, String)");
    expect(ddl).toContain("cost_usd_micros Nullable(UInt64)");
    expect(ddl).toContain("tool_targets Array(String)");
  });
});
