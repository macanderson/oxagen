import { redirect } from "next/navigation";
import { workspace } from "@/lib/routes";

export default async function WorkspaceRoot({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  redirect(workspace.ask({ orgSlug, workspaceSlug }));
}
