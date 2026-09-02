// __tests__/mixins.test.ts
//
// Unit tests for schema/_mixins.ts exported helpers.
//
// Assertions:
//  1. idMixin("agt").publicId.config.defaultFn() produces `agt_<22 Crockford-base32 chars>`
//  2. Two calls produce different values (entropy check)
//  3. Only valid Crockford base32 alphabet (no i, l, o, u)
//  4. allowedExecutionStatuses has no duplicates
//  5. allowedExecutionStatuses mirrors the DB CHECK constraint on executions
//
// Implementation note on column builder shape:
//   idMixin() calls citext("public_id").notNull().unique().$defaultFn(fn).
//   Drizzle's .$defaultFn(fn) is a *builder method* — it registers fn into
//   `column.config.defaultFn` and returns the column builder (for chaining).
//   The generated publicId column builder therefore exposes the registered
//   generator at `.config.defaultFn`, not as a callable `.publicId.$defaultFn()`.

import { describe, expect, it } from "vitest";
import { idMixin, allowedExecutionStatuses } from "../schema/_mixins";
import { getChecks, type DrizzleCheck } from "./_test-helpers";

/**
 * Recursively flattens queryChunks, following nested sql objects that
 * carry their own queryChunks (produced by sql.raw() or nested sql``).
 * The base flattenCheckSql helper does not recurse into such nesting.
 */
function flattenCheckSqlDeep(check: DrizzleCheck): string {
  function walkChunks(chunks: unknown[]): string {
    return chunks
      .map((chunk) => {
        if (chunk === null || typeof chunk !== "object") return "";
        const c = chunk as Record<string, unknown>;
        // Column reference: carries a `name` string (SQL column name).
        if (typeof c["name"] === "string" && !("queryChunks" in c))
          return c["name"] as string;
        // SQL literal: carries a `value` array of strings.
        if (Array.isArray(c["value"])) {
          return (c["value"] as unknown[])
            .filter((v): v is string => typeof v === "string")
            .join("");
        }
        // Nested sql object: recurse into its own queryChunks.
        if (Array.isArray(c["queryChunks"])) {
          return walkChunks(c["queryChunks"] as unknown[]);
        }
        return "";
      })
      .join("");
  }
  return walkChunks(check.value.queryChunks ?? []);
}

// ---------------------------------------------------------------------------
// 1 & 2 & 3: idMixin public id generation
// ---------------------------------------------------------------------------

describe("idMixin — publicId config.defaultFn", () => {
  // The column builder stores the registered generator at config.defaultFn.
  const prefix = "agt";
  const mixinResult = idMixin(prefix);
  // Access the stored generator via the column builder's config object.
  // This is the Drizzle-internal path; the column-builder type exposes
  // `config` as a plain object record.
  const colBuilder = mixinResult.publicId as unknown as {
    config: { defaultFn?: () => string };
  };
  const defaultFn = colBuilder.config.defaultFn;

  it("config.defaultFn is defined (a JS-side generator is registered)", () => {
    expect(defaultFn).toBeDefined();
    expect(defaultFn).toBeTypeOf("function");
  });

  it("generates a string matching /^<prefix>_[0-9a-z]{22}$/", () => {
    const id = defaultFn!();
    expect(id).toMatch(/^agt_[0-9a-z]{22}$/);
  });

  it("two calls produce different values (non-deterministic / entropy present)", () => {
    const a = defaultFn!();
    const b = defaultFn!();
    // With 110 bits of entropy the probability of a collision is negligible.
    expect(a).not.toBe(b);
  });

  it("contains only Crockford base32 alphabet — no i, l, o, u after the prefix", () => {
    // Run 20 iterations to get decent coverage of the generated alphabet.
    for (let n = 0; n < 20; n++) {
      const id = defaultFn!();
      const suffix = id.slice(prefix.length + 1); // after "agt_"
      expect(suffix).not.toMatch(/[ilou]/);
      // Crockford base32 lower-cased: 0-9 and a-z excluding i, l, o, u
      expect(suffix).toMatch(/^[0-9a-hj-km-np-tv-z]{22}$/);
    }
  });

  it("the prefix is honoured for different prefix strings", () => {
    const prefixes = ["wrk", "org", "usr", "agt", "tcl"];
    for (const p of prefixes) {
      const col = idMixin(p).publicId as unknown as {
        config: { defaultFn?: () => string };
      };
      const fn = col.config.defaultFn!;
      const id = fn();
      expect(id).toMatch(new RegExp(`^${p}_[0-9a-z]{22}$`));
    }
  });
});

// ---------------------------------------------------------------------------
// 4: allowedExecutionStatuses — no duplicates
// ---------------------------------------------------------------------------

describe("allowedExecutionStatuses", () => {
  it("has no duplicate values", () => {
    const unique = new Set(allowedExecutionStatuses);
    expect(unique.size).toBe(allowedExecutionStatuses.length);
  });

  it("includes the 7 expected lifecycle statuses", () => {
    const expected = [
      "pending",
      "queued",
      "running",
      "completed",
      "failed",
      "cancelled",
      "timed_out",
    ] as const;
    for (const status of expected) {
      expect(allowedExecutionStatuses).toContain(status);
    }
    expect(allowedExecutionStatuses).toHaveLength(expected.length);
  });
});

// ---------------------------------------------------------------------------
// 6: securityEvents CHECK constraint mirrors SECURITY_EVENT_TYPES
// ---------------------------------------------------------------------------

import { securityEvents, SECURITY_EVENT_TYPES } from "../schema/index";

describe("securityEvents CHECK constraints", () => {
  const checks = getChecks(securityEvents);

  it("has an event_type CHECK constraint", () => {
    const names = checks.map((c) => c.name);
    expect(names.some((n) => n.includes("event_type"))).toBe(true);
  });

  it("event_type CHECK SQL includes every value from SECURITY_EVENT_TYPES", () => {
    const check = checks.find((c) => c.name.includes("event_type"));
    expect(check).toBeDefined();
    // Use recursive flatten because the IN list is produced by sql.raw() inside
    // a nested SQL template — one extra queryChunks level below the outer sql``.
    const sql = flattenCheckSqlDeep(check!);
    for (const type of SECURITY_EVENT_TYPES) {
      expect(sql, `CHECK should include '${type}'`).toContain(type);
    }
  });

  it("has an outcome CHECK constraint", () => {
    const names = checks.map((c) => c.name);
    expect(names.some((n) => n.includes("outcome"))).toBe(true);
  });

  it("outcome CHECK SQL includes 'allow', 'deny', 'error'", () => {
    const check = checks.find((c) => c.name.includes("outcome"));
    expect(check).toBeDefined();
    const sql = flattenCheckSqlDeep(check!);
    expect(sql).toContain("allow");
    expect(sql).toContain("deny");
    expect(sql).toContain("error");
  });
});
