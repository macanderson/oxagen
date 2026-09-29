// The one Slack page `start_slack_connection` may send a browser to: Slack's
// OAuth v2 authorize route over HTTPS, with no credentials or fragment, in the
// exact form it was issued, carrying a `state` the callback can check
// (ARCHITECTURE.md §3.8, INV-13).
declare const slackAuthorizationUrl: unique symbol;
export type SlackAuthorizationUrl = string & {
  readonly [slackAuthorizationUrl]: true;
};
function isSlackAuthorizationUrl(
  raw: string,
  url: URL,
): raw is SlackAuthorizationUrl {
  return (
    url.origin === "https://slack.com" &&
    url.pathname === "/oauth/v2/authorize" &&
    !url.username &&
    !url.password &&
    !url.hash &&
    url.href === raw &&
    /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("state") ?? "")
  );
}
export function parseSlackAuthorizationUrl(
  raw: string,
): SlackAuthorizationUrl | null {
  return URL.canParse(raw) && isSlackAuthorizationUrl(raw, new URL(raw))
    ? raw
    : null;
}
