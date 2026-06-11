import { redirect } from "next/navigation";
import { workspace } from "@/lib/routes";

export const dynamic = "force-dynamic";

/**
 * Legacy `/chat` route — consolidated onto `/ask` (the canonical conversation
 * surface). This redirect preserves bookmarked / deep-linked conversation URLs
 * of the form `/{org}/{ws}/chat?c={id}` by forwarding them to the matching
 * `/{org}/{ws}/ask?c={id}`. New links are always written against `/ask`.
 */
export default async function ChatRedirectPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
  searchParams: Promise<{ c?: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  const { c } = await searchParams;
  const base = workspace.ask({ orgSlug, workspaceSlug });
  redirect(c ? `${base}?c=${encodeURIComponent(c)}` : base);
}
