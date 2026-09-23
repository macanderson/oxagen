declare const linearAuthorizationUrl: unique symbol;
export type LinearAuthorizationUrl = string & {
  readonly [linearAuthorizationUrl]: true;
};
function isLinearAuthorizationUrl(
  raw: string,
  url: URL,
): raw is LinearAuthorizationUrl {
  return (
    url.origin === "https://linear.app" &&
    url.pathname === "/oauth/authorize" &&
    !url.username &&
    !url.password &&
    !url.hash &&
    url.href === raw &&
    url.searchParams.get("code_challenge_method") === "S256" &&
    /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("state") ?? "")
  );
}
export function parseLinearAuthorizationUrl(
  raw: string,
): LinearAuthorizationUrl | null {
  return URL.canParse(raw) && isLinearAuthorizationUrl(raw, new URL(raw))
    ? raw
    : null;
}
