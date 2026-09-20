/**
 * The label a person reads in the OpenRouter account (ADR-131).
 *
 * The function is pure and total, so these tests are about the two things
 * that matter to a reader of the vendor's key list: the name identifies one
 * organisation and one person, and nothing a customer can type into a slug or
 * an email can break the line it is printed on.
 */
import { describe, expect, it } from "vitest";
import {
  ASSISTANT_KEY_NAME_MAX,
  ASSISTANT_KEY_NAME_PREFIX,
  assistantKeyName,
} from "./assistant-key-name";

describe("assistantKeyName", () => {
  it("names the product, the organisation and the person, in that order", () => {
    expect(
      assistantKeyName({
        orgSlug: "acme-corp",
        creatorEmail: "dana@acme.example",
      }),
    ).toBe("oxagen/acme-corp/dana@acme.example");
  });

  it("marks every key it mints with the product prefix", () => {
    // A key made by hand in the OpenRouter dashboard has no prefix, so this
    // is how an operator tells a provisioned key from one someone typed.
    const name = assistantKeyName({ orgSlug: "a", creatorEmail: "b@c.d" });
    expect(name.startsWith(`${ASSISTANT_KEY_NAME_PREFIX}/`)).toBe(true);
  });

  it("lowercases both fields so two spellings of one address are one name", () => {
    expect(
      assistantKeyName({ orgSlug: "ACME", creatorEmail: "Dana@Acme.Example" }),
    ).toBe("oxagen/acme/dana@acme.example");
  });

  // ── Nothing a customer types can break the line ────────────────────────────

  it("strips control characters, so a newline cannot split a log line in two", () => {
    expect(
      assistantKeyName({
        orgSlug: "acme\ncorp",
        creatorEmail: "dana\u0000@acme.example",
      }),
    ).toBe("oxagen/acmecorp/dana@acme.example");
  });

  it("replaces the separator, so a slug cannot forge a field", () => {
    // Without this, a slug of `a/b@evil.example` would read as an
    // organisation `a` created by `b@evil.example`.
    expect(
      assistantKeyName({
        orgSlug: "a/b@evil.example",
        creatorEmail: "dana@acme.example",
      }),
    ).toBe("oxagen/a-b@evil.example/dana@acme.example");
  });

  it("trims, so a padded field does not read as a different one", () => {
    expect(
      assistantKeyName({
        orgSlug: "  acme  ",
        creatorEmail: " dana@acme.example ",
      }),
    ).toBe("oxagen/acme/dana@acme.example");
  });

  it("renders a missing field as `unknown` rather than collapsing the name", () => {
    // `oxagen//` reads as a bug in the provisioner. `unknown` reads as
    // missing information, which is what it is.
    expect(assistantKeyName({ orgSlug: "", creatorEmail: "" })).toBe(
      "oxagen/unknown/unknown",
    );
    expect(
      assistantKeyName({
        orgSlug: "acme",
        creatorEmail: "   ",
      }),
    ).toBe("oxagen/acme/unknown");
  });

  it("never throws, whatever it is handed", () => {
    // It runs on the organisation-creation path. A name that cannot be built
    // must not be the reason an organisation fails to get a key.
    const hostile = [
      undefined,
      null,
      "",
      "\u0000\u001f\u007f",
      "/".repeat(500),
      "😀".repeat(200),
    ] as unknown as string[];
    for (const slug of hostile) {
      for (const email of hostile) {
        expect(() =>
          assistantKeyName({ orgSlug: slug, creatorEmail: email }),
        ).not.toThrow();
      }
    }
  });

  // ── The bound ──────────────────────────────────────────────────────────────

  it("bounds the name and marks that something was cut", () => {
    const name = assistantKeyName({
      orgSlug: "acme",
      creatorEmail: `${"d".repeat(300)}@acme.example`,
    });
    expect(name.length).toBe(ASSISTANT_KEY_NAME_MAX);
    expect(name.endsWith("…")).toBe(true);
    // The ellipsis is the point: without it a truncated address reads as a
    // whole one, and someone mails it.
    expect(name.startsWith("oxagen/acme/")).toBe(true);
  });

  it("keeps the slug whole when it truncates, because that is what an operator searches by", () => {
    const name = assistantKeyName({
      orgSlug: "a-very-long-organisation-slug-that-is-still-legitimate",
      creatorEmail: `${"d".repeat(300)}@acme.example`,
    });
    expect(name).toContain(
      "oxagen/a-very-long-organisation-slug-that-is-still-legitimate/",
    );
  });
});
