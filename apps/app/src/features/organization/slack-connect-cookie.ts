// The cookie that carries a Slack connection attempt from Connect Slack to the
// OAuth callback (#4608): the organization and the `state` Slack must echo
// back. It is scoped to the callback's path, lives ten minutes like the state
// itself, and the callback deletes it on its first read. A "use server" module
// may export only async functions (INV-19), so the start action and the
// callback share its name and path from here.
export const SLACK_CONNECT_COOKIE = {
  name: "oxagen_slack_connect",
  path: "/api/slack/oauth/callback",
} as const;

/** How long the cookie lives, in seconds: the ten minutes the state lasts. */
export const SLACK_CONNECT_MAX_AGE = 600;
