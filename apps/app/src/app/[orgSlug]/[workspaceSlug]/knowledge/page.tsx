import { redirect } from "next/navigation";
import { workspace } from "@/lib/routes";

export default async function KnowledgeRoot({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  redirect(workspace.knowledge.sources({ orgSlug, workspaceSlug }));
}
