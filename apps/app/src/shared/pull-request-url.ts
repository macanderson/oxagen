// A GitHub pull request page (ARCHITECTURE.md §3.8): the external target a
// Context PR links to (#2961). A PullRequestUrl is an https URL on github.com
// naming /<owner>/<repository>/pull/<number>, with no credentials, port, query
// or fragment, written exactly as the URL parser writes it back; any other
// value is not linked.

declare const pullRequestUrl: unique symbol;
export type PullRequestUrl = string & { readonly [pullRequestUrl]: true };

const HOST = "github.com";
const PATH = /^\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/pull\/[1-9][0-9]*$/;

function isPullRequestUrl(raw: string, url: URL): raw is PullRequestUrl {
  return (
    url.protocol === "https:" &&
    url.hostname === HOST &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    PATH.test(url.pathname) &&
    url.href === raw
  );
}

export function parsePullRequestUrl(raw: string): PullRequestUrl | null {
  if (!URL.canParse(raw)) return null;
  return isPullRequestUrl(raw, new URL(raw)) ? raw : null;
}
