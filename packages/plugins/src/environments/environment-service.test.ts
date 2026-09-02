import { describe, expect, it } from "vitest";
import {
  ENVIRONMENT_SLUG_PATTERN,
  isValidEnvironmentSlug,
} from "./environment-service";

describe("isValidEnvironmentSlug / ENVIRONMENT_SLUG_PATTERN", () => {
  const valid = [
    "default",
    "production",
    "dev-1",
    "a",
    "1",
    "a-b-c",
    "ab--cd",
    "preview2",
  ];
  const invalid = [
    "-x",
    "x-",
    "Dev",
    "a_b",
    "",
    "-",
    "DEV",
    "has space",
    "café",
    "a.b",
  ];

  it.each(valid)("accepts %j", (slug) => {
    expect(isValidEnvironmentSlug(slug)).toBe(true);
    expect(ENVIRONMENT_SLUG_PATTERN.test(slug)).toBe(true);
  });

  it.each(invalid)("rejects %j", (slug) => {
    expect(isValidEnvironmentSlug(slug)).toBe(false);
    expect(ENVIRONMENT_SLUG_PATTERN.test(slug)).toBe(false);
  });

  it("the helper and the raw pattern agree", () => {
    for (const slug of [...valid, ...invalid]) {
      expect(isValidEnvironmentSlug(slug)).toBe(
        ENVIRONMENT_SLUG_PATTERN.test(slug),
      );
    }
  });
});
