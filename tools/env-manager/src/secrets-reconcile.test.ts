import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseEnvFile,
  parseEnvText,
  reconcile,
  STAGE_SUFFIX,
} from "./secrets-reconcile";

describe("parseEnvFile", () => {
  it("reads and parses a real file from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "env-reconcile-"));
    const file = join(dir, ".env.local");
    writeFileSync(file, "REAL_KEY=real_value\n# comment\nANOTHER=123\n");
    const m = parseEnvFile(file);
    expect(m.get("REAL_KEY")).toBe("real_value");
    expect(m.get("ANOTHER")).toBe("123");
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns an empty map when the file does not exist", () => {
    const m = parseEnvFile("/nonexistent/path/.env.local");
    expect(m.size).toBe(0);
  });
});

describe("parseEnvText", () => {
  it("parses standard KEY=value lines, upper-casing the key", () => {
    const m = parseEnvText("Foo=bar\nBAZ=qux");
    expect(m.get("FOO")).toBe("bar");
    expect(m.get("BAZ")).toBe("qux");
  });

  it("strips markdown bullets used by creds.txt", () => {
    const m = parseEnvText(
      "- STRIPE_SECRET_KEY=sk_test_123\n  - DATABASE_URL=postgres://x",
    );
    expect(m.get("STRIPE_SECRET_KEY")).toBe("sk_test_123");
    expect(m.get("DATABASE_URL")).toBe("postgres://x");
  });

  it("ignores comments, blanks, and non-identifier keys", () => {
    const m = parseEnvText("# a comment\n\n123BAD=nope\nGOOD=yes");
    expect(m.has("123BAD")).toBe(false);
    expect(m.get("GOOD")).toBe("yes");
    expect(m.size).toBe(1);
  });

  it("unwraps a single surrounding double-quote pair", () => {
    expect(parseEnvText('K="quoted"').get("K")).toBe("quoted");
    expect(parseEnvText("K=plain").get("K")).toBe("plain");
  });

  it("keeps '=' that appear inside the value", () => {
    expect(
      parseEnvText("URL=postgres://u:p@h/db?sslmode=require").get("URL"),
    ).toBe("postgres://u:p@h/db?sslmode=require");
  });
});

describe("STAGE_SUFFIX", () => {
  it("matches stage-specific GCP names", () => {
    expect(STAGE_SUFFIX.test("oxagen-database-url-production")).toBe(true);
    expect(STAGE_SUFFIX.test("oxagen-stripe-secret-staging")).toBe(true);
    expect(STAGE_SUFFIX.test("oxagen-plaid-secret-sandbox")).toBe(true);
  });
  it("does not match unsuffixed or dev names", () => {
    expect(STAGE_SUFFIX.test("oxagen-stripe-secret")).toBe(false);
    expect(STAGE_SUFFIX.test("oxagen-database-url-development")).toBe(false);
  });
});

describe("reconcile", () => {
  const creds = new Map([["STRIPE_SECRET_KEY", "sk_creds"]]);
  const envLocal = new Map([["INNGEST_EVENT_KEY", "ev_env"]]);

  it("uses the creds.txt value for an unsuffixed secret and flags the duplicate", () => {
    const r = reconcile(
      "oxagen-stripe-secret",
      "STRIPE_SECRET_KEY",
      "sk_gcp",
      creds,
      envLocal,
    );
    expect(r).toEqual({
      value: "sk_creds",
      source: "creds.txt",
      isDuplicate: true,
    });
  });

  it("keeps the GCP value for a -production variant even though it's a duplicate", () => {
    const r = reconcile(
      "oxagen-stripe-secret-production",
      "STRIPE_SECRET_KEY",
      "sk_gcp_prod",
      creds,
      envLocal,
    );
    expect(r).toEqual({
      value: "sk_gcp_prod",
      source: "gcp",
      isDuplicate: true,
    });
  });

  it("falls back to .env.local only when GCP has no value", () => {
    const r = reconcile(
      "oxagen-inngest-event-key",
      "INNGEST_EVENT_KEY",
      null,
      creds,
      envLocal,
    );
    expect(r).toEqual({
      value: "ev_env",
      source: ".env.local",
      isDuplicate: true,
    });
  });

  it("returns the GCP value with no duplicate when nothing local matches", () => {
    const r = reconcile(
      "oxagen-novel-secret",
      null,
      "gcp_only",
      creds,
      envLocal,
    );
    expect(r).toEqual({ value: "gcp_only", source: "gcp", isDuplicate: false });
  });

  it("reports missing when neither GCP nor local has a value", () => {
    const r = reconcile("oxagen-empty", null, null, creds, envLocal);
    expect(r).toEqual({ value: null, source: "missing", isDuplicate: false });
  });

  it("matches via the canonicalized GCP name when no env key is supplied", () => {
    const c = new Map([["STRIPE_SECRET", "by_canon"]]);
    const r = reconcile("oxagen-stripe-secret", null, "gcp", c, new Map());
    expect(r).toEqual({
      value: "by_canon",
      source: "creds.txt",
      isDuplicate: true,
    });
  });

  it("uses creds even for a stage variant if GCP value is missing", () => {
    const r = reconcile(
      "oxagen-stripe-secret-staging",
      "STRIPE_SECRET_KEY",
      null,
      creds,
      envLocal,
    );
    expect(r).toEqual({
      value: "sk_creds",
      source: "creds.txt",
      isDuplicate: true,
    });
  });
});
