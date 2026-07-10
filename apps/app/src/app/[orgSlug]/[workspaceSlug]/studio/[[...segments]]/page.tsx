import { redirect } from "next/navigation";

/**
 * The Studio section was renamed to Workbench. This catch-all preserves old
 * /studio/* links and bookmarks by redirecting 1:1 onto /workbench/* — the
 * route tree underneath is unchanged (agents, tools, sandboxes, …).
 */
export default async function StudioToWorkbenchRedirect({
  params,
}: {
  params: Promise<{
    orgSlug: string;
    workspaceSlug: string;
    segments?: string[];
  }>;
}) {
  const { orgSlug, workspaceSlug, segments } = await params;
  const rest = (segments ?? []).map(encodeURIComponent).join("/");
  redirect(
    `/${orgSlug}/${workspaceSlug}/workbench${rest ? `/${rest}` : ""}`,
  );
}
