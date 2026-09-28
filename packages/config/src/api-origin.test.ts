import { describe, expect, it } from "vitest";
import { apiPublicOrigin } from "./api-origin";

const PRODUCTION = "https://api.oxagen.sh";

describe("apiPublicOrigin", () => {
  it("reads NEXT_PUBLIC_API_URL, the variable every service sets", () => {
    expect(
      apiPublicOrigin({ NEXT_PUBLIC_API_URL: "https://api.staging.example.test" }),
    ).toBe("https://api.staging.example.test");
  });

  it("prefers NEXT_PUBLIC_API_URL over the CLI's OXAGEN_API_URL", () => {
    expect(
      apiPublicOrigin({
        NEXT_PUBLIC_API_URL: "https://api.custom.example.test",
        OXAGEN_API_URL: "https://api.oxagen.sh",
      }),
    ).toBe("https://api.custom.example.test");
  });

  it("falls back to OXAGEN_API_URL when NEXT_PUBLIC_API_URL is unset", () => {
    expect(apiPublicOrigin({ OXAGEN_API_URL: "http://localhost:4000" })).toBe(
      "http://localhost:4000",
    );
  });

  it("drops a path and trailing slashes", () => {
    expect(
      apiPublicOrigin({ NEXT_PUBLIC_API_URL: "https://api.example.test/v1//" }),
    ).toBe("https://api.example.test");
  });

  it("skips a value that is not a URL", () => {
    expect(
      apiPublicOrigin({
        NEXT_PUBLIC_API_URL: "api.example.test",
        OXAGEN_API_URL: "https://api.fallback.example.test",
      }),
    ).toBe("https://api.fallback.example.test");
  });

  it("answers the production origin when nothing is set", () => {
    expect(apiPublicOrigin({})).toBe(PRODUCTION);
    expect(apiPublicOrigin({ NEXT_PUBLIC_API_URL: "  " })).toBe(PRODUCTION);
  });
});
