import { redirect } from "next/navigation";
import { requestScopeSlugs } from "@/lib/request-path";
import { org as orgRoutes } from "@/lib/routes";

/**
 * Org root → org dashboard (`/{org}/dashboard`), the metering/usage home.
 *
 * The org slug is read from the request URL, NOT `params`: awaiting `params`
 * before `redirect()` regresses to a client meta-refresh under Cache Components
 * and 500s the shell. See lib/request-path.ts.
 *
 * The dashboard is the org home for every org — including one with zero
 * workspaces, which the dashboard renders as a first-run empty state (a
 * "create your first workspace" CTA) rather than bouncing to /new-workspace.
 * Redirecting unconditionally here avoids a DB round-trip and any redirect loop.
 */
export default async function OrgHome() {
  const { orgSlug } = await requestScopeSlugs();
  if (!orgSlug) redirect("/");
  redirect(orgRoutes.dashboard({ orgSlug }));
}
