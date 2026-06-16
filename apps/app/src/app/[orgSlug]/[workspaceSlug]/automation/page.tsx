import { redirect } from "next/navigation";
import { workspace } from "@/lib/routes";

export default async function AutomationRoot({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  redirect(workspace.automation.playbooks({ orgSlug, workspaceSlug }));
}
