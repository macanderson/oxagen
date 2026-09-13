/**
 * api-error.test.ts — apiErrorMessage reads both API error shapes.
 */

import { describe, it, expect } from "vitest";
import { apiErrorMessage } from "./api-error";

describe("apiErrorMessage", () => {
  it("reads a route-level string error", () => {
    expect(
      apiErrorMessage({ error: "GitHub App is not configured" }, "x"),
    ).toBe("GitHub App is not configured");
  });

  it("reads the error middleware envelope and appends the request id", () => {
    expect(
      apiErrorMessage(
        {
          error: { code: "internal_error", message: "Unexpected server error" },
          requestId: "82105b3f-8b80-4ecf-8839-678e174a64e8",
        },
        "x",
      ),
    ).toBe(
      "Unexpected server error (request 82105b3f-8b80-4ecf-8839-678e174a64e8)",
    );
  });

  it("never yields [object Object] for an envelope with no message", () => {
    const text = apiErrorMessage(
      { error: { code: "internal_error" } },
      "fallback",
    );
    expect(text).toBe("fallback");
    expect(text).not.toContain("[object Object]");
  });

  it("falls back for a null, non-object, or empty body", () => {
    expect(apiErrorMessage(null, "fallback")).toBe("fallback");
    expect(apiErrorMessage("oops", "fallback")).toBe("fallback");
    expect(apiErrorMessage({}, "fallback")).toBe("fallback");
    expect(apiErrorMessage({ error: "   " }, "fallback")).toBe("fallback");
  });
});
