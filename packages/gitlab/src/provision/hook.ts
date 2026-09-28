// hook.ts: register the steering hook on the GitLab steering project.
//
// The hook sends push and merge request events to Oxagen. A rerun lists the
// project's hooks first and finds the one with the same url. It PUTs the
// current token and events onto that hook and creates no duplicate. GitLab
// never returns a hook's token, so a rerun cannot compare it. The PUT is what
// heals a rotated secret.
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

/**
 * Register a project hook on the steering project that sends push and merge
 * request events to `url`, signed with `token`. A hook that already holds
 * `url` gets the current token and events. `created` says whether this call
 * made a new hook.
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
  const existing = requireData(list, "hooks").find((h) => h.url === input.url);
  if (existing !== undefined) {
    await rest.request("PUT", `${root}/${seg(existing.id)}`, body);
    return { hook_id: existing.id, created: false };
  }
  const res = await rest.request<HookBody>("POST", root, body);
  return { hook_id: requireData(res, "hook").id, created: true };
}
