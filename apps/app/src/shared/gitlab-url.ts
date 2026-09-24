// A project page on gitlab.com (ARCHITECTURE.md §3.8): the external target the
// Repositories page links a GitLab main project to (#3762). `get_main_repository`
// and `list_repositories` build it from the project path the binding recorded.
//
// A GitLabUrl is an https URL whose host is gitlab.com, with no credentials, no
// port, no query and no fragment, written exactly as the URL parser writes it
// back, naming a project under at least one group. Any other value is not
// linked. Self-managed GitLab is not supported, so no other host is linked.

declare const gitLabUrl: unique symbol;
export type GitLabUrl = string & { readonly [gitLabUrl]: true };

const HOST = "gitlab.com";
const PATH = /^\/[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*)+$/;

function isGitLabUrl(raw: string, url: URL): raw is GitLabUrl {
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

export function parseGitLabUrl(raw: string | null): GitLabUrl | null {
  if (raw === null || !URL.canParse(raw)) return null;
  return isGitLabUrl(raw, new URL(raw)) ? raw : null;
}
