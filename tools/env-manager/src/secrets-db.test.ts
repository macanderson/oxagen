import { describe, expect, it } from "vitest";
import {
  createDb,
  editSecret,
  getSecret,
  listSecrets,
  openDb,
  upsertFromPull,
} from "./secrets-db";
import type { PullUpsert } from "./secrets-db";

function pull(over: Partial<PullUpsert> = {}): PullUpsert {
  return {
    key: "oxagen-stripe-secret",
    value: "sk_gcp",
    value_source: "gcp",
    active_version: "3",
    updated_at: "2026-03-20T00:00:00Z",
    is_duplicate: false,
    env_key: "STRIPE_SECRET_KEY",
    seedDescription: "Stripe secret key.",
    seedVendorUrl: "https://dashboard.stripe.com/apikeys",
    seedUsage: ["app:api"],
    ...over,
  };
}

describe("upsertFromPull", () => {
  it("inserts a new row with all seed values", () => {
    const db = createDb(":memory:");
    expect(upsertFromPull(db, pull(), "t0")).toBe("inserted");
    const row = getSecret(db, "oxagen-stripe-secret");
    expect(row?.value).toBe("sk_gcp");
    expect(row?.description).toBe("Stripe secret key.");
    expect(row?.usage).toEqual(["app:api"]);
    expect(row?.synced_at).toBe("t0");
  });

  it("refreshes machine columns on the second pull", () => {
    const db = createDb(":memory:");
    upsertFromPull(db, pull(), "t0");
    expect(
      upsertFromPull(
        db,
        pull({ value: "sk_gcp_2", active_version: "4", updated_at: "later" }),
        "t1",
      ),
    ).toBe("updated");
    const row = getSecret(db, "oxagen-stripe-secret");
    expect(row?.value).toBe("sk_gcp_2");
    expect(row?.active_version).toBe("4");
    expect(row?.synced_at).toBe("t1");
  });

  it("unions seed usage into existing usage without duplicating", () => {
    const db = createDb(":memory:");
    upsertFromPull(db, pull({ seedUsage: ["app:api"] }), "t0");
    upsertFromPull(db, pull({ seedUsage: ["app:api", "pkg:billing"] }), "t1");
    expect(getSecret(db, "oxagen-stripe-secret")?.usage).toEqual([
      "app:api",
      "pkg:billing",
    ]);
  });

  it("does NOT clobber human-locked columns on re-pull", () => {
    const db = createDb(":memory:");
    upsertFromPull(db, pull(), "t0");
    editSecret(db, "oxagen-stripe-secret", "value", "sk_manual");
    editSecret(db, "oxagen-stripe-secret", "description", "my note");
    editSecret(db, "oxagen-stripe-secret", "vendor_url", "https://custom");
    editSecret(db, "oxagen-stripe-secret", "usage", ["pkg:custom"]);

    upsertFromPull(
      db,
      pull({
        value: "sk_gcp_new",
        seedDescription: "seed",
        seedVendorUrl: "https://seed",
        seedUsage: ["app:app"],
      }),
      "t1",
    );

    const row = getSecret(db, "oxagen-stripe-secret");
    expect(row?.value).toBe("sk_manual");
    expect(row?.value_source).toBe("manual");
    expect(row?.description).toBe("my note");
    expect(row?.vendor_url).toBe("https://custom");
    expect(row?.usage).toEqual(["pkg:custom"]);
    // ...but machine columns still refreshed:
    expect(row?.active_version).toBe("3");
    expect(row?.synced_at).toBe("t1");
  });
});

describe("editSecret", () => {
  it("flips value source to manual and locks it", () => {
    const db = createDb(":memory:");
    upsertFromPull(db, pull(), "t0");
    const row = editSecret(db, "oxagen-stripe-secret", "value", "new");
    expect(row.value).toBe("new");
    expect(row.value_source).toBe("manual");
    expect(row.value_locked).toBe(true);
  });

  it("stores usage arrays as JSON and locks the column", () => {
    const db = createDb(":memory:");
    upsertFromPull(db, pull(), "t0");
    const row = editSecret(db, "oxagen-stripe-secret", "usage", [
      "app:app",
      "pkg:ui",
    ]);
    expect(row.usage).toEqual(["app:app", "pkg:ui"]);
    expect(row.usage_locked).toBe(true);
  });

  it("throws for an unknown secret key", () => {
    const db = createDb(":memory:");
    expect(() => editSecret(db, "nope", "description", "x")).toThrow(
      /unknown secret/,
    );
  });
});

describe("listSecrets / getSecret", () => {
  it("lists rows ordered by key and hydrates JSON + boolean columns", () => {
    const db = createDb(":memory:");
    upsertFromPull(db, pull({ key: "zeta", is_duplicate: true }), "t0");
    upsertFromPull(db, pull({ key: "alpha" }), "t0");
    const rows = listSecrets(db);
    expect(rows.map((r) => r.key)).toEqual(["alpha", "zeta"]);
    const zeta = rows.find((r) => r.key === "zeta");
    const alpha = rows.find((r) => r.key === "alpha");
    expect(zeta?.is_duplicate).toBe(true);
    expect(Array.isArray(alpha?.usage)).toBe(true);
  });

  it("returns null for a missing key", () => {
    const db = createDb(":memory:");
    expect(getSecret(db, "absent")).toBeNull();
  });
});

describe("openDb", () => {
  it("returns the same DB instance on repeated calls (module-level cache)", () => {
    // openDb caches _db at module scope; calling it twice must return the same object
    const db1 = openDb(":memory:");
    const db2 = openDb(":memory:");
    expect(db1).toBe(db2);
  });
});

describe("parseUsage (via upsertFromPull + getSecret)", () => {
  it("returns an empty array when the raw usage column is an empty string", () => {
    // Insert a row normally, then manually corrupt the usage column with an empty string
    const db = createDb(":memory:");
    upsertFromPull(db, pull({ seedUsage: [] }), "t0");
    // Directly overwrite to an empty string to exercise the empty-string branch
    db.prepare("UPDATE secrets SET usage = '' WHERE key = ?").run(
      "oxagen-stripe-secret",
    );
    const row = getSecret(db, "oxagen-stripe-secret");
    expect(row?.usage).toEqual([]);
  });

  it("returns an empty array when the usage column contains invalid JSON", () => {
    const db = createDb(":memory:");
    upsertFromPull(db, pull(), "t0");
    // Corrupt the usage column with malformed JSON
    db.prepare("UPDATE secrets SET usage = ? WHERE key = ?").run(
      "not-valid-json{{{",
      "oxagen-stripe-secret",
    );
    const row = getSecret(db, "oxagen-stripe-secret");
    expect(row?.usage).toEqual([]);
  });

  it("filters out non-string array members from the usage column", () => {
    const db = createDb(":memory:");
    upsertFromPull(db, pull(), "t0");
    // Store a JSON array that mixes string and non-string values
    db.prepare("UPDATE secrets SET usage = ? WHERE key = ?").run(
      JSON.stringify(["app:api", 42, null, "pkg:billing", true]),
      "oxagen-stripe-secret",
    );
    const row = getSecret(db, "oxagen-stripe-secret");
    expect(row?.usage).toEqual(["app:api", "pkg:billing"]);
  });

  it("returns empty array when usage column contains a JSON non-array (e.g. object)", () => {
    const db = createDb(":memory:");
    upsertFromPull(db, pull(), "t0");
    db.prepare("UPDATE secrets SET usage = ? WHERE key = ?").run(
      JSON.stringify({ key: "not-an-array" }),
      "oxagen-stripe-secret",
    );
    const row = getSecret(db, "oxagen-stripe-secret");
    expect(row?.usage).toEqual([]);
  });
});

describe("editSecret — additional field coverage", () => {
  it("edits description and locks desc_locked", () => {
    const db = createDb(":memory:");
    upsertFromPull(db, pull(), "t0");
    const row = editSecret(
      db,
      "oxagen-stripe-secret",
      "description",
      "updated description",
    );
    expect(row.description).toBe("updated description");
    expect(row.desc_locked).toBe(true);
  });

  it("edits vendor_url and locks vendor_locked", () => {
    const db = createDb(":memory:");
    upsertFromPull(db, pull(), "t0");
    const row = editSecret(
      db,
      "oxagen-stripe-secret",
      "vendor_url",
      "https://updated.example.com",
    );
    expect(row.vendor_url).toBe("https://updated.example.com");
    expect(row.vendor_locked).toBe(true);
  });

  it("accepts an array value for a non-usage field by joining with comma", () => {
    const db = createDb(":memory:");
    upsertFromPull(db, pull(), "t0");
    const row = editSecret(db, "oxagen-stripe-secret", "description", [
      "part1",
      "part2",
    ]);
    expect(row.description).toBe("part1,part2");
    expect(row.desc_locked).toBe(true);
  });

  it("accepts a single string for usage (wraps it in an array)", () => {
    const db = createDb(":memory:");
    upsertFromPull(db, pull(), "t0");
    const row = editSecret(db, "oxagen-stripe-secret", "usage", "app:mcp");
    expect(row.usage).toEqual(["app:mcp"]);
    expect(row.usage_locked).toBe(true);
  });
});
