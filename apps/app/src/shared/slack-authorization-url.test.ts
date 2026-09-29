import { describe, expect, it } from "vitest";
import { parseSlackAuthorizationUrl } from "./slack-authorization-url";
const state = "a".repeat(43);
const good = `https://slack.com/oauth/v2/authorize?client_id=1234.5678&scope=chat:write,channels:read&state=${state}`;
describe("Slack authorization targets", () => {
  it("accepts only Slack's HTTPS OAuth v2 authorize route with a state", () => {
    expect(parseSlackAuthorizationUrl(good)).toBe(good);
  });
  it.each([
    good.replace("slack.com", "evil.example"),
    good.replace("slack.com", "slack.com.evil.example"),
    good.replace("slack.com", "app.slack.com"),
    good.replace("https:", "http:"),
    good.replace("/oauth/v2/authorize", "/oauth/authorize"),
    good.replace("slack.com", "user@slack.com"),
    good.replace("slack.com", "user:pass@slack.com"),
    good + "#fragment",
    good.replace(`&state=${state}`, ""),
    good.replace(state, "a".repeat(42)),
    good.replace(state, `${"a".repeat(42)}!`),
    good.replace("https://slack.com", "https://SLACK.com"),
    "/oauth/v2/authorize?state=" + state,
    "not a url",
  ])("refuses %s", (value) => {
    expect(parseSlackAuthorizationUrl(value)).toBeNull();
  });
});
