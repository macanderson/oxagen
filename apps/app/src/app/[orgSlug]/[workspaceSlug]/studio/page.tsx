import { redirect } from "next/navigation";
import { workspace } from "@/lib/routes";

/** Studio root redirects to the first tab (Agents), per the defaultTab map. */
export default async function StudioPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  redirect(workspace.studio.agents({ orgSlug, workspaceSlug }));
}
