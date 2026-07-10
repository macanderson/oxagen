import { redirect } from "next/navigation";
import { workspace } from "@/lib/routes";

/** Workbench root redirects to Agents — the section's front door (defaultTab map). */
export default async function WorkbenchPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  redirect(workspace.workbench.agents({ orgSlug, workspaceSlug }));
}
