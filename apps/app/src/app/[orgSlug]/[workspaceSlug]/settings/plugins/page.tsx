import { redirect } from "next/navigation";
import { workspace } from "@/lib/routes";

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

/**
 * Settings → Plugins has been promoted to a first-class Marketplace surface
 * (Browse / Installed / MCP Servers tabs). This route now redirects to the
 * Marketplace root, which itself redirects to the first tab (Browse) — see
 * marketplace/layout.tsx, marketplace/page.tsx, and the `defaultTab` map in
 * @/lib/routes.
 */
export default async function WorkspacePluginsRedirectPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug } = await params;
  redirect(workspace.marketplace.root({ orgSlug, workspaceSlug }));
}
