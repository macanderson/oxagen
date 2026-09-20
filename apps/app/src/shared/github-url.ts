// A page on github.com (ARCHITECTURE.md §3.8): the external target the
// Repositories page links to — the repository itself, the App's
// install page, and the page that changes which repositories the installation
// reaches. `get_main_repository` builds all three, and the install URL carries
// the API's HMAC-signed state as a query value, so unlike a PullRequestUrl a
// query is kept rather than refused.
//
// A GitHubUrl is an https URL whose host is github.com, with no credentials,
// no port and no fragment, written exactly as the URL parser writes it back.
// Any other value is not linked: a null install URL is a deployment with no
// GitHub App configured, and the dialog says so rather than rendering a dead
// control.

declare const gitHubUrl: unique symbol;
export type GitHubUrl = string & { readonly [gitHubUrl]: true };

const HOST = "github.com";

function isGitHubUrl(raw: string, url: URL): raw is GitHubUrl {
  return (
    url.protocol === "https:" &&
    url.hostname === HOST &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    url.hash === "" &&
    url.pathname.length > 1 &&
    url.href === raw
  );
}

export function parseGitHubUrl(raw: string | null): GitHubUrl | null {
  if (raw === null || !URL.canParse(raw)) return null;
  return isGitHubUrl(raw, new URL(raw)) ? raw : null;
}
