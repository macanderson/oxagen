// GitHub App "Setup URL" landing (/github/setup): a callback, not a page. GitHub
// sends the browser here after someone installs or configures the app, with
// `installation_id` and `setup_action` but no signed state, so the request
// names no workspace and nothing is read from it (ARCHITECTURE.md §3.7). A
// signed-out visitor logs in and comes back with the query intact; a signed-in
// one lands on `/`.
import { responseRedirect } from "@/shared/navigation";
import { routes, sanitizeNext } from "@/shared/safe-path";

export type GithubSetupDeps = {
  getAuthUser: () => Promise<{ id: string } | null>;
};

export async function handleGithubSetup(
  request: Request,
  deps: GithubSetupDeps,
): Promise<Response> {
  if ((await deps.getAuthUser()) !== null)
    return responseRedirect(request, routes.root());
  const { pathname, search } = new URL(request.url);
  const here = sanitizeNext(`${pathname}${search}`, routes.root());
  return responseRedirect(request, routes.login(here));
}
