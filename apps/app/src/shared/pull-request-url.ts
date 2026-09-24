// A pull request page (ARCHITECTURE.md §3.8): the external target a Context PR
// links to (#2961). A PullRequestUrl is an https URL with no credentials, port,
// query or fragment, written exactly as the URL parser writes it back, naming
// either a GitHub pull request, /<owner>/<repository>/pull/<number> on
// github.com, or a GitLab merge request, /<group>/.../<project>/-/merge_requests/<iid>
// on gitlab.com (#3762). Any other value is not linked.

declare const pullRequestUrl: unique symbol;
export type PullRequestUrl = string & { readonly [pullRequestUrl]: true };

const PATH_BY_HOST: Readonly<Record<string, RegExp>> = {
  "github.com": /^\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/pull\/[1-9][0-9]*$/,
  "gitlab.com":
    /^\/[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*)+\/-\/merge_requests\/[1-9][0-9]*$/,
};

function isPullRequestUrl(raw: string, url: URL): raw is PullRequestUrl {
  const path = Object.hasOwn(PATH_BY_HOST, url.hostname)
    ? PATH_BY_HOST[url.hostname]
    : undefined;
  return (
    url.protocol === "https:" &&
    path !== undefined &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    path.test(url.pathname) &&
    url.href === raw
  );
}

export function parsePullRequestUrl(raw: string): PullRequestUrl | null {
  if (!URL.canParse(raw)) return null;
  return isPullRequestUrl(raw, new URL(raw)) ? raw : null;
}
