import { describe, expect, it } from "vitest";
import authMessages from "../../../messages/auth.json";
import { authOutcomeKey, oauthQueryOutcome } from "./auth-errors";

describe("authOutcomeKey", () => {
  it.each([
    [{ code: "INVALID_EMAIL_OR_PASSWORD", status: 401 }, "wrongCredentials"],
    [{ code: "EMAIL_NOT_VERIFIED", status: 403 }, "emailNotVerified"],
    [
      { code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL", status: 422 },
      "alreadyRegistered",
    ],
    [{ code: "INVALID_CODE", status: 401 }, "codeWrong"],
    [{ code: "INVALID_BACKUP_CODE", status: 401 }, "codeWrong"],
    [{ body: { code: "INVALID_TOKEN" } }, "linkExpired"],
    [{ code: "BANNED_USER", status: 403 }, "suspended"],
    [{ status: 429 }, "rateLimited"],
    [{ status: 502, message: "Bad gateway" }, "unavailable"],
    [{ message: "invalid token" }, "linkExpired"],
    [{ code: "ACCESS_DENIED" }, "oauthCancelled"],
    [{ code: "please_restart_the_process" }, "oauthFailed"],
    [{ code: "ACCOUNT_NOT_LINKED" }, "oauthFailed"],
  ])("maps %j to %s", (err, key) => {
    expect(authOutcomeKey(err)).toBe(key);
  });

  it("does not guess at an unrecognised failure", () => {
    expect(authOutcomeKey({ code: "SOMETHING_NEW", status: 400 })).toBe(
      "unknown",
    );
    expect(authOutcomeKey(null)).toBe("unknown");
    expect(authOutcomeKey("boom")).toBe("unknown");
  });

  it("every outcome has catalog copy", () => {
    for (const key of [
      "wrongCredentials",
      "emailNotVerified",
      "suspended",
      "rateLimited",
      "alreadyRegistered",
      "codeWrong",
      "linkExpired",
      "oauthCancelled",
      "oauthFailed",
      "unavailable",
      "unknown",
    ]) {
      expect(authMessages.auth.outcomes).toHaveProperty(key);
    }
  });
});

describe("oauthQueryOutcome", () => {
  it("maps Better Auth / provider query codes", () => {
    expect(oauthQueryOutcome("access_denied")).toBe("oauthCancelled");
    expect(oauthQueryOutcome("please_restart_the_process")).toBe("oauthFailed");
  });

  it("returns null when the param is absent or blank", () => {
    expect(oauthQueryOutcome(undefined)).toBeNull();
    expect(oauthQueryOutcome(null)).toBeNull();
    expect(oauthQueryOutcome("")).toBeNull();
    expect(oauthQueryOutcome("   ")).toBeNull();
  });
});
