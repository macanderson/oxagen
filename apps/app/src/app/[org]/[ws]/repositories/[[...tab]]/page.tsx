import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { parseRepositoryTab, Repositories } from "@/features/repositories";
import { requireViewer } from "@/server/viewer";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages");
  return { title: t("repositories") };
}

// Repositories (MC spec §10.1, §10.2; mockup route `repositories[/<tab>]`):
// the four tabs are path segments on this one route, and a segment that names
// no tab is a 404 rather than a page that guesses. The page reads on demand
// through its own server actions, which resolve the viewer again (§3.3).
export default async function RepositoriesPage({
  params,
}: PageProps<"/[org]/[ws]/repositories/[[...tab]]">) {
  const { org, ws, tab: segments } = await params;
  const tab = parseRepositoryTab(segments);
  if (tab === null) notFound();
  const ctx = await requireViewer(org, ws);
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-10"
    >
      <Repositories
        org={org}
        ws={ws}
        wsName={ctx.wsName}
        tab={tab}
        roles={{ org: ctx.orgRole, workspace: ctx.wsRole }}
      />
    </main>
  );
}
