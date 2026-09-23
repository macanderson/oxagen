import { describe, expect, it } from "vitest";
import { parseLinearAuthorizationUrl } from "./linear-authorization-url";
const good = `https://linear.app/oauth/authorize?state=${"a".repeat(43)}&code_challenge_method=S256`;
describe("Linear authorization targets", () => {
  it("accepts only the expected HTTPS provider authorization route", () => {
    expect(parseLinearAuthorizationUrl(good)).toBe(good);
  });
  it.each([
    good.replace("linear.app", "evil.example"),
    good.replace("https:", "http:"),
    good.replace("/oauth/authorize", "/other"),
    good.replace("linear.app", "user@linear.app"),
    good + "#fragment",
    good.replace("S256", "plain"),
  ])("refuses %s", (value) => {
    expect(parseLinearAuthorizationUrl(value)).toBeNull();
  });
});
