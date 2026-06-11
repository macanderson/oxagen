import { redirect } from "next/navigation";
import { workspace } from "@/lib/routes";

export default async function StudioRoot({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  redirect(workspace.studio.compose({ orgSlug, workspaceSlug }));
}
