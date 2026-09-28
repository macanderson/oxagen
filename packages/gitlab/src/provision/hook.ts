// hook.ts: register the steering hook on the GitLab steering project.
//
// The hook sends push and merge request events to Oxagen. A rerun lists the
// project's hooks first and finds the one whose url has the same path. It
// PUTs the current url, token and events onto that hook and creates no
// duplicate. Matching on the path means a new API origin moves the old hook
// instead of leaving it beside a second one. GitLab never returns a hook's
// token, so a rerun cannot compare it. The PUT is what heals a rotated secret.
//
// Member and project events exist only on group hooks, and a group hook needs
// the Owner role. The steering group token is a Maintainer, so a project hook
// is the one this step registers.
import { requireData, seg } from "./http";
import type { GitlabRest } from "./http";

interface HookBody {
  id: number;
  url: string;
}

/** The path of a hook's url, or null when GitLab holds a url that does not parse. */
function pathOf(url: string): string | null {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

/**
 * Register a project hook on the steering project that sends push and merge
 * request events to `url`, signed with `token`. A hook whose url has the same
 * path gets the current url, token and events. `created` says whether this
 * call made a new hook.
 */
export async function ensureSteeringHook(
  rest: GitlabRest,
  input: { project_id: number; url: string; token: string },
): Promise<{ hook_id: number; created: boolean }> {
  const root = `/projects/${seg(input.project_id)}/hooks`;
  const list = await rest.request<HookBody[]>("GET", `${root}?per_page=100`);
  const body = {
    url: input.url,
    token: input.token,
    push_events: true,
    merge_requests_events: true,
    enable_ssl_verification: true,
  };
  const path = pathOf(input.url);
  const existing = requireData(list, "hooks").find(
    (h) => h.url === input.url || (path !== null && pathOf(h.url) === path),
  );
  if (existing !== undefined) {
    await rest.request("PUT", `${root}/${seg(existing.id)}`, body);
    return { hook_id: existing.id, created: false };
  }
  const res = await rest.request<HookBody>("POST", root, body);
  return { hook_id: requireData(res, "hook").id, created: true };
}
